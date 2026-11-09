# laterna-xray

**Qui est à l'écran, scène par scène — et qui parle.**

`laterna-xray` est un service d'appoint pour Laterna. Pour un film ou un épisode, il repère les
visages, les regroupe par personne et les nomme d'après la distribution — si bien que Laterna
peut afficher, pendant la lecture, les acteurs présents dans la scène en cours, avec leur rôle.

Il tourne à côté de Jellyfin, lit la médiathèque en lecture seule, décode sur l'iGPU Intel quand
il y en a un, calcule sur le processeur (ou sur l'iGPU, en option), et ne parle qu'à Laterna, par
un réseau Docker interne.

---

## Sommaire

- [Ce qu'il fait](#ce-quil-fait)
- [Comment ça marche](#comment-ça-marche)
- [Installation](#installation)
- [Brancher Laterna](#brancher-laterna)
- [Qui parle](#qui-parle)
- [Modèles et licences](#modèles-et-licences)
- [Accélération matérielle](#accélération-matérielle)
- [Performances](#performances)
- [Réglages](#réglages)
- [Calibrage](#calibrage)
- [Limites connues](#limites-connues)
- [Journaux et rapport d'analyse](#journaux-et-rapport-danalyse)
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
 ┌──────────────────────┐   2 à 6 images par plan (2 pour un plan fixe) : détection des visages,
 │ 3. pistes            │   tri, suivi d'image en image ; empreinte des 2 meilleurs visages de
 └──────────┬───────────┘   chaque piste, par lots ; une empreinte moyenne par piste
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

Les génériques de début et de fin, les rappels (« précédemment ») et les bandes-annonces ne
sont pas analysés : Laterna peut les donner dans l'ordre (`skip`), sinon le service les demande à
Jellyfin (ses *segments*, `GET /MediaSegments/{itemId}`), s'il y a accès. Personne n'y cherche un
acteur, et un générique défile souvent sur des visages qui n'ont rien à faire dans les scènes.

Le fichier est lu par tronçons de deux minutes. Chaque tronçon est décodé par ffmpeg (la
version que livre Jellyfin, avec son pilote Intel), réduit à 640 px de large et échantillonné à
quatre images par seconde. Les images non référencées ne sont pas décodées (`-skip_frame noref`,
sur l'iGPU comme sur le processeur) : sur quatre images par seconde, le filtre prend la plus
proche, et un tronçon 4K HEVC se décode en 3,9 s au lieu de 9,4 sur l'iGPU. Sur l'iGPU, la
réduction se fait sur la carte et seules les petites images reviennent en mémoire. Un fichier HDR (PQ ou HLG, Dolby Vision à couche HDR10 compris) est
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
toutes les dix secondes, six au plus). Un **plan fixe** — aucune image ne s'écarte de la première
(vignette brute et à contraste égal, couleurs) de plus du quart à peu près d'une coupe — n'en
prend que deux, quelle que soit sa durée : rien n'y entre ni n'y bouge assez pour changer qui
l'on voit. Sur chaque image :

- **détection** des visages et de cinq points (yeux, nez, coins de la bouche) ;
- **tri** : un visage trop petit (moins de 36 px), flou, ou de profil marqué compte comme une
  présence, mais ne sert pas à identifier ; les autres sont **alignés** sur un gabarit de
  112×112 px et notés (confiance, taille, netteté, frontalité).

D'une image à l'autre du plan, les visages sont reliés en *pistes* par le recouvrement de leurs
cadres. Puis vient l'**empreinte** — un vecteur de 512 nombres, proche pour deux photos d'une même
personne —, la partie la plus chère du calcul avec la détection :

- seuls les **deux meilleurs visages** de chaque piste sont empreintés (les autres n'y
  ajoutaient presque rien : la moyenne de deux bonnes vues vaut celle de trois) ;
- les empreintes partent **par lots** de 32 visages, de plusieurs plans à la fois : un appel du
  réseau pour 32 visages coûte bien moins que 32 appels ;
- dans une **série**, le meilleur visage d'une piste passe d'abord : s'il ressemble très nettement
  à un personnage déjà nommé dans les épisodes précédents (similarité ≥ 0,60, avec 0,25 d'avance
  sur le deuxième), le second n'est pas calculé ;
- un plan où le recouvrement seul ne suffit pas — un recouvrement moyen (0,25 à 0,5) entre deux
  bons visages, ou deux pistes qui ne se montrent jamais sur la même image (un même visage a pu
  bouger) — suit la règle complète : tous ses bons visages empreintés, pistes refaites avec la
  ressemblance des empreintes.

Chaque piste reçoit une seule empreinte, moyenne de ses visages empreintés pondérée par leur
qualité, et un temps de présence : la durée du plan multipliée par la part des images où elle
apparaît (toutes ses images comptent, empreintées ou non).

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
dans sa voisine la plus proche — sauf une **rafale** : plusieurs scènes courtes qui se suivent, dix
secondes ensemble au moins, dont les personnes sont pour 60 % au moins absentes de la minute voisine
de chaque côté, restent une scène (un autre lieu, monté en plans brefs que les couleurs ne relient pas).
*Ted Lasso* S01E09 : la conférence de presse (320–349 s) était fondue morceau par morceau dans le
vestiaire (238–320 s), les deux décors, sombres, se ressemblant à 0,9 par les couleurs. Une scène de plus de trois minutes est recoupée à sa frontière de
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
   `JELLYFIN_API_KEY` servent à laisser l'iGPU à Jellyfin quand il transcode
   (voir [Accélération matérielle](#accélération-matérielle)) et à lire les segments qu'il
   connaît (génériques, rappels), qui ne sont pas analysés.

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

## Qui parle

Depuis la version 5 des résultats (11/2026), le service écoute aussi : pour chaque segment de parole,
quelle voix, et — quand c'est sûr — à quelle personne de la distribution elle appartient
(`GET /items/{id}/voices`). Laterna aligne ses répliques de sous-titres sur ces segments par les temps
(n'importe quelle langue de sous-titres convient) et fait précéder d'un nom celles dont la voix est
sûre ; « Jusqu'ici » et les questions savent alors qui dit quoi.

### Comment

1. **Le son, sans relire le fichier.** Dans le même ffmpeg que l'image, une seconde sortie : la piste
   choisie, 16 kHz mono, **le canal central seul** quand elle en a un (`pan=mono|c0=FC` — c'est là que
   sont les dialogues, sans la musique ni les effets), sinon un mélange mono. Elle part dans un second
   tuyau (`pipe:<fd>`) ; le fichier n'est lu qu'une fois.
2. **La piste** : la version originale — la langue d'origine du titre, que Laterna envoie
   (`originalLanguage`, d'après TMDB) ; sinon une piste dite « VO » / « original » par son titre ou
   marquée comme telle ; sinon la piste par défaut ; jamais un commentaire ni une audiodescription.
   La piste retenue et la raison sont rendues par `/voices` (`track`). `XRAY_VOICE_TRACK=default` prend
   la piste par défaut d'office (voir les mesures plus bas).
3. **Silero VAD** (v6.2) trouve les zones de parole ; **une empreinte de voix par fenêtre de 1,5 s
   tous les 0,5 s** dans ces zones (80 bandes de Mel à la Kaldi). Le tout dans un fil à part
   (`XRAY_VOICE_THREADS`, 2 cœurs), pendant que l'image avance ; écrit en base tronçon par tronçon
   (empreintes en demi-précision).
4. **Morceaux** : chaque zone est coupée là où la voix change (deux fenêtres voisines sans recouvrement
   à plus de 0,5 de distance cosinus), puis en morceaux de 2 s au plus — l'unité qui reçoit une voix.
5. **Voix** : les morceaux sont regroupés (lien moyen, cosinus) **à trois seuils** — 0,65, 0,70, 0,75.
6. **Noms, par contraste local avec les visages** (pour chaque seuil) : pour une voix et une personne,
   sa présence à l'image pendant cette voix, moins sa présence pendant les autres voix des mêmes
   scènes (au moins 3 morceaux, contraste ≥ 0,10, marge ≥ 0,06, présence ≥ 0,3) ; puis la seconde
   chance (une personne prise par une autre voix nettement différente est écartée) ; **une personne,
   une voix** (une seconde grosse voix — 20 morceaux et plus — nettement différente de la principale
   reste sans nom : une voix au téléphone ne reçoit pas le nom du seul visage à l'écran) ; et une
   seconde passe morceau par morceau contre le profil de chaque personne nommée.
7. **Consensus** : un morceau ne garde un nom que si deux seuils sur trois au moins le donnent, et
   aucun autre nom. `confidence` = part des avis, réduite quand le morceau ressemble peu à la voix de la
   personne.
8. **Mémoire de la série** (`series_memory`, genre `voice`) : la voix moyenne de chaque personne que les
   **visages** ont nommée avec assurance dans les épisodes précédents (8 morceaux au moins, deux
   personnes trop proches écartées). Elle nomme une voix que les visages laissent sans nom ; **si elle
   contredit les visages de l'épisode, la voix reste sans nom** et le segment le dit (`conflict: true`).
9. À chaque point d'étape, le résultat des voix est refait comme les scènes ; à la fin de l'ordre, une
   dernière fois avec les visages complets. Le journal dit, par épisode, combien de voix sont nommées,
   indécises, en désaccord (visages / mémoire) et trop petites — de quoi juger plus tard où une lecture
   des lèvres servirait (`/items/{id}`, `voices`).

Un ordre fini **avant** l'étape des voix (résultat v4) n'est pas réanalysé : quand rien de plus pressé
qu'un ordre `low` n'attend, l'ouvrier lit **le son seul** des tronçons qui manquent (bien moins cher que
l'image) et prend les visages en base. De même pour des tronçons dont les réseaux de la voix n'étaient
pas encore prêts, et après un changement de `XRAY_VOICE_MODEL`.

### Mesures (09–10/11/2026, trois vérités de terrain)

Trois titres étiquetés à la main, réplique par réplique : *Ted Lasso* S01E08 (416 répliques),
*MacGyver* S01E06 (426), *Bullet Train* (120, dont 14 voix hors champ au téléphone — la seule bonne
réponse y est « sans nom »). « Nommé » : part des répliques étiquetées auxquelles Laterna donne un nom
(sa règle : 60 % de la réplique couverts par une même voix nommée, réplique à deux voix exclue) ;
« précision » : part de ces noms qui sont justes. Calculé par le service lui-même (son seul, sur une
copie de la base), sur la version originale :

| | *Ted Lasso* | *MacGyver* | *Bullet Train* | Ensemble | Voix au téléphone nommées |
|---|---|---|---|---|---|
| WeSpeaker ResNet34-LM | 69,5 % / 96,9 % | 63,4 % / 97,4 % | 67,9 % / 100 % | **66,6 % / 97,5 %** | 1 / 14 |
| + mémoire de la série (E09 → E08) | **77,6 % / 96,3 %** | — | — | | |
| CAM++ | 75,7 % / 95,6 % | 60,3 % / 94,2 % | 53,8 % / 100 % | 66,4 % / 95,4 % | 0 / 14 |
| + mémoire de la série | 77,2 % / 95,6 % | — | — | | |

**WeSpeaker est retenu** : même part nommée, mais la meilleure précision et le meilleur *Bullet Train*
(film : pas de mémoire). CAM++ coûte 40 % de calcul en moins.

**La stabilité** (le défaut du banc de R&D : un seuil qui scinde ou fusionne une voix change tout).
Le réglage du banc (seuil unique, morceaux de 3 s, sans coupe aux changements de voix) contre celui
retenu, en déplaçant les seuils de ± 0,05 :

| | seuil 0,65 | seuil 0,70 | seuil 0,75 |
|---|---|---|---|
| avant : un seuil | 52,1 % / 93,9 %, 11 téléphones nommés | 66,4 % / 94,3 %, 10 | 66,4 % / 94,4 %, 10 |
| après : consensus (centré sur) | 62,7 % / 97,3 %, 2 | 66,6 % / 97,5 %, 1 | 66,6 % / 97,3 %, 1 |

**La piste.** Sur *Ted Lasso*, le doublage français (voix de studio, un comédien par rôle) se nomme
mieux que la version originale (88,5 % contre 69,5 %, 77,6 % avec la mémoire) ; sur *Bullet Train*,
c'est l'inverse (50,0 % contre 67,9 %). Le défaut reste la version originale ; `XRAY_VOICE_TRACK=default`
pour une installation qui préfère la piste par défaut.

**Le coût** (i7-8700, 2 fils) : 0,065 s de calcul par seconde d'épisode, 0,046 par seconde de film
(dialogues plus rares) — un épisode de 30 min en ~2 min de calcul, ~65 s de mur ; *Bullet Train* en
~6 min de calcul. Le son seul d'un ordre déjà fait : même coût plus le décodage du son. Place en base :
~0,7 Mo par épisode (empreintes en demi-précision).

### Renommer sans relire

Tout ce qui coûte est gardé : plans, empreintes des pistes de visage, zones de parole et empreintes des
fenêtres de voix. `POST /items/{id}/relabel`, `POST /series/{id}/relabel` (dans l'ordre des épisodes
donné par `itemIds`, sinon par chemin) et `POST /relabel` (toute la bibliothèque) mettent des éléments
en file ; l'ouvrier refait **seulement** regroupement et noms (visages puis voix), avec les seuils du code
et la mémoire de la série du moment, par lots de 20 s au plus, jamais devant un ordre `normal` ou `high`.
Le résultat est le même qu'une analyse neuve sur les mêmes données (`test_relabel.py`). Laterna renomme
une série dont tous les épisodes du plan sont finis, une fois : ses premiers épisodes profitent alors
de la mémoire de toute la série.

### La mémoire des séries, gardée

Visages et voix : chaque épisode **dépose une contribution** par personne (`series_memory` : épisode,
date, poids, note) ; la mémoire est la moyenne pondérée des contributions. Refaire un épisode
**remplace** sa contribution. Un épisode compte au plus 300 s de visage et 60 morceaux de voix par
personne, et 15 personnes. Seulement ce qui est sûr et d'une source indépendante : un visage nommé par
les **photos** avec une marge de 0,10 et 5 s de présence, une voix nommée par les **visages**.
`GET /series/{id}/memory` liste les contributions ; `POST /series/{id}/memory/reset` les efface puis
renomme la série. L'ancienne `series_faces` est reprise une fois comme une contribution `legacy`.

### Lecture des lèvres

Le contraste avec les visages ne départage pas deux personnes toujours filmées ensemble : leur
présence est la même pendant les deux voix. Après les voix, à basse priorité, le service regarde **qui
bouge les lèvres** — seulement là où cela peut servir, car c'est cher ([`app/asdjob.py`](app/asdjob.py)) :

1. **Quelles voix** : les voix indécises (au seuil du milieu) d'au moins 4 morceaux, ni nommées ni en
   désaccord. Leurs **candidats** : les deux ou trois personnes les plus présentes pendant elles (15 %
   au moins). Une voix sans candidat à l'image (téléphone, narration) n'est pas lue, ni un morceau où
   plus de quatre personnes sont à l'image (une foule), ni une voix déjà nommée.
2. **Quels instants** : dix de ses morceaux au plus où un candidat est bien visible (la moitié du
   morceau), à 3 s au moins l'un de l'autre, élargis de 0,4 s, voisins joints (12 s au plus).
3. **Chaque fenêtre** est décodée à 25 images par seconde **avec son son**, dans le même ffmpeg, sans
   sauter d'image (sur l'iGPU quand il s'y prête et que Jellyfin ne s'en sert pas). Visages détectés
   une image sur cinq par le détecteur de l'analyse (32 px au moins), suivis par recouvrement, boîtes
   interpolées ; chaque piste prend le nom du groupe de visages nommé le plus proche (0,30).
   **Light-ASD** note chaque image de chaque piste (MFCC du son, visage en niveaux de gris 112×112).
4. **Un vote par morceau** : la piste la plus « parlante » (note moyenne), gardé en base par instants
   (`asd_votes`).
5. **Les voix sont refaites** : une voix encore sans nom prend celui que ses votes désignent — 3 votes
   au moins, 70 % des votes exprimés, un vote comptant si la note du gagnant est positive. **Jamais
   contre la mémoire de la série** : si elle préfère nettement quelqu'un d'autre (0,1 de cosinus), la
   voix reste sans nom (`conflict`). Les segments ainsi nommés portent `via: "asd"`. Une voix nommée
   par la lecture des lèvres ne nourrit pas la mémoire (seules les voix nommées par les visages le font).

Les votes sont gardés à travers les renommages (`relabel`) : ils sont rattachés aux morceaux du moment
par leurs instants. **Plafond** : `XRAY_ASD_BUDGET_S` secondes de processeur par élément (ffmpeg
compris, 600 par défaut) ; au-delà, ce qui est lu compte, le reste reste indécis. Entre deux fenêtres,
l'ouvrier cède la place à un ordre `normal` ou `high` et reprend plus tard où il en était. Le bilan est
dans `/items/{id}` (`voices.asd` : voix tentées, nommées, indécises avant et après, votes, calcul) et
dans `/quality` (`voicesAsd`, `asd`).

**Petites voix** (même date) : une voix de moins de 6 morceaux ne garde un nom qu'avec une confiance
de 0,75 au moins — tous les avis d'accord, et une voix qui ressemble à celle de la personne. Une voix
de 3 morceaux mêlant deux personnes (*Ted Lasso* S01E09, 840 s et 1675 s) était nommée à 0,667.

**Mesures** (10/11/2026, copie de la base de production, mêmes vérités de terrain et même règle
d'alignement que plus haut ; mémoire de la série telle qu'en production pour *Ted Lasso*) :

| | *Ted Lasso* E08 | *MacGyver* E06 | *Bullet Train* | Ensemble | Hors champ nommés |
|---|---|---|---|---|---|
| avant (voix v1) | 88,5 % / 94,8 % | 65,3 % / 97,5 % | 67,9 % / 100 % | 75,7 % / 96,4 % | 1 / 14 |
| petites voix | 88,0 % / 95,1 % | 64,8 % / 97,5 % | 67,9 % / 100 % | 75,3 % / 96,5 % | 1 / 14 |
| + lecture des lèvres | 88,0 % / 95,1 % | 64,8 % / 97,5 % | **75,5 % / 100 %** | **76,2 % / 96,5 %** | 1 / 14 |

Les 10 répliques nommées par la lecture des lèvres sont toutes justes ; une note de vote abaissée à
−0,5 nommait 9 voix de téléphone de plus — le seuil reste à 0. Sur *Ted Lasso* et *MacGyver*, les voix
qui restent indécises sont pour l'essentiel **des mélanges** (une voix de 27 morceaux dont les votes se
partagent entre deux personnes) : les votes refusent, à raison, de les nommer. Lire plus de voix (seuil
de 3 morceaux, 15 morceaux par voix) ne nomme rien de plus. *Ted Lasso* S01E09 : 14 voix indécises
avant, 20 avec la règle des petites voix (six petites voix perdent un nom peu sûr), 19 après la lecture.

**Coût** (i7-8700, 4 fils pour les visages, 2 pour Light-ASD, décodage sur l'iGPU) : *Ted Lasso* E08
35 s de calcul (3 voix, 24 s de vidéo lue), *MacGyver* 28 s, *Bullet Train* 162 s (11 voix, 133 s de
vidéo), *Ted Lasso* E09 13 s — 1,2 à 1,4 s de calcul par seconde de vidéo lue, loin du plafond. Light-ASD
seul : 2,5 ms par image et par visage.

### Limites

- Une voix nommée suppose que la personne soit **à l'image** quand elle parle, plus que les autres :
  un personnage toujours hors champ (narrateur, voix au téléphone), ou toujours filmé avec le même
  partenaire, reste souvent sans nom — c'est voulu.
- Un échange rapide sans silence peut tomber dans un même morceau ; la coupe aux changements de voix en
  rattrape la plupart, pas toutes. Les répliques à deux voix ne sont jamais nommées par Laterna.
- Les voix trop courtes (moins de 3 morceaux) ne sont jamais nommées ; de 3 à 5, seulement avec une
  confiance de 0,75.
- La lecture des lèvres ne nomme qu'une voix entière : une voix qui mêle deux personnes reste indécise.
- La version originale, prise de son de tournage, se regroupe moins bien qu'un doublage de studio.

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

**Le détecteur INT8 est produit chez vous, jamais distribué.** Avec `buffalo_l`, le détecteur
SCRFD est quantifié en INT8 (40 % de temps de détection en moins, voir
[Performances](#performances)). Ce réseau quantifié dérive des poids non commerciaux : comme eux,
il n'est ni dans le dépôt ni dans l'image. Au premier démarrage, une fois les poids vérifiés, le
conteneur le fabrique lui-même ([`app/quantize.py`](app/quantize.py), NNCF d'OpenVINO), à partir
de `det_10g.onnx` (vérifié par son SHA-256, relu avant la quantification) et de 224 images de *votre*
médiathèque — 14 images de 16 titres tirés au sort, décodées comme en production — et le garde
dans le volume (`models/buffalo_l/int8/`). Cela prend quelques minutes, une fois ; `/health` dit
`ready: false` pendant ce temps.

- L'IR n'est gardé qu'après une vérification : sur ces images, il doit retrouver au moins 95 %
  des visages identifiables que trouve le réseau d'origine (au banc : 72/72, 136/137, 73/74 —
  les deux manqués sous 36 px), sans en inventer plus de 5 %.
- Un `manifest.json` l'accompagne : recette, SHA-256 du réseau d'origine, versions d'OpenVINO et de
  NNCF, titres de calibrage, résultat de la vérification, SHA-256 des fichiers produits. À chaque
  démarrage, tout est revérifié ; un fichier abîmé, un autre réseau d'origine ou une recette
  nouvelle le font refaire.
- En cas d'échec, le service reste en float32 et le dit dans `/health` (`inference.int8`). Un
  échec de la quantification ou de la vérification est noté (`models/buffalo_l/int8.failed.json`)
  et n'est pas retenté — supprimer ce fichier pour réessayer ; une médiathèque vide ou pas encore
  montée n'est pas notée, l'essai est refait au démarrage suivant.
- Seul le détecteur est quantifié : l'empreinte en INT8 a été mesurée inutilisable, elle reste en
  float32.
- NNCF est installé sans son paquet de télémétrie : rien ne sort de la machine.

**Les voix** (« qui parle ») : deux fichiers de plus, dans `models/voice/`, vérifiés de même
([`app/voice.py`](app/voice.py)) :

| Rôle | Fichier | Source | Licence |
|---|---|---|---|
| Détection de parole | `silero_vad.onnx` (v6.2) | [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | MIT |
| Empreinte de voix, `XRAY_VOICE_MODEL=wespeaker_r34` *(défaut)* | `voxceleb_resnet34_LM.onnx` | [Wespeaker/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM) | **CC BY 4.0** |
| Empreinte de voix, `XRAY_VOICE_MODEL=campplus_en` | `3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx` | [3D-Speaker CAM++](https://github.com/modelscope/3D-Speaker), export ONNX de [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models) | Apache-2.0 |
| Lecture des lèvres (`models/asd/`) (`XRAY_ASD=1`) | `pretrain_AVA_CVPR.model` (Light-ASD, AVA ActiveSpeaker) | [Junhua-Liao/Light-ASD](https://github.com/Junhua-Liao/Light-ASD), commit `ed38c232` | MIT |

Light-ASD (Junhua Liao et al., *A Light Weight Model for Active Speaker Detection*, CVPR 2023) : ~1 M de paramètres, 94,1 % de mAP sur AVA. Le
fichier est un `state_dict` de PyTorch, lu **sans PyTorch** par un *unpickler* restreint qui n'accepte que
ce qu'un tel fichier contient (un dictionnaire, des tenseurs, leurs stockages) ; le réseau est reconstruit en OpenVINO
([`app/asd.py`](app/asd.py)), identique au code d'origine à 2,4·10⁻⁶ près sur la note (vérifié contre
PyTorch sur les vrais poids, et à chaque construction contre une référence numpy). LR-ASD (IJCV 2025,
même auteur, MIT) annonce 94,45 % : écart dans le bruit pour un vote, et non mesuré ici.

*Attribution (CC BY 4.0)* : « WeSpeaker ResNet34-LM, VoxCeleb » — Hongji Wang, Chengdong Liang, Shuai
Wang, Zhengyang Chen, Binbin Zhang, Xu Xiang, Yanlei Deng, Yanmin Qian, *WeSpeaker: A Research and
Production oriented Speaker Embedding Learning Toolkit*, ICASSP 2023 ; poids publiés par le projet
WeSpeaker sous licence CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), utilisés sans
modification. `XRAY_VOICE=0` coupe l'étape des voix (rien n'est téléchargé), lecture des lèvres
comprise ; `XRAY_ASD=0` coupe la seule lecture des lèvres.

`XRAY_DETECTOR_INT8=0` garde le détecteur d'origine. `auraface` n'a pas de détecteur INT8 (YuNet
passe par OpenCV).

`/health` indique toujours le modèle utilisé, s'il est prêt, sa licence, et où et en quelle
précision tourne l'inférence.

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

**L'inférence se fait sur le processeur** par défaut, par **OpenVINO** (le moteur d'Intel, livré
dans l'image) quand il se charge, par ONNX Runtime sinon — les deux lisent les mêmes fichiers
`.onnx` et rendent les mêmes empreintes (écart mesuré : cosinus ≥ 0,99999). Avec OpenVINO, le
détecteur est l'IR INT8 produit sur place (voir [Modèles et licences](#modèles-et-licences)).
OpenVINO est installé sans son paquet de télémétrie, qui ne sert qu'aux outils de conversion.

**Inférence sur l'iGPU, en option** (`XRAY_OV_DEVICE=GPU`). Le plugin GPU d'OpenVINO exécute les
deux réseaux d'origine en demi-précision sur l'iGPU Intel ; le processeur est presque libéré
(8 ms de processeur par image au lieu de 200), et le débit monte (sur l'UHD 630 : 8,7 images/s +
34,8 visages/s, contre 4,7 + 19,0 sur le processeur ; détections et empreintes identiques à un
cosinus ≥ 0,9994 près). L'image embarque pour cela le pilote de calcul d'Intel (OpenCL) : la
branche « legacy1 » 24.35 du compute-runtime et son compilateur IGC 1.0.17537.24, la dernière qui
prend en charge les iGPU Gen9 à Gen11 (Skylake à Ice Lake) — paquets pris aux publications GitHub
d'Intel et vérifiés par leur SHA-256 (~350 Mo de l'image ; `docker build --build-arg
GPU_RUNTIME=0` les laisse dehors). À savoir avant de l'activer :

- **mémoire** : chaque forme de réseau compilée sur l'iGPU garde sa copie des poids, en mémoire
  partagée avec le système. Les lots sont donc complétés jusqu'à des paliers fixes (1, 8 ou 32
  visages ; le détecteur par 1 ou par 8 images), et seules les quatre dernières formes servies
  restent compilées. Pic mesuré : ~3,3 Go — **passer `mem_limit` à `6g`** dans la composition ;
- **Jellyfin garde l'iGPU** : tant qu'il transcode avec l'accélération matérielle (le même relevé
  des sessions que pour le décodage, toutes les 30 s), l'inférence repasse sur le processeur, puis
  revient sur l'iGPU. Mesuré le 09/11/2026 : une transcodification perdait 39 % de sa vitesse avec
  l'inférence sur l'iGPU, 8 % avec l'inférence sur le processeur. Le journal note chaque bascule ;
- les photos de la distribution (chacune de sa taille) passent toujours par le processeur ;
- les noyaux compilés sont gardés dans le volume (`ov-cache/`) : la première compilation d'une
  forme prend quelques secondes, les suivantes presque rien ;
- si l'iGPU ne s'ouvre pas (pas de `/dev/dri`, autre iGPU), le service reste sur le processeur et
  le dit dans `/health` (`inference.gpuError`).

Le pilote de calcul des iGPU Gen9 n'est plus qu'en maintenance chez Intel : c'est une option, pas
le défaut.

**Le service se fait discret** : une analyse à la fois ; `nice 10` et `ionice` en classe basse
pour lui et le ffmpeg qu'il lance ; `XRAY_THREADS` fils de calcul (4 par défaut : inférence,
décodage et filtres de ffmpeg, OpenCV, calcul matriciel) ; et, dans l'exemple de composition,
`cpus: 4` et `mem_limit: 4g`.

Combien de fils ? Autant que de cœurs qu'on veut bien lui céder, et pas plus que `cpus:` dans la
composition : au-delà, les fils se disputent les mêmes cœurs et tout ralentit. Sur un processeur
à 6 cœurs / 12 fils qui sert aussi Jellyfin, `XRAY_THREADS=8` et `cpus: 8` laissent quatre fils au
reste ; sur 4 cœurs, 3 ; sur une machine partagée avec d'autres services lourds, 4. Le service
restant en priorité basse, il cède de toute façon le processeur à ce qui en demande.

---

## Performances

Mesuré le 09/11/2026 sur un Core i7-8700 (6 cœurs / 12 fils, UHD 630), `buffalo_l`, base neuve,
**sur une machine très chargée** (charge moyenne 22 à 49 pour 12 fils : réencodage, tests d'un
autre service) — les durées absolues sont donc pessimistes, les rapports entre versions parlent
davantage. Avant : `XRAY_THREADS=4`, `cpus: 4`, ONNX Runtime ; après : `XRAY_THREADS=8`, `cpus: 8`.
Chaque titre de série passe après l'épisode qui remplit la mémoire (S01E05, S01E01).

| Titre | Avant | Après | Noms | Écart de temps de présence |
|---|---|---|---|---|
| *MacGyver* S01E06 (HEVC 1080p, 42 min) | 727 s, **3,5×** le temps réel | 397 s, **6,4×** | 8 → les mêmes 8 | ≤ 3,7 s par personne |
| *The Pitt* S02E01 (HEVC 1080p, 53 min) | 831 s, **3,8×** | 476 s, **6,7×** | 35 → les mêmes 35 | ≤ 1,5 s |
| *Bullet Train* (HEVC 4K HDR10, 2 h 07) | 1 708 s, **4,5×** | 1 306 s, **5,8×** | 28 → les mêmes 28 | ≤ 16 s (Joey King −16, Michael Shannon +16 sur 470 et 199 s) |

Sur le temps processeur (mesuré par le cgroup, les deux versions tournant côte à côte), un
épisode coûte **2 à 2,4 fois moins** : *MacGyver* S01E06 2 534 → 1 076 s, *The Pitt* S01E01
2 953 → 1 493 s.

Où passe le temps (*MacGyver* S01E06, secondes, `stats` de `GET /items/{id}`) :

| Étape | Avant | Après |
|---|---|---|
| Détection | 396 (157 ms/image, 2 513 images) | 288 (120 ms/image, 2 405 images) |
| Empreinte | 284 (232 ms/visage, 1 223 visages) | 79 (90 ms/visage, 876 visages) |
| Attente du décodage | 25 | 11 |
| Plans (coupes) | 15 | 13 |
| Regroupement, noms, scènes | 2,3 | 1,9 |
| Photos de la distribution | 1,9 | 2,5 |

Ce que chaque mesure apporte :

- **OpenVINO** au lieu d'ONNX Runtime : empreinte un par un 324 → 210 ms par visage ; détection
  image par image sans gain net (180 contre 206 ms, sous charge) — le gain de la détection vient
  du lot.
- **Lots** : empreinte par 32, 140 à 170 ms au lieu de 210 à 320 par visage selon la charge ;
  détection par 8 (OpenVINO seulement), 25 à 30 % de moins par image. Sorties identiques (boîtes
  à 10⁻⁴ pixel, cosinus ≥ 0,9999998).
- **Deux meilleurs visages par piste** : −8 % d'empreintes (beaucoup de pistes n'en ont qu'un ou
  deux bons ; 12 à 25 % des plans suivent la règle complète).
- **Mémoire de série** : 215 pistes sur *MacGyver* S01E06, 100 sur *The Pitt* S02E01 s'arrêtent à
  un visage ; noms et temps de présence identiques à l'analyse sans sortie anticipée.
- **Plans fixes** : 1 à 4 % des plans, autant d'images en moins.
- **Génériques** : 66 à 101 s par épisode (rien sur *Bullet Train*, sans segments Jellyfin).
- **Fils** : 8 au lieu de 4 ; sur une machine déjà pleine, le service n'en obtient qu'une partie
  (2,7 cœurs en moyenne pendant le banc).

Le décodage n'est plus négligeable pour un film 4K HDR (adaptation `tonemapx` sur le processeur :
369 s d'attente sur *Bullet Train*), ni pour l'AV1, décodé sur le processeur. Le premier tronçon
(celui de `startAt`) reste prêt en moins d'une minute.

Un épisode occupe environ un mégaoctet en base (une empreinte par piste). Les poids de `buffalo_l` font
180 Mo, ceux d'`auraface` 260 Mo, l'IR INT8 du détecteur 5 Mo. En mémoire, le service tient sous 1,5 Go
sur le processeur (un réseau compilé par modèle, taille de lot libre) ; ~3,3 Go avec l'inférence
sur l'iGPU.

### Optimisations du 09/11/2026 (soir)

Mesurées une à une sur le même i7-8700 / UHD 630 (prototypes du banc), puis ensemble sur
*MacGyver* S01E06 (tableau plus bas). Toutes actives par défaut, sauf l'iGPU.

| Mesure | Avant | Après | Effet sur le résultat |
|---|---|---|---|
| Images non référencées sautées sur l'iGPU (`XRAY_VAAPI_NOREF`) | 9,4 s de décodage par tronçon 4K HEVC de 120 s | 3,9 s | images échantillonnées un peu différentes (une voisine) : résultats v4 |
| Détecteur INT8 (`XRAY_DETECTOR_INT8`) | 39,5 / 43,6 / 27,6 ms par image (MacGyver, The Pitt, Bullet Train) | 22,4 / 26,2 / 16,6 ms | 72/72, 136/137, 73/74 visages retrouvés (les manqués sous 36 px) ; empreintes inchangées |
| Assemblage incrémental (`XRAY_INCREMENTAL`) | ~25 s sur un film (Bullet Train, 64 tronçons, ~3 000 pistes) | 3 à 6 fois moins | identique à l'octet près |
| Inférence sur l'iGPU (`XRAY_OV_DEVICE=GPU`, option) | 4,7 images/s + 19,0 visages/s, ~200 ms de processeur par image | 8,7 + 34,8, 8 ms de processeur | cosinus ≥ 0,9994 ; 3,3 Go de mémoire |
| Arrêt de ffmpeg une fois la plage lue (correctif) | compté comme un échec (−9) : tronçon repris sur le processeur, voire ordre en échec | succès | — |

Écartés après mesure : le suivi entre images (détection sur une image analysée sur N, les autres
portées par flot optique ou redétection locale), `antelopev2` (empreinte R100 sur Glint360K) et
l'empreinte en INT8.

Ensemble, sur *MacGyver* S01E06 (HEVC 1080p, 42 min), conteneurs jetables côte à côte dans le
temps, `XRAY_THREADS=10`, `cpus: 10`, base neuve, machine chargée (charge moyenne 9 à 30 pour 12
fils, d'où des écarts d'un passage à l'autre) :

| Version | Durée | Détection | Empreinte | Assemblage | Charge |
|---|---|---|---|---|---|
| v3 (avant) | 369 s, **6,9×** le temps réel | 246 s (102 ms/image) | 93 s (1 091 visages) | 2,3 s | 13 → 23 |
| v4, processeur | 187 s, **13,7×** | 105 s (44 ms/image) | 62 s (1 085 visages) | 1,2 s | 9 → 15 |
| v4, processeur, relancé plus chargé | 239 s, **10,7×** | 150 s (62 ms/image) | 68 s (850 visages*) | 1,7 s | 17 → 28 |
| v4, iGPU (`XRAY_OV_DEVICE=GPU`) | 173 s, **14,7×** | 113 s (47 ms/image) | 32 s (859 visages*) | 2,3 s | 21 → 30 |

\* la mémoire de série était remplie par le passage précédent : moins de visages à empreinter.
Les mêmes 8 personnes nommées dans les quatre passages ; temps de présence à 9 s près au plus
par personne (sur 100 à 650 s), 51 scènes au lieu de 52. Le détecteur INT8 a été produit en 150 s
au premier démarrage (224 images de 16 titres, 181 visages identifiables sur 184 retrouvés, 69 →
38 ms par image au moment de la vérification). Mémoire : 1,2 Go sur le processeur, 2,7 Go au plus
relevé avec l'iGPU (le premier tronçon y compile ses formes : 33 s au lieu de 7).

---

## Réglages

Variables d'environnement (toutes facultatives sauf la clé) :

| Variable | Défaut | Rôle |
|---|---|---|
| `XRAY_API_KEY` | — | Clé partagée avec Laterna. **Vide : toutes les requêtes sont refusées.** |
| `XRAY_MODEL` | `buffalo_l` | `buffalo_l` ou `auraface` (voir plus haut). |
| `XRAY_THREADS` | `4` | Fils de calcul (inférence, décodage et filtres de ffmpeg) ; voir [Accélération matérielle](#accélération-matérielle). |
| `XRAY_INFERENCE` | `auto` | `auto` (OpenVINO s'il se charge, ONNX Runtime sinon), `openvino`, `onnxruntime`. |
| `XRAY_EMBED_BATCH` | `32` | Visages empreintés par appel du réseau. |
| `XRAY_FACES_PER_TRACK` | `2` | Visages empreintés au plus par piste (les meilleurs). |
| `XRAY_DETECTOR_INT8` | `1` | Détecteur INT8 produit sur place au premier démarrage (`buffalo_l`, OpenVINO) ; `0` : réseau d'origine. Voir [Modèles et licences](#modèles-et-licences). |
| `XRAY_OV_DEVICE` | `CPU` | `GPU` : inférence sur l'iGPU Intel (repasse sur le processeur pendant les transcodifications de Jellyfin ; `mem_limit: 6g`). Voir [Accélération matérielle](#accélération-matérielle). |
| `XRAY_VAAPI_NOREF` | `1` | `0` : sur l'iGPU, décoder aussi les images non référencées (comme avant la v4). |
| `XRAY_INCREMENTAL` | `1` | `0` : assemblage refait en entier à chaque tronçon (même résultat, plus cher). |
| `JELLYFIN_URL` | — | Adresse de Jellyfin, pour lui laisser l'iGPU et lire ses segments (génériques). |
| `JELLYFIN_API_KEY` | — | Clé d'API Jellyfin (en-tête `Authorization: MediaBrowser Token="…"`). |
| `XRAY_HWACCEL` | `1` | `0` : jamais de VA-API. |
| `XRAY_VAAPI_DEVICE` | `/dev/dri/renderD128` | Périphérique VA-API. |
| `XRAY_MEDIA_ROOT` | `/media` | Racine de la médiathèque montée ; tout chemin hors d'elle est refusé. |
| `XRAY_DATA_DIR` | `/data` | Base, modèles, photos. |
| `XRAY_SAMPLE_FPS` | `4` | Images échantillonnées par seconde. |
| `XRAY_CHUNK_SECONDS` | `120` | Longueur d'un tronçon. |
| `XRAY_MIN_FACE` | `36` | Plus petit visage identifiable, en pixels (image de 640 px). |
| `XRAY_VOICE` | `1` | `0` : pas d'étape « qui parle » (ni téléchargement, ni son lu). |
| `XRAY_VOICE_MODEL` | `wespeaker_r34` | Empreinte de voix : `wespeaker_r34` (CC BY 4.0) ou `campplus_en` (Apache-2.0). Changer de modèle refait les voix par le son seul. |
| `XRAY_VOICE_THREADS` | `2` | Fils des réseaux de la voix, à côté de ceux de l'image. |
| `XRAY_VOICE_TRACK` | `original` | `original` : la version originale quand elle existe ; `default` : la piste par défaut du fichier. |
| `XRAY_ASD` | `1` | `0` : pas de lecture des lèvres (ni téléchargement de Light-ASD). |
| `XRAY_ASD_BUDGET_S` | `600` | Plafond de calcul de la lecture des lèvres, par élément (secondes de processeur, ffmpeg compris). |
| `XRAY_ASD_THREADS` | `2` | Fils de Light-ASD. |
| `XRAY_COMMIT` | — | Commit de l'image, posé à la construction (`--build-arg XRAY_COMMIT=$(git rev-parse --short HEAD)`) ; repris par le journal et le rapport. |
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

## Journaux et rapport d'analyse

`docker logs` disparaît avec le conteneur, recréé à chaque déploiement : une analyse ratée la nuit
n'y était plus le matin, et pourquoi une voix restait sans nom ne se lisait nulle part. Deux choses
répondent désormais.

### Le journal : `/data/logs/xray.log`

Chaque ligne de journal du service (`app/logs.py`) va **aussi** dans le volume de données, un objet
JSON par ligne — toujours en plus de la sortie standard, qui garde sa ligne lisible :

```json
{"ts":"2026-11-10T21:04:12.381+01:00","level":"info","scope":"worker","msg":"[xray] 3f2a… : tronçon 7 (840–960 s) vaapi · …",
 "itemId":"3f2a…","action":"chunk_done","chunk":7,"decoder":"vaapi","frames":481,"shots":38,"tracks":21,"thread":"worker"}
```

`ts`, `level`, `scope` (le module : `api`, `worker`, `voicejob`, `asdjob`, `inference`, `guard`,
`models`, `report`…), `msg`, `itemId` quand l'événement concerne un élément, les champs structurés de
l'événement (`action` en premier lieu), et pour une erreur `error` et `stack`. **Rotation** à 5 Mo,
cinq archives (`xray.log.1` la plus récente … `xray.log.5`) : 30 Mo au plus. Les exceptions des routes
(journal `uvicorn.error`) y vont aussi. Un dossier non inscriptible laisse le service tourner sur la
seule sortie standard, et le dit.

**Jamais un secret** : `XRAY_API_KEY`, `JELLYFIN_API_KEY` et toute variable d'environnement dont le
nom contient `KEY`, `TOKEN`, `SECRET` ou `PASSW` sont remplacées par `«secret»` dans chaque ligne
(fichier et sortie standard), comme ce qui suit `Bearer `, `Token="` ou `api_key=`. Le contenu des
fichiers n'est jamais journalisé ; les chemins le sont. `tests/test_logs.py` pose de fausses clés et
vérifie qu'aucune n'apparaît.

Les événements, chacun une fois (`action`) :

| `action` | Quand | Champs principaux |
|---|---|---|
| `startup` | démarrage | version, `commit`, fils, `inference`, `ovDevice`, `detectorInt8`, VA-API, `noref`, voix et lèvres activées, seuils de visage, `jellyfin`/`apiKey` (posés ou non, jamais la valeur), `models` (fichiers, versions, SHA-256) |
| `models_ready` | poids vérifiés (visages, voix, lèvres) | `files` {fichier: SHA-256}, `int8` |
| `int8` | détecteur INT8 produit, repris, refusé ou non voulu | `state`, `reason`/`error`, `files` |
| `engine_loaded`, `gpu_unavailable` | réseaux chargés ; iGPU qui ne s'ouvre pas | `engine`, `detector`, `device`, `gpu`, `gpuError` |
| `gpu_guard`, `device_switch` | Jellyfin prend ou rend l'iGPU ; chaque bascule iGPU ↔ processeur de l'inférence | `busy`, `device`, `previous`, `reason` (`jellyfin_transcode`, `jellyfin_idle`, `start`) |
| `job_received`, `job_refused` | `POST /jobs` | `priority`, `startAt`, `skip`, `originalLanguage`, `seriesId`, `cast`, `rebindDuration`, `status`, `position` |
| `job_start`, `job_plan` | début d'un passage | chemin, etag, tentative ; distribution, références, mémoire, codec, HDR, plages sautées et leur source |
| `chunk_done`, `chunk_skipped`, `vaapi_fallback` | chaque tronçon | décodeur, images, plans, pistes, secondes |
| `voice_track`, `audio_track` | piste son retenue | `reason`, `originalLanguage`, piste (langue, codec, canaux, disposition, canal écouté, filtre) |
| `job_done`, `job_yield`, `job_cancelled`, `job_failed` | fin d'un passage | durées, calcul par étape, × temps réel ; erreur et pile |
| `voice_only_*`, `voices_done` | voix par le son seul ; voix finales | tronçons, secondes de parole, comptes |
| `asd_start`, `asd_yield`, `asd_done`, `asd_failed` | lecture des lèvres | voix lues et candidats, fenêtres, votes, calcul, plafond, décodeurs |
| `rebind`, `rebind_refused` | fichier remplacé (`rebindIfSameDuration`) | ancien et nouvel etag, durées |
| `relabel_requested`, `relabel`, `relabel_failed` | renommages | éléments, résumé |
| `memory_reset`, `voice_model_reset`, `version_reset`, `item_deleted` | oublis | contributions, modèles, versions |
| `report`, `report_failed` | rapport refait (une ligne qui le résume) | comptes, `voiceReasons`, `voiceVia`, `gpuShare`, `vaapiShare` |

Lire : `docker exec laterna-xray tail -n 50 /data/logs/xray.log | jq -c .` ; un élément :
`jq -c 'select(.itemId=="…")' /data/logs/xray.log*`.

### Le rapport de décision : `GET /items/{itemId}/report`

Pour chaque élément, ce qui a été fait, avec quoi, et pourquoi (`app/report.py`). **Refait et gardé en
base** (table `reports`) à chaque fin de passage qui change le résultat — analyse complète (`trigger:
"analyse"`), voix par le son seul (`"voix"`), lecture des lèvres (`"lèvres"`), renommage
(`"renommage"`) —, refait à la demande (`"lecture"`) s'il manque ou date d'un autre fichier. Tout vient
de la base et des constantes du code : le refaire donne le même rapport. Il ne fait jamais échouer ce
qui l'appelle. `GET /quality` donne le lien de chacun (`items[].reportUrl`).

| Partie | Contenu |
|---|---|
| `service` | version, `commit` (`--build-arg XRAY_COMMIT=…` à la construction), versions des résultats, des voix, de la lecture des lèvres, du rapport ; `analysedWith` : version, commit et nombre de passages de l'analyse de l'image |
| `results` | version et état des scènes, des voix, de la lecture des lèvres |
| `models` | visages (détecteur avec `precision` `int8`/`fp32` et les fichiers de l'IR INT8, empreinte, moteur), voix (VAD, empreinte), lèvres : fichier, version publiée, SHA-256, licence |
| `devices` | inférence : réglage, part des tronçons sur l'iGPU / le processeur / les deux (`chunks`, `gpuShare`) ; décodage : tronçons VA-API / processeur / sautés, images non référencées sautées (`noref`) ; voix (processeur) ; lèvres (décodeurs, appels iGPU/processeur) |
| `audio` | piste retenue (rang, langue, codec, canaux, disposition), `reason` (`original` : langue d'origine ; `vo` : titre ou marque ; `default` ; `first`), `originalLanguage`, ce qui est écouté (`channelUse` : `centre`, `centre_c2`, `downmix`) et le filtre |
| `thresholds` | visages (regroupement, rejet, bandes sûre / à confirmer, écart, présence), voix (`VoiceParams` entier), `smallVoice` (6 morceaux, 0,75), lèvres (règles de vote et choix des instants, plafond), scènes (durées, ressemblances, règle des rafales) |
| `skipped` | plages sautées, leur source (`ordre`, `jellyfin`, `aucune`), secondes |
| `counts` | tronçons, plans, scènes, pistes et groupes de visages, groupes nommés, voix nommées / indécises / en désaccord / petites / par les lèvres, part de parole nommée, voix tentées et résolues par les lèvres |
| `cpu` | calcul de l'image par étape, × temps réel, assemblage des voix, lèvres (processeur, durée, plafond) |
| `voices` | **par voix** (`voiceId` de `/voices`) : `pieces`, `seconds`, `personId`, `via` (`faces`, `memory`, `asd`, `profile`), `confidence` ; sans nom, `reason` (et `reasons` si plusieurs) ; le meilleur `candidate` des visages (`score` de contraste, `margin`, `present`) et les votes des lèvres (`asd` : `votes`, `top`, `share`) |
| `voiceReasons`, `voiceVia` | les mêmes, comptés |
| `faceClusters` | par groupe de visages (nommés, puis anonymes de 2 s au moins ; `omitted` pour le reste) : `seconds`, `tracks`, `personId`, `score`, `margin` (sur le deuxième acteur, plancher 0), `band` (`sure`, `confirm`, `doubt`) ; anonyme : `candidate` et `reason` (`doubt_band`, `runner_up_close`, `too_short`, `person_taken`, `no_reference`) |

Raisons d'une voix sans nom, de la plus décisive à la moins (`reason` est la première) :

| Code | Sens |
|---|---|
| `conflict_memory` | visages et mémoire de la série nomment deux personnes différentes |
| `too_few_lines` | moins de `min_lines` (3) morceaux |
| `small_voice_low_conf` | petite voix (moins de 6 morceaux) nommée sous 0,75 de confiance |
| `second_big_voice` | une personne, une voix : une autre voix plus fournie et nettement différente a déjà ce nom (téléphone, narration) |
| `no_consensus` | nommée au seuil du milieu, mais pas par deux des trois seuils |
| `asd_memory_conflict` | les lèvres désignent quelqu'un que la mémoire de la série contredit |
| `asd_anonymous_face` | les lèvres désignent un visage sans nom |
| `asd_too_few_votes` | moins de 3 votes pour le mieux placé |
| `asd_split_votes` | votes partagés (moins de 70 % pour le mieux placé) |
| `off_screen_no_candidate` | personne d'assez présent à l'image pendant elle |
| `low_contrast` | des visages, mais pas plus présents pendant cette voix que pendant les autres (contraste ou marge trop faibles) |
| `undecided` | rien de ce qui précède |

Exemple (abrégé) :

```json
{
  "reportVersion": 1, "itemId": "…", "etag": "…", "status": "done", "trigger": "lèvres",
  "service": { "version": "1.0.0", "commit": "8c7bbb2", "resultVersion": 5, "voiceVersion": 2, "asdVersion": 1 },
  "models": { "faces": { "name": "buffalo_l", "detector": { "file": "det_10g.onnx", "sha256": "5838f7fe…", "precision": "int8" } } },
  "devices": { "inference": { "setting": "GPU", "chunks": { "gpu": 11, "mixed": 2, "cpu": 2 }, "gpuShare": 0.867 },
               "decode": { "chunks": { "vaapi": 14, "skip": 1 }, "vaapiShare": 1.0, "noref": { "cpu": true, "vaapi": true } } },
  "audio": { "reason": "original", "originalLanguage": "en",
             "track": { "index": 1, "language": "eng", "codec": "eac3", "channels": 6, "channelUse": "centre" } },
  "skipped": { "source": "jellyfin", "ranges": [[0.0, 62.4]], "seconds": 62.4 },
  "counts": { "scenes": 41, "faceClusters": 63, "facesNamed": 12, "voicesNamed": 23, "voicesUndecided": 9,
              "voicesConflict": 1, "voicesSmall": 94, "asdTried": 5, "asdResolved": 2 },
  "voiceReasons": { "too_few_lines": 94, "low_contrast": 6, "off_screen_no_candidate": 2, "conflict_memory": 1, "asd_split_votes": 1 },
  "voices": [
    { "voiceId": 7, "pieces": 212, "seconds": 391.5, "personId": 12345, "via": "faces", "confidence": 0.98 },
    { "voiceId": 9, "pieces": 41, "seconds": 70.2, "personId": 67890, "via": "asd", "confidence": 0.67,
      "asd": { "votes": 9, "top": 67890, "share": 0.889 } },
    { "voiceId": 12, "pieces": 33, "seconds": 61.0, "personId": null, "reason": "second_big_voice",
      "candidate": { "personId": 12345, "score": 0.18, "margin": 0.56, "present": 0.9 } }
  ],
  "faceClusters": { "clusters": 63, "named": 12, "reasons": { "doubt_band": 40, "too_short": 6 },
                    "listed": [ { "cluster": 0, "seconds": 512.3, "tracks": 140, "personId": 12345, "score": 0.61,
                                  "margin": 0.42, "band": "sure", "confidence": 0.98 } ], "omitted": 30 }
}
```

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
  "inference": { "engine": "openvino", "device": "CPU", "gpu": false, "gpuActive": false, "gpuError": null,
                 "detector": "int8", "int8": { "state": "ready", "error": null } },
  "queue": { "pending": 0, "running": null }
}
```

`ready` vaut `false` tant que les poids se téléchargent (et, au premier démarrage, pendant la
quantification du détecteur) ; `error` dit pourquoi ils ne sont pas prêts (réseau, empreinte qui
ne correspond pas). `running` est l'`itemId` en cours d'analyse.

`inference` (ajout compatible, 11/2026 ; informatif) : `engine` (`openvino`, `onnxruntime`, `null`
avant le chargement), `device` (le réglage `XRAY_OV_DEVICE`), `gpu` (réseaux chargés sur l'iGPU),
`gpuActive` (servis par l'iGPU en ce moment — `false` pendant une transcodification de Jellyfin),
`gpuError` (pourquoi l'iGPU n'a pas pu servir), `detector` (`int8` ou `fp32`, sur le processeur ;
sur l'iGPU, toujours le réseau d'origine), `int8.state` (`off`, `building`, `ready`, `failed`) et
`int8.error` (la raison d'un `off` ou d'un `failed`).

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
| `rebindIfSameDuration`, `durationS` | facultatifs (ajout compatible, 11/2026) : fichier remplacé (réencodage) de même durée. Avec `true` et la durée du nouveau fichier en secondes, un résultat **complet** sous un autre `etag` dont le fichier durait à ±1 s pareil passe au nouvel `etag` sans analyse (`200 done`). La durée comparée est celle que ffprobe a lue sur l'ancien fichier, à défaut la fin du résultat complet ; sinon, comportement habituel |
| `skip` | facultatif (ajout compatible, 11/2026) : `[{"start": 208.3, "end": 224.8}, …]`, 32 plages au plus, en secondes — génériques, rappel, bande-annonce. Aucun visage n'y est cherché ; les scènes ne les couvrent pas. Absent : le service demande ses segments à Jellyfin (Intro, Outro, Recap, Preview) s'il y a accès ; `[]` : rien n'est sauté et Jellyfin n'est pas consulté |

Réponses :

- `202 {"itemId", "status": "queued" | "running", "position"}` — `position` est le rang dans la
  file : 0 pour l'ordre en cours *ou qui commence tout de suite* (file vide, rien en cours), 1
  pour le prochain, etc. ;
- `200 {"itemId", "status": "done", "position": 0}` — déjà fait pour ce même `etag` : rien n'est
  relancé ;
- un ordre en double (même `etag`, en attente ou en cours) ne fait que remonter la priorité ;
- un autre `etag` oublie l'ancien résultat et repart de zéro — sauf reprise d'un fichier
  remplacé de même durée (`rebindIfSameDuration`) ; un ordre en échec est relancé ;
- `400` — champ invalide, chemin hors de la médiathèque, photo hors de `image.tmdb.org`.

Entre deux tronçons, un ordre cède la place à un ordre plus prioritaire, et reprend ensuite là
où il en était.

### `GET /items/{itemId}`

```json
{ "itemId": "…", "etag": "…", "status": "running", "progress": 0.094, "analyzedUntil": 840.0, "error": null,
  "durationS": 2551.36,
  "stats": { "seconds": 61.2, "realtime": 13.7, "skippedSeconds": 0,
             "stages": { "decode_wait": 1.1, "shots": 2.0, "convert": 0.3, "detect": 30.5, "grade": 1.2,
                         "embed": 18.4, "track": 0.4, "write": 0.1, "build": 1.0, "photos": 5.9, "other": 0.3 },
             "counts": { "decoded": 3360, "images": 420, "faces": 610, "embedded": 240, "early_exit": 31 } } }
```

`status` : `queued`, `running`, `done` ou `failed`. `progress` : part du fichier analysée.
`analyzedUntil` : fin de la plage analysée d'un seul tenant à partir du tronçon de `startAt`
(0 tant que ce tronçon n'est pas fait ; la durée du fichier une fois terminé). `durationS` : durée du
fichier lue par ffprobe (`null` avant le début de l'analyse). `stats` (ajout
compatible, 11/2026 ; `null` tant que rien n'est fait) : le temps de calcul des tronçons faits,
étape par étape, et ce qu'ils ont compté — informatif, pour savoir où le temps passe. Les étapes :
`decode_wait` (l'analyse attend ffmpeg, qui décode en parallèle), `shots` (coupes), `convert`,
`detect`, `grade` (tri des visages), `embed`, `track` (pistes), `write`, `build` (regroupement,
noms, scènes), `photos` (distribution). `404` si inconnu.

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
`version` est la version de l'algorithme qui a produit *ce* résultat (aujourd'hui 5 : l'étape « qui parle » dans le même passage ;
4 : images non référencées sautées sur l'iGPU et détecteur INT8, règles de noms et de scènes inchangées ; voir
[Calibrage](#calibrage) et [Performances](#performances)). Un résultat d'une version antérieure reste servi tel quel — il reste
valable — et rien n'est réanalysé de soi-même : un nouvel ordre au même `etag` répond encore
`done`. Pour le refaire avec les règles du jour : `DELETE`, puis un nouvel ordre. Un ordre commencé
sous une version antérieure et pas fini repart de zéro, pour ne jamais mêler deux règles dans un
même résultat. `404` tant que rien n'est analysé.

### `GET /items/{itemId}/report`

Le rapport de décision de l'élément (ajout compatible, 10/11/2026) ; voir
[Journaux et rapport d'analyse](#journaux-et-rapport-danalyse). `404` si l'élément est inconnu ; pour un
élément pas encore fini, le rapport de ce qui est fait (non gardé).

### `GET /items/{itemId}/voices`

```json
{
  "itemId": "…", "etag": "…", "model": "wespeaker_r34", "version": 1,
  "complete": true, "analyzedUntil": 1783.0,
  "track": { "index": 3, "language": "eng", "title": "English", "channels": 6, "reason": "original" },
  "stats": { "voicesNamed": 23, "voicesUndecided": 11, "voicesConflict": 1, "voicesSmall": 94, "speechNamed": 0.85, "…": "…" },
  "segments": [
    { "start": 12.32, "end": 14.1, "voiceId": 7, "personId": 12345, "confidence": 1.0 },
    { "start": 15.0, "end": 16.2, "voiceId": 9, "personId": null, "confidence": 0.0, "conflict": true }
  ]
}
```

Les segments de parole, dans l'ordre : `voiceId` (une voix de cet élément), `personId` (la
distribution de l'ordre) quand la voix est nommée, `confidence` (0..1), `conflict` quand la mémoire
de la série et les visages de l'épisode se contredisent (la voix reste sans nom). `track.reason` :
`original`, `vo`, `default` ou `first` ; `track: null` sans piste son utilisable. `complete: false`
pendant l'analyse — Laterna ne se sert alors d'aucun nom. Les répliques à deux voix sont l'affaire de
Laterna. `404` tant qu'il n'y a rien. `version` : 1.

### Renommer, mémoire des séries, qualité

- `POST /items/{itemId}/relabel` → `202 {queued, pending}` ; `404` inconnu, `409` pas fini.
- `POST /series/{seriesId}/relabel`, corps facultatif `{"itemIds": [...]}` (l'ordre des épisodes) →
  `202 {queued, items, pending}`.
- `POST /relabel` → toute la bibliothèque en file ; `GET /relabel` → `{pending}`.
- `GET /series/{seriesId}/memory` → `{seriesId, entries: [{kind, model, personId, itemId, weight, score, updated}]}`.
- `POST /series/{seriesId}/memory/reset`, corps facultatif `{"itemIds": [...]}` → `{removed, queued}`.
- `GET /quality` → `{overall, movies, series: [...], items: [...]}` : par série (les moins bien nommées d'abord),
  `items`, `withVoices`, `speechNamed` (part du temps de parole nommée), `facesNamed` (part du temps de
  visage nommée), `voicesNamed`, `voicesUndecided`, `voicesConflict`, `itemsWithConflict` ; et (ajout
  compatible, 10/11/2026) `items` : chaque élément fini (`itemId`, `seriesId`, `speechNamed`,
  `facesNamed`, comptes de voix), les moins bien nommés d'abord, avec `reportUrl`
  (`/items/{itemId}/report`).

Lecture des lèvres (10/11/2026) : les segments de `/voices` peuvent porter `via: "asd"` ; `/voices`
passe en `version: 2` ; `/items/{id}` → `voices.voicesAsd` et `voices.asd` (`voicesTried`,
`voicesResolved`, `voicesUndecided`, `undecidedBefore`, `votes`, `cpuSeconds`, `capped`, `status`) ;
`/quality` → `voicesAsd` et `asd` (`items`, `tried`, `resolved`, `cpuSeconds`) par groupe ; `/health` →
`voice.asd` (`enabled`, `ready`, `license`, `error`).

`GET /items/{itemId}` gagne `voices` (`complete`, comptes de voix, `speechNamed`) et `faces`
(`facesNamed`, `faceSeconds`) ; `/health` gagne `voice` (modèle, licence, prêt, erreur, détection de
parole). `POST /jobs` accepte `originalLanguage` (code ISO 639, facultatif).

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
│   ├── inference.py   OpenVINO (processeur ou iGPU) ou ONNX Runtime
│   ├── quantize.py    détecteur INT8 produit sur place (calibrage, NNCF, vérification)
│   ├── pipeline.py    quels visages empreinter, par lots, mémoire de série
│   ├── tracks.py      pistes dans un plan
│   ├── segments.py    plages sautées (ordre, segments de Jellyfin)
│   ├── timing.py      chronomètre par étape
│   ├── cluster.py     regroupement, noms (algorithme hongrois)
│   ├── results.py     assemblage des scènes (complet ou incrémental)
│   ├── cast.py        photos de référence, mémoire de la série
│   ├── gpu_guard.py   sessions Jellyfin
│   ├── models.py      téléchargement et vérification des poids
│   ├── audio.py       piste son (version originale), son dans le même ffmpeg
│   ├── voice.py       Silero VAD, empreintes de voix, poids de la voix
│   ├── voices.py      morceaux, voix, noms, consensus, mémoire (assemblage pur)
│   ├── voicejob.py    le son d'un ordre à côté de l'image, son seul des ordres finis
│   ├── asd.py         Light-ASD : poids sans PyTorch, réseau OpenVINO, MFCC, recadrage
│   ├── asdjob.py      lecture des lèvres ciblée : voix, instants, pistes, votes, plafond
│   ├── relabel.py     renommer sans relire (file, lots bornés)
│   ├── memory.py      mémoire des séries par contribution d'épisode
│   ├── logs.py        journal JSON tournant dans /data/logs, secrets masqués
│   ├── report.py      rapport de décision par élément (/items/{id}/report)
│   └── db.py          SQLite
└── tests/             contrat HTTP, clé, file, chemins, regroupement et noms sur des
                       empreintes synthétiques, plans et pistes synthétiques, économies de
                       calcul (meilleurs visages, lots, mémoire, plans fixes, plages, fils),
                       décodage arrêté par nous, assemblage incrémental identique au complet,
                       paliers et bascule de l'iGPU, quantification INT8 (vraie, sur un petit réseau),
                       voix (champ-contrechamp, téléphone, désaccord, consensus), piste son,
                       son du même ffmpeg, renommage identique à l'analyse, mémoire bornée, qualité,
                       lecture des lèvres (poids piégés refusés, réseau contre une référence numpy,
                       votes, mémoire contredite, renommage), rafales de plans courts,
                       journal (JSON, rotation, aucune clé), rapport de décision (forme, raisons)
```

Les tests n'ont besoin ni des modèles ni du réseau. Ils tournent pendant la construction de
l'image (étage `test` du `Dockerfile`), ou à part :

```sh
docker build --target test xray/
```

Les dépendances Python sont figées dans `requirements.txt`, résolu depuis `requirements.in`.
OpenVINO, NNCF et les quelques paquets que sa quantification importe sont installés à part, sans
leurs dépendances (ni télémétrie, ni scikit-learn), à des versions figées dans le `Dockerfile` ;
le pilote de calcul Intel aussi, vérifié par SHA-256.
