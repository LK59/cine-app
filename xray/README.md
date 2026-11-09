# laterna-xray

**Qui est à l'écran, scène par scène.**

`laterna-xray` est un service d'appoint pour Laterna. Pour un film ou un épisode, il repère les
visages, les regroupe par personne et les nomme d'après la distribution — si bien que Laterna
peut afficher, pendant la lecture, les acteurs présents dans la scène en cours, avec leur rôle.

Il tourne à côté de Jellyfin, lit la médiathèque en lecture seule, décode sur l'iGPU Intel quand
il y en a un, calcule sur le processeur, et ne parle qu'à Laterna, par un réseau Docker interne.

---

## Sommaire

- [Ce qu'il fait](#ce-quil-fait)
- [Comment ça marche](#comment-ça-marche)
- [Installation](#installation)
- [Brancher Laterna](#brancher-laterna)
- [Modèles et licences](#modèles-et-licences)
- [Accélération matérielle](#accélération-matérielle)
- [Performances](#performances)
- [Réglages](#réglages)
- [Calibrage](#calibrage)
- [Limites connues](#limites-connues)
- [Référence de l'API](#référence-de-lapi)
- [Développement](#développement)

---

## Ce qu'il fait

Laterna lui envoie un ordre : *ce fichier, avec cette distribution* (les acteurs de l'épisode,
invités compris, et quelques photos de chacun prises sur TMDB). Le service rend une liste de
scènes ; pour chacune, les personnes reconnues, triées par temps de présence, avec un indice
de confiance.

```
720,0 – 765,3 s   Acteur A  18,8 s  (0,99)   Actrice B  15,0 s  (0,98)   Acteur C  7,5 s  (0,99)
765,3 – 840,0 s   Acteur A  22,3 s  (0,99)   Actrice D  12,0 s  (0,99)
```

Trois principes :

- **Personne n'est nommé au hasard.** Un visage n'est comparé qu'aux acteurs de la distribution
  fournie, et seulement s'il leur ressemble nettement. Sinon il reste anonyme — et un anonyme
  n'est jamais renvoyé.
- **Ce qu'on regarde passe d'abord.** Si quelqu'un lance l'épisode à la 25ᵉ minute, l'analyse
  commence là, avance jusqu'à la fin, puis revient au début. Les scènes arrivent au fil de
  l'analyse : un résultat partiel est lisible à tout moment.
- **Le service passe après tout le reste.** Une analyse à la fois, à priorité basse, avec un
  nombre de fils borné ; et si Jellyfin transcode sur l'iGPU, le service lui laisse la place.

---

## Comment ça marche

```
 fichier vidéo (médiathèque, lecture seule)
        │
        ▼
 ┌──────────────────────┐   VA-API sur l'iGPU (H.264, HEVC, VP9…), processeur sinon (AV1…)
 │ 1. décodage réduit   │   640 px de large, 4 images par seconde, par tronçons de 2 minutes
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐   rupture d'histogramme de couleurs (+ changement de l'image)
 │ 2. plans             │   → un plan va d'une coupe à la suivante
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐   2 à 6 images par plan : détection des visages, alignement,
 │ 3. pistes            │   empreinte ; un même visage suivi d'image en image (recouvrement,
 └──────────┬───────────┘   ressemblance) ; une empreinte moyenne par piste
            ▼
 ┌──────────────────────┐   regroupement hiérarchique de toutes les pistes de l'épisode
 │ 4. personnes         │   → un groupe par personne
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐   comparaison aux photos de la distribution (et aux visages déjà
 │ 5. noms              │   nommés dans la série), attribution un à un, seuil de rejet
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐   plans voisins de même décor ou mêmes personnes → une scène ;
 │ 6. scènes            │   par scène : qui, combien de temps, avec quelle confiance
 └──────────────────────┘
```

### 1. Décodage

Le fichier est lu par tronçons de deux minutes. Chaque tronçon est décodé par ffmpeg (la
version que livre Jellyfin, avec son pilote Intel), réduit à 640 px de large et échantillonné à
quatre images par seconde. Sur l'iGPU, la réduction se fait sur la carte et seules les petites
images reviennent en mémoire. Un fichier HDR (PQ ou HLG, Dolby Vision à couche HDR10 compris) est
adapté en SDR *après* la réduction, sur le processeur (`tonemapx`, livré avec jellyfin-ffmpeg) :
quatre petites images par seconde ne coûtent presque rien. Lu sans adaptation, le signal HDR
donne une image délavée aux couleurs tassées, et des coupes passent inaperçues (voir
[Calibrage](#calibrage)).

Le tronçon est l'unité de travail : une fois analysé, il est écrit en base d'un seul bloc. Un
redémarrage reprend au premier tronçon non fait.

### 2. Plans

Entre deux images successives, on compare les histogrammes de couleurs (luminance et
chrominance). Une coupe change d'un coup les couleurs de l'image ; un mouvement de caméra
déplace l'image sans les changer. Quand l'écart est moyen, une vignette de 32×18 départage —
brute, et à contraste égal (centrée, réduite) : dans un décor sombre d'une seule teinte, un
champ-contrechamp change peu les couleurs et la luminance, mais pas la forme de l'image.
Couper trop souvent ne coûte presque rien (les morceaux se recollent plus loin) ; les seuils
penchent donc vers la coupe.

### 3. Pistes

Dans chaque plan, deux ou trois images sont analysées (davantage pour un plan long : une de plus
toutes les dix secondes, six au plus). Sur chacune :

- **détection** des visages et de cinq points (yeux, nez, coins de la bouche) ;
- **tri** : un visage trop petit (moins de 36 px), flou, ou de profil marqué compte comme une
  présence, mais ne sert pas à identifier ;
- **alignement** des bons visages sur un gabarit de 112×112 px, puis **empreinte** : un vecteur
  de 512 nombres, proche pour deux photos d'une même personne.

D'une image à l'autre du plan, les visages sont reliés en *pistes* — par le recouvrement de leurs
cadres, ou par la ressemblance de leurs empreintes quand le visage a bougé. Chaque piste reçoit
une seule empreinte, moyenne de ses visages pondérée par leur qualité, et un temps de présence :
la durée du plan multipliée par la part des images où elle apparaît.

### 4. Personnes

Toutes les pistes vues jusqu'ici sont regroupées par classification hiérarchique (lien moyen,
distance cosinus, coupée à un seuil) : deux groupes fusionnent tant que leurs pistes se
ressemblent *en moyenne*. Il n'est pas nécessaire de connaître le nombre de personnes à l'avance.
Le regroupement est refait à chaque tronçon : plus il voit de pistes, meilleur il est.

### 5. Noms

Chaque groupe est comparé à chaque acteur de la distribution fournie :

- les photos de référence (plusieurs par acteur, de TMDB) sont téléchargées une fois, leur
  visage détecté et leur empreinte gardée en base ;
- la note d'un couple groupe × acteur est la moyenne de ses trois meilleures similarités avec
  les photos de l'acteur — une photo ratée ne compte pas, une seule photo flatteuse ne suffit pas ;
- pour une série (`seriesId`), les visages nommés avec assurance dans les épisodes précédents
  servent aussi de référence : ils ressemblent davantage à l'image de la série qu'un portrait
  posé. Seuls des groupes que les *photos* ont nommés y entrent : la mémoire ne se nourrit pas
  de ses propres conclusions ;
- trois **bandes de note**, relatives au seuil de rejet *T* (0,30 pour `buffalo_l`) : à partir de
  *T* + 0,10, le nom est sûr ; de *T* + 0,045 à *T* + 0,10, il n'est donné que si le deuxième
  acteur le plus ressemblant est à 0,15 au moins derrière *et* si le groupe a été vu 2 s ou sur
  2 pistes ; en dessous, le groupe reste anonyme ;
- l'**algorithme hongrois** attribue au plus un groupe par acteur parmi ces couples
  acceptables, en maximisant la somme des notes ;
- un acteur filmé sous deux jours très différents peut former deux groupes : le second rejoint
  le premier s'il ressemble nettement à l'acteur *et* au groupe déjà nommé, ou s'il tombe dans
  la bande « à confirmer » et en remplit les conditions ; jamais s'il a été vu moins d'une
  seconde.

La confiance renvoyée vaut 0,5 au seuil et approche 1 quand la ressemblance le dépasse
nettement. Les chiffres qui fixent ces bandes sont dans [Calibrage](#calibrage).

### 6. Scènes

Un plan rejoint la scène en cours s'il ressemble par ses couleurs à l'un de ses quatre derniers
plans — un dialogue filmé en champ-contrechamp alterne A, B, A, B — ou s'il montre quelqu'un
qu'on vient d'y voir dans un décor encore voisin. Une scène de moins de dix secondes est fondue
dans sa voisine la plus proche. Une scène de plus de trois minutes est recoupée à sa frontière de
plans la plus faible (couleurs les moins semblables, de préférence là où les personnes changent du
tout au tout), sans laisser de morceau de moins de 30 s : un décor uniforme — des urgences toutes
en bleu-vert — enchaînait sinon des scènes de douze minutes. Pour chaque scène, les personnes
nommées sont triées par temps de présence.

---

## Installation

Il faut Docker, le réseau Docker où vit Laterna (ici `media_net`), et la médiathèque.

1. Récupérer [`docker-compose.example.yml`](docker-compose.example.yml) et le copier en
   `docker-compose.yml` dans un dossier à part.
2. À côté, créer un fichier `.env` :

   ```sh
   XRAY_API_KEY=<clé partagée>              # openssl rand -hex 32
   JELLYFIN_URL=http://jellyfin:8096         # facultatif
   JELLYFIN_API_KEY=<clé d'API Jellyfin>     # facultatif
   ```

   La clé partagée est le seul secret : Laterna présente la même. `JELLYFIN_URL` et
   `JELLYFIN_API_KEY` ne servent qu'à laisser l'iGPU à Jellyfin quand il transcode
   (voir [Accélération matérielle](#accélération-matérielle)).

3. Adapter dans `docker-compose.yml` :
   - le **chemin de la médiathèque**, monté en lecture seule **au même chemin que dans le
     conteneur Jellyfin** (si Jellyfin voit `/media/tv/…`, le service doit voir `/media/tv/…`) :
     Laterna transmet les chemins tels que Jellyfin les connaît ;
   - l'**utilisateur** (`user: "UID:GID"`) qui possède les fichiers de la médiathèque, le même
     que celui de Jellyfin ou de Sonarr/Radarr (souvent `PUID`/`PGID`). Sous un autre utilisateur,
     un dossier en `770` paraît vide au service, et l'analyse échoue sur « fichier introuvable » —
     c'est courant avec une fusion de disques (mergerfs) dont certains disques sont plus fermés ;
   - le **numéro du groupe `render`** de l'hôte (`getent group render`), qui donne accès à
     `/dev/dri/renderD128`. Sans iGPU, retirer `devices` et `group_add`.

4. Démarrer :

   ```sh
   docker compose up -d
   docker logs -f laterna-xray     # « modèles : buffalo_l prêt » au bout d'une minute environ
   ```

Le service n'ouvre aucun port sur l'hôte : seul un conteneur du même réseau Docker l'atteint, à
l'adresse `http://laterna-xray:8000`. Il tourne sous un utilisateur sans privilège : l'uid 10001 de l'image par défaut, ou celui
choisi par `user:` ; ses données (base, poids des modèles, photos de référence) vivent dans le
volume `xray_data`, qui doit appartenir à cet utilisateur (après un changement de `user:`, un
`chown -R UID:GID` du volume, fait une fois depuis un conteneur lancé en root). Pour un dossier de
l'hôte à la place du volume, le rendre accessible en écriture au même utilisateur.

Pour construire l'image soi-même plutôt que de la tirer :

```sh
docker build -t laterna-xray:local xray/      # les tests tournent pendant la construction
```

---

## Brancher Laterna

Dans Laterna, **Configuration → Connexions**, carte « Acteurs à l'écran » :

1. activer l'option ;
2. adresse du service : `http://laterna-xray:8000` ;
3. clé : la valeur de `XRAY_API_KEY`.

Laterna vérifie la connexion par `/health` et indique si le modèle est prêt. Il envoie ensuite
les ordres d'analyse lui-même — en priorité haute quand quelqu'un regarde, à partir de la
position de lecture — et lit les scènes au fil de la lecture.

---

## Modèles et licences

Le code du service est sous la licence du dépôt. **Les poids des modèles ne sont ni dans le
dépôt ni dans l'image** : le conteneur les télécharge à son premier démarrage, depuis leur
publication officielle, dans le volume de données. Chaque fichier est comparé à une empreinte
SHA-256 inscrite dans le code ([`app/models.py`](app/models.py)) :

- un fichier déjà présent n'est jamais retéléchargé ;
- un fichier présent qui ne correspond pas est refusé (le service le dit dans `/health` ; le
  supprimer pour qu'il soit repris) ;
- un téléchargement n'est gardé qu'une fois vérifié.

| `XRAY_MODEL` | Détecteur | Empreinte | Licence des poids |
|---|---|---|---|
| `buffalo_l` *(défaut)* | SCRFD-10G | ArcFace R50 (WebFace600K) | **usage non commercial** |
| `auraface` | YuNet (OpenCV) | AuraFace v1 (`glintr100.onnx`) | MIT + **Apache-2.0** |

**`buffalo_l` est réservé à un usage non commercial.** Ce sont les modèles d'InsightFace, les
plus précis des deux ; leurs poids sont publiés pour la recherche et l'usage non commercial.
C'est à l'installateur de décider s'il peut s'en servir : le conteneur les télécharge chez lui,
à sa demande, comme le fait par exemple le service d'apprentissage d'Immich. Seuls deux fichiers
sont gardés (`det_10g.onnx`, `w600k_r50.onnx`) ; l'archive est effacée.

**`auraface` est libre**, utilisable dans tous les cas. Pour basculer :

```yaml
    environment:
      XRAY_MODEL: auraface
```

puis `docker compose up -d`. Les résultats déjà calculés restent lisibles (ils indiquent le
modèle qui les a produits) ; les photos de référence sont réanalysées avec le nouveau modèle.

`/health` indique toujours le modèle utilisé, s'il est prêt, et sa licence.

---

## Accélération matérielle

**Décodage sur l'iGPU Intel (VA-API).** L'image embarque `jellyfin-ffmpeg` et son pilote iHD :
rien à installer sur l'hôte. Sur un Coffee Lake (UHD 630), l'iGPU décode H.264, HEVC Main et
Main 10, VP9, VP8, MPEG-2 et VC-1 ; **pas l'AV1** (arrivé avec Tiger Lake), ni le H.264 10 bits,
ni le HEVC 4:2:2/4:4:4. Ces fichiers sont décodés sur le processeur, comme tout le reste si le
périphérique est absent ou si VA-API échoue sur un tronçon (le tronçon est alors repris sur le
processeur). `/health` indique si VA-API fonctionne (`decode.vaapi`).

**Jellyfin garde la priorité.** Avec `JELLYFIN_URL` et `JELLYFIN_API_KEY`, le service consulte
les sessions de Jellyfin avant chaque ordre et toutes les 30 secondes : si l'une d'elles
transcode avec l'accélération matérielle, le tronçon suivant est décodé sur le processeur.

**L'inférence se fait sur le processeur** (ONNX Runtime). Le pilote de calcul des iGPU Gen9 n'est
plus qu'en maintenance, et l'iGPU a déjà fort à faire avec le décodage.

**Le service se fait discret** : une analyse à la fois ; `nice 10` et `ionice` en classe basse
pour lui et le ffmpeg qu'il lance ; `XRAY_THREADS` fils de calcul (4 par défaut) ; et, dans
l'exemple de composition, `cpus: 4` et `mem_limit: 4g`.

---

## Performances

Mesuré sur un Core i7 de 8ᵉ génération (6 cœurs, UHD 630), `XRAY_THREADS=4`, `buffalo_l`, un
épisode HEVC 1080p — **pendant qu'un réencodage HEVC occupait déjà l'iGPU et une partie du
processeur** :

| Étape | Mesure |
|---|---|
| Décodage réduit, VA-API | 640 images source/s, **27× le temps réel** |
| Décodage réduit, processeur | 230 images source/s, **10× le temps réel** |
| Détection (SCRFD-10G, 640×360) | ~100 à 125 ms par image analysée |
| Empreinte (ArcFace R50) | ~115 à 170 ms par visage |
| Un tronçon de 2 min | ~24 s (≈ 90 plans, 200 images analysées, 120 visages) |
| Un épisode de 42 min | ≈ 9 min |

Le premier tronçon (celui de `startAt`) est prêt une trentaine de secondes après l'ordre. Sur
une machine au repos, les temps d'inférence sont nettement plus courts.

Un épisode occupe environ un mégaoctet en base (une empreinte par piste). Les poids de `buffalo_l` font
180 Mo, ceux d'`auraface` 260 Mo.

---

## Réglages

Variables d'environnement (toutes facultatives sauf la clé) :

| Variable | Défaut | Rôle |
|---|---|---|
| `XRAY_API_KEY` | — | Clé partagée avec Laterna. **Vide : toutes les requêtes sont refusées.** |
| `XRAY_MODEL` | `buffalo_l` | `buffalo_l` ou `auraface` (voir plus haut). |
| `XRAY_THREADS` | `4` | Fils de calcul (inférence, décodage sur processeur). |
| `JELLYFIN_URL` | — | Adresse de Jellyfin, pour lui laisser l'iGPU. |
| `JELLYFIN_API_KEY` | — | Clé d'API Jellyfin (en-tête `Authorization: MediaBrowser Token="…"`). |
| `XRAY_HWACCEL` | `1` | `0` : jamais de VA-API. |
| `XRAY_VAAPI_DEVICE` | `/dev/dri/renderD128` | Périphérique VA-API. |
| `XRAY_MEDIA_ROOT` | `/media` | Racine de la médiathèque montée ; tout chemin hors d'elle est refusé. |
| `XRAY_DATA_DIR` | `/data` | Base, modèles, photos. |
| `XRAY_SAMPLE_FPS` | `4` | Images échantillonnées par seconde. |
| `XRAY_CHUNK_SECONDS` | `120` | Longueur d'un tronçon. |
| `XRAY_MIN_FACE` | `36` | Plus petit visage identifiable, en pixels (image de 640 px). |
| `XRAY_CLUSTER_THRESHOLD` | selon le modèle | Similarité pour regrouper deux pistes (0,42 / 0,40). |
| `XRAY_LABEL_THRESHOLD` | selon le modèle | Seuil de rejet d'un nom (0,30 / 0,28). |

---

## Calibrage

Mesuré le 09/11/2026 sur trois titres, `buffalo_l` : *MacGyver* (2016) S01E06 (HEVC 1080p SDR),
*The Pitt* S02E01 (HEVC 1080p SDR), *Bullet Train* (2022, HEVC 4K HDR10), puis *Ted Lasso*
S01E10 (HEVC 4K Dolby Vision / HDR10). Les groupes douteux ont été jugés sur planches d'images.

**Noms.** Version 1 : seuil 0,30 en première passe, 0,40 en seconde passe. Dans chaque cas
jugeable entre 0,345 et 0,40, le groupe resté anonyme était bien l'acteur — couché (0,37), masqué
(0,386), sous chapeau et lunettes (0,349), de dos à demi (0,386) — et le deuxième acteur le plus
ressemblant n'y dépassait jamais 0,25 (écart de 0,17 à 0,30). Les noms donnés sous 0,345 ne
tenaient pas : 0,31 pour une seconde d'image, 0,33 sur 12 s ; ni un quatrième groupe d'un même
acteur vu une demi-seconde. Recalcul hors ligne des mêmes pistes (version 1 → 3) :

| Titre | Groupes nommés | Personnes | Temps nommé | Changements |
|---|---|---|---|---|
| MacGyver S01E06 | 9 → 9 | 9 → 8 | 1 507 → 1 508 s | + un groupe d'un acteur couché ; − un invité à 0,31 (1 s) |
| The Pitt S02E01 | 35 → 38 | 34 → 34 | 2 273 → 2 318 s | + deux actrices (masquée, de profil, 19 s et 22 s), + un second groupe |
| Bullet Train | 33 → 40 | 25 → 24 | 3 754 → 3 803 s | + 8 groupes d'acteurs déjà nommés ; − un nom à 0,33, − une demi-seconde |

**Scènes.** Version 1 sans durée maximale : *The Pitt* avait des scènes de 775 s et 703 s (trois
au-delà de 300 s). Recalcul sur les mêmes plans :

| Titre | Scènes | Médiane | 90ᵉ centile | Plus longue |
|---|---|---|---|---|
| MacGyver S01E06 | 46 → 47 | 36,8 → 37,2 s | 124 → 124 s | 200 → 160 s |
| The Pitt S02E01 | 21 → 40 | 61 → 79 s | 394 → 136 s | 775 → 178 s |
| Bullet Train | 104 → 122 | 42 → 44 s | 145 → 143 s | 515 → 170 s |

**Coupes.** Comptées sur des extraits de cinq minutes, décodés comme en production (VA-API) :

| Extrait (5 min) | v1, sans adaptation | adapté seulement | v3 (adapté + contraste égal) | Plan médian v1 → v3 | 90ᵉ centile v1 → v3 |
|---|---|---|---|---|---|
| Bullet Train, 20ᵉ min (HDR10) | 22 | 36 | 79 | 6,0 → 2,5 s | 31,3 → 8,3 s |
| Ted Lasso S01E10, 2ᵉ min (Dolby Vision / HDR10) | 11 | 12 | 98 | 7,8 → 2,3 s | 67,1 → 5,6 s |
| The Pitt S02E01, 15ᵉ min (SDR) | 56 | — | 85 | 2,8 → 2,3 s | 11,5 → 6,9 s |
| MacGyver S01E06, 10ᵉ min (SDR) | 108 | — | 128 | 2,3 → 2,0 s | 5,8 → 4,8 s |

L'adaptation seule ne suffit pas : dans le bureau sombre de *Ted Lasso*, un champ-contrechamp
change les couleurs de 0,10 à 0,27 et la luminance brute de 0,05 à 0,12 — sous les seuils
d'origine —, mais à contraste égal ces coupes s'écartent de 0,65 à 1,0, quand deux images d'un
même plan ne dépassent pas 0,49 dans ce décor. Un épisode y était découpé en un plan par
tronçon de deux minutes. Couper un peu plus souvent ailleurs (MacGyver, +18 %) ne coûte presque
rien : les morceaux se recollent en scènes.

`tonemap_vaapi` fonctionne sur l'UHD 630, mais rend une image trois fois plus sombre que la source
(luminance moyenne 14 contre 35 pour `tonemapx` sur la même image) : la carte décode et réduit, le
processeur adapte.

---

## Limites connues

- **Un visage doit être vu de face, net et assez grand.** Un personnage filmé de dos, de profil,
  dans l'ombre ou de loin compte pour rien : son temps de présence est sous-estimé, et une scène
  où il n'est jamais vu de face ne le cite pas.
- **Seule la distribution fournie peut être nommée.** Un acteur absent de la liste envoyée par
  Laterna (figurant non crédité, crédit incomplet sur TMDB) reste anonyme — c'est voulu.
- **Les photos de TMDB font la qualité.** Un acteur avec une seule photo ancienne, ou des photos
  très retouchées, est moins bien reconnu ; un rôle lourdement maquillé, ou joué à un tout autre
  âge, peut ne pas l'être du tout.
- **Deux personnes à l'écran dans le même plan peuvent, en théorie, finir dans un même groupe** :
  le regroupement ne tient pas compte du fait qu'elles apparaissent ensemble.
- **Les scènes sont approchées.** Le découpage repose sur les couleurs et les personnes, pas sur
  le récit : une scène tournée dans deux décors très différents peut être coupée en deux, et
  deux scènes du même décor qui se suivent peuvent n'en faire qu'une.
- **Le HDR est adapté par `tonemapx`**, propre à jellyfin-ffmpeg. Avec un autre ffmpeg, il est
  analysé sans adaptation (le journal le dit) : moins de coupes trouvées, des scènes plus longues.
- **Le résultat dépend du fichier** : il est lié à son `etag`, et un fichier remplacé doit être
  réanalysé.

---

## Référence de l'API

Base : `http://laterna-xray:8000`. Toute requête — `/health` compris — porte
`Authorization: Bearer <XRAY_API_KEY>` ; sans clé valide, la réponse est `401`. JSON UTF-8
partout ; temps en secondes (trois décimales). Une erreur répond `{"error": "…"}`.

### `GET /health`

```json
{
  "ok": true,
  "version": "1.0.0",
  "model": { "name": "buffalo_l", "ready": true, "license": "non-commercial", "error": null },
  "decode": { "vaapi": true, "device": "/dev/dri/renderD128" },
  "queue": { "pending": 0, "running": null }
}
```

`ready` vaut `false` tant que les poids se téléchargent ; `error` dit pourquoi ils ne sont pas
prêts (réseau, empreinte qui ne correspond pas). `running` est l'`itemId` en cours d'analyse.

### `POST /jobs`

```json
{
  "itemId": "0123456789abcdef0123456789abcdef",
  "path": "/media/tv/Série/Saison 1/Série - S01E06.mkv",
  "etag": "…",
  "priority": "high",
  "startAt": 1500,
  "seriesId": "fedcba9876543210fedcba9876543210",
  "cast": [
    { "personId": 12345, "name": "…", "character": "…", "order": 0,
      "photos": ["https://image.tmdb.org/t/p/w185/….jpg"] }
  ]
}
```

| Champ | |
|---|---|
| `itemId` | identifiant Jellyfin, 32 caractères hexadécimaux |
| `path` | chemin tel que Jellyfin le voit ; doit désigner un fichier vidéo **dans** la médiathèque montée (liens symboliques résolus) |
| `etag` | version du fichier ; un résultat d'un autre `etag` est périmé |
| `priority` | `high` (quelqu'un regarde), `normal`, `low` |
| `startAt` | facultatif : position à analyser en premier |
| `seriesId` | facultatif : pour réutiliser les visages nommés dans la série |
| `cast` | la distribution de l'épisode ; 12 photos au plus par personne, **adresses `https://image.tmdb.org/` uniquement** |

Réponses :

- `202 {"itemId", "status": "queued" | "running", "position"}` — `position` est le rang dans la
  file : 0 pour l'ordre en cours *ou qui commence tout de suite* (file vide, rien en cours), 1
  pour le prochain, etc. ;
- `200 {"itemId", "status": "done", "position": 0}` — déjà fait pour ce même `etag` : rien n'est
  relancé ;
- un ordre en double (même `etag`, en attente ou en cours) ne fait que remonter la priorité ;
- un autre `etag` oublie l'ancien résultat et repart de zéro ; un ordre en échec est relancé ;
- `400` — champ invalide, chemin hors de la médiathèque, photo hors de `image.tmdb.org`.

Entre deux tronçons, un ordre cède la place à un ordre plus prioritaire, et reprend ensuite là
où il en était.

### `GET /items/{itemId}`

```json
{ "itemId": "…", "etag": "…", "status": "running", "progress": 0.094, "analyzedUntil": 840.0, "error": null }
```

`status` : `queued`, `running`, `done` ou `failed`. `progress` : part du fichier analysée.
`analyzedUntil` : fin de la plage analysée d'un seul tenant à partir du tronçon de `startAt`
(0 tant que ce tronçon n'est pas fait ; la durée du fichier une fois terminé). `404` si inconnu.

### `GET /items/{itemId}/scenes`

```json
{
  "itemId": "…", "etag": "…", "model": "buffalo_l", "version": 1,
  "complete": false, "analyzedUntil": 840.0,
  "scenes": [
    { "start": 750.0, "end": 850.4,
      "people": [ { "personId": 12345, "screenTime": 41.2, "confidence": 0.82 } ] }
  ]
}
```

Les scènes couvrent toutes les plages déjà analysées (y compris, pendant l'analyse, des plages
disjointes) ; `people` est trié par temps de présence et ne contient que des visages nommés.
`version` est la version de l'algorithme qui a produit *ce* résultat (aujourd'hui 3 ; voir
[Calibrage](#calibrage)). Un résultat d'une version antérieure reste servi tel quel — il reste
valable — et rien n'est réanalysé de soi-même : un nouvel ordre au même `etag` répond encore
`done`. Pour le refaire avec les règles du jour : `DELETE`, puis un nouvel ordre. Un ordre commencé
sous une version antérieure et pas fini repart de zéro, pour ne jamais mêler deux règles dans un
même résultat. `404` tant que rien n'est analysé.

### `DELETE /items/{itemId}`

Oublie l'ordre et le résultat (fichier remplacé, par exemple), et arrête l'analyse s'il était
en cours. Toujours `204`.

---

## Développement

```
xray/
├── app/
│   ├── main.py        API HTTP, clé d'accès
│   ├── jobs.py        validation des ordres, file d'attente
│   ├── worker.py      l'ouvrier : tronçons, reprise, résultats partiels
│   ├── decode.py      ffmpeg, VA-API
│   ├── shots.py       plans, choix des images, scènes
│   ├── faces.py       détection, alignement, empreinte
│   ├── tracks.py      pistes dans un plan
│   ├── cluster.py     regroupement, noms (algorithme hongrois)
│   ├── results.py     assemblage des scènes
│   ├── cast.py        photos de référence, mémoire de la série
│   ├── gpu_guard.py   sessions Jellyfin
│   ├── models.py      téléchargement et vérification des poids
│   └── db.py          SQLite
└── tests/             contrat HTTP, clé, file, chemins, regroupement et noms sur des
                       empreintes synthétiques, plans et pistes synthétiques
```

Les tests n'ont besoin ni des modèles ni du réseau. Ils tournent pendant la construction de
l'image (étage `test` du `Dockerfile`), ou à part :

```sh
docker build --target test xray/
```

Les dépendances Python sont figées dans `requirements.txt`, résolu depuis `requirements.in`.
