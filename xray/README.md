# laterna-xray

**Qui est à l'écran, scène par scène — et qui parle.**

`laterna-xray` est le service d'analyse de Laterna. Pour un film ou un épisode, il découpe l'image en
plans et en scènes, repère les visages, les regroupe par personne et les nomme d'après la distribution ;
il écoute la piste son, sépare les voix et les rattache aux visages. Laterna s'en sert pour montrer,
pendant la lecture, les acteurs présents dans la scène en cours, et pour que ses fonctions d'IA sachent
qui fait et qui dit quoi.

Il tourne à côté de Jellyfin, lit la médiathèque en lecture seule, décode sur l'iGPU Intel quand il y en
a un, calcule sur le processeur (ou sur l'iGPU, en option), **ne fait appel à aucun service d'IA en
ligne**, et ne parle qu'à Laterna, par un réseau Docker interne.

---

## Sommaire

- [Ce qu'il fait](#ce-quil-fait)
- [Ce que Laterna en montre](#ce-que-laterna-en-montre)
- [En bref : comment, combien, à quel point](#en-bref--comment-combien-à-quel-point)
- [La documentation](#la-documentation)
- [Installation](#installation)
- [Brancher Laterna](#brancher-laterna)
- [Mettre à jour](#mettre-à-jour)
- [Modèles et licences](#modèles-et-licences)
- [Vie privée](#vie-privée)
- [Accélération matérielle](#accélération-matérielle)
- [Voies d'analyse](#voies-danalyse)
- [Réglages](#réglages)
- [Dépannage](#dépannage)
- [Développement](#développement)

---

## Ce qu'il fait

Laterna lui envoie un ordre : *ce fichier, avec cette distribution* (les acteurs de l'épisode, invités
compris, et quelques photos de chacun prises sur TMDB). Le service rend :

- **les scènes** — pour chacune, les personnes reconnues, triées par temps de présence, avec un indice
  de confiance ;
- **les voix** — pour chaque segment de parole, quelle voix, et, quand c'est sûr, à quelle personne
  elle appartient ;
- **un rapport de décision** — ce qui a été fait, avec quels modèles, et pourquoi chaque voix ou chaque
  visage est nommé ou ne l'est pas.

```
720,0 – 765,3 s   Acteur A  18,8 s  (0,99)   Actrice B  15,0 s  (0,98)   Acteur C  7,5 s  (0,99)
765,3 – 840,0 s   Acteur A  22,3 s  (0,99)   Actrice D  12,0 s  (0,99)

  731,2 – 733,9 s  voix 7  → Acteur A  (1,00)
  734,4 – 735,1 s  voix 9  → sans nom   (désaccord entre les visages et la mémoire de la série)
  736,0 – 739,8 s  voix 4  → Actrice B  (0,67, par la lecture des lèvres)
```

Quatre principes :

- **Personne n'est nommé au hasard.** Un visage n'est comparé qu'aux acteurs de la distribution fournie,
  et seulement s'il leur ressemble nettement ; une voix n'est nommée que si les visages, à trois seuils,
  s'accordent sur elle. Sinon elle reste sans nom — et un visage anonyme n'est jamais renvoyé. Mieux vaut
  un silence qu'une erreur.
- **Ce qu'on regarde passe d'abord.** Si quelqu'un lance l'épisode à la 25ᵉ minute, l'analyse commence
  là, avance jusqu'à la fin, puis revient au début. Les scènes arrivent au fil de l'analyse : un résultat
  partiel est lisible à tout moment.
- **Le service passe après tout le reste.** Une analyse à la fois, à priorité basse, avec un nombre de
  fils borné ; si Jellyfin transcode sur l'iGPU, le service lui laisse la place.
- **Rien n'est relu deux fois.** Ce qui coûte (plans, empreintes de visages et de voix) est gardé : une
  règle de noms qui change, une série qui s'allonge ou une mémoire réinitialisée se refont sans relire le
  fichier.

---

## Ce que Laterna en montre

Tout est optionnel et coupé par défaut ; chaque fonction a son public (`off`, `admins`, `tous`).

| Écran | Ce qu'on y voit | Ce qu'il lit | IA en ligne |
|---|---|---|---|
| **La rangée « À l'écran »** du lecteur | avec les commandes, en lecture comme en pause : les personnes de la scène en cours, en pilules (photo, acteur, personnage), par temps de présence | les scènes | non |
| **Le panneau d'une personne** | touchée dans la rangée : photo, âge, lieu, courte biographie TMDB, deux ou trois de ses autres titres dans la bibliothèque | la distribution, TMDB | non |
| **« Jusqu'ici »** (en tête du panneau) | une ou deux phrases sur le personnage, d'après **ce que le compte a déjà vu** — coupées au début de la scène en cours, jamais au-delà | les scènes (coupe, répliques groupées par scène) et les voix (« Nom : réplique ») | oui |
| **Les questions** | sur les liens entre les personnages de la scène (panneau d'une personne), ou libres sur le titre (bouton rond au bout de la rangée, fiches) | les voix, quand l'analyse est complète | oui |
| **Configuration → Acteurs à l'écran** | l'analyse de toute la bibliothèque en fond, par paliers, avec pause, priorités, vitesse, temps restant et **qualité des noms** par série | `/items`, `/quality`, `/health` | — |

Le service lui-même n'appelle aucune IA en ligne : « Jusqu'ici » et les questions sont des fonctions de
Laterna, qui n'envoient au fournisseur choisi que du texte (résumés, répliques, noms). Un lien de partage
voit la rangée et le panneau, jamais les autres titres de la bibliothèque, et aucune fonction d'IA.

---

## En bref : comment, combien, à quel point

```
 fichier ──▶ ffmpeg (une passe) ──▶ image 640 px, 4 i/s ──▶ plans ──▶ visages ──▶ personnes ──▶ noms ──▶ scènes
                    │                                                                          │
                    └──────────▶ son 16 kHz, canal central ──▶ voix ──▶ noms par les visages ◀──┘
                                                                  └──▶ lecture des lèvres (voix indécises)
```

| | |
|---|---|
| **Vitesse** | ≈ 16× le temps réel sur l'iGPU : un épisode 4K de 31 min refait de zéro en 114 s (16,8×, image et voix ; ~121 s avec la lecture des lèvres), trois épisodes 4K à la suite à 15,9× ; 9,8× pendant une transcodification de Jellyfin (inférence rendue au processeur) ; 13,7× (processeur) à 14,7× (iGPU) sur un épisode 1080p de 42 min — Core i7-8700, détails dans [PIPELINE.md](docs/PIPELINE.md#performances) |
| **Visages** | détecteur SCRFD quantifié en INT8 sur place, empreinte ArcFace ; noms par les photos TMDB et la mémoire de la série, un acteur par groupe |
| **Voix** | Silero VAD, WeSpeaker ResNet34 ; consensus de trois seuils ; ~2 répliques sur 3 nommées, **96 à 97 % justes** sur trois titres étiquetés à la main ; une voix hors champ au téléphone nommée sur quatorze |
| **Lecture des lèvres** | Light-ASD, seulement pour les voix indécises, plafonnée par élément : sur un film, 67,9 → 75,5 % des répliques nommées, toutes justes |
| **Toute une bibliothèque** | une médiathèque d'environ dix mille films et épisodes (~7 600 h de vidéo) → de l'ordre de 500 à 550 h de calcul, en fond, seulement quand personne ne regarde (estimation tirée des vitesses mesurées) |
| **Place** | ~1,7 Mo par épisode en base ; poids des modèles 180 Mo (+ voix et lèvres) |

---

## La documentation

| Document | Pour |
|---|---|
| Ce fichier | installer, brancher, mettre à jour, régler, dépanner ; licences et vie privée |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | la place du service : qui commande quoi et quand, les paliers de Laterna, l'ouvrier et ses priorités, Jellyfin, le stockage, les journaux, la sécurité |
| [docs/PIPELINE.md](docs/PIPELINE.md) | le traitement étape par étape avec ses seuils, les performances, la qualité mesurée, le calibrage, les limites |
| [docs/API.md](docs/API.md) | le contrat HTTP complet, le rapport de décision, les versions des résultats |

Les sections que les commentaires du code citent encore sous « README » ont déménagé : « Comment ça
marche », « Qui parle », « Lecture des lèvres », « Performances », « Calibrage » et « Limites connues » sont
dans [docs/PIPELINE.md](docs/PIPELINE.md) ; « Journaux et rapport d'analyse » dans
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#journaux-et-rapport-de-décision) (journal) et
[docs/API.md](docs/API.md#get-itemsitemidreport) (rapport) ; « Référence de l'API » dans
[docs/API.md](docs/API.md).

---

## Installation

Il faut Docker, le réseau Docker où vit Laterna (par exemple `media_net`), et la médiathèque.

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

   Au premier démarrage, le conteneur télécharge les poids des modèles (visages, voix, lèvres), les
   vérifie, puis produit le détecteur INT8 à partir d'images de votre médiathèque : quelques minutes,
   une fois. `/health` dit `ready: false` pendant ce temps.

Le service n'ouvre aucun port sur l'hôte : seul un conteneur du même réseau Docker l'atteint, à
l'adresse `http://laterna-xray:8000`. Il tourne sous un utilisateur sans privilège : l'uid 10001 de
l'image par défaut, ou celui choisi par `user:` ; ses données (base, poids des modèles, photos de
référence, journal) vivent dans le volume `xray_data`, qui doit appartenir à cet utilisateur (après un
changement de `user:`, un `chown -R UID:GID` du volume, fait une fois depuis un conteneur lancé en
root). Pour un dossier de l'hôte à la place du volume, le rendre accessible en écriture au même
utilisateur.

Pour construire l'image soi-même plutôt que de la tirer :

```sh
docker build -t laterna-xray:local --build-arg XRAY_COMMIT=$(git rev-parse --short HEAD) xray/
# les tests tournent pendant la construction ; XRAY_COMMIT nomme la version dans le journal et les rapports
```

---

## Brancher Laterna

Dans Laterna, **Configuration → Connexions**, carte « Acteurs à l'écran » :

1. choisir pour qui l'option est ouverte : `admins` pour commencer, puis `tous` ;
2. adresse du service : `http://laterna-xray:8000` ;
3. clé : la valeur de `XRAY_API_KEY`.

« Tester la connexion » lit `/health` et dit le modèle, s'il est prêt et si le décodage matériel
fonctionne. Laterna envoie ensuite les ordres lui-même — en priorité haute quand quelqu'un regarde, à
partir de la position de lecture — et, en fond, analyse toute la bibliothèque quand personne ne regarde
(Configuration → **Acteurs à l'écran** : progression, pause, liste de priorité, qualité des noms).

Les fonctions d'IA qui s'appuient sur l'analyse — « Jusqu'ici » et les questions — se règlent à part,
avec le fournisseur, la clé et le plafond mensuel des fonctions payantes (Configuration → Sous-titres
générés ; `ASK_ENABLED`, `ASK_PERSON_ENABLED`, `SOFAR_ENABLED`, voir le `ENV.md` de Laterna).

---

## Mettre à jour

```sh
docker compose pull && docker compose up -d       # image publiée
# ou : docker build -t laterna-xray:local xray/ && docker compose up -d
```

- **Les résultats déjà calculés restent servis.** Chacun garde la version de l'algorithme qui l'a produit
  ([docs/API.md](docs/API.md#versions-des-résultats)) ; rien n'est réanalysé de soi-même. Un ordre
  commencé sous une version antérieure et pas fini repart de zéro.
- **Les voix manquantes sont complétées sans relire l'image** : un élément analysé avant l'étape « qui
  parle » reçoit ses voix par une lecture du son seul, quand rien de plus pressé n'attend. De même après
  un changement de `XRAY_VOICE_MODEL`.
- **Les noms se refont sans décoder** : après une mise à jour qui change les règles de noms,
  `POST /relabel` (toute la bibliothèque, à basse priorité) suffit — voir
  [docs/PIPELINE.md](docs/PIPELINE.md#10-renommer-sans-relire).
- **Tout refaire** pour un élément : `DELETE /items/{id}` puis un nouvel ordre.
- **Changer de modèle de visages** (`XRAY_MODEL`) : les résultats existants restent lisibles (ils disent
  leur modèle) ; les photos de référence sont réanalysées avec le nouveau.
- Les poids déjà présents et vérifiés ne sont jamais retéléchargés ; le détecteur INT8 n'est refait que
  si son réseau d'origine, sa recette ou ses fichiers changent.

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
[docs/PIPELINE.md](docs/PIPELINE.md#performances)). Ce réseau quantifié dérive des poids non commerciaux : comme eux,
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

## Vie privée

- **Les empreintes biométriques restent sur votre serveur.** Empreintes de visages et de voix, photos de
  référence, votes de la lecture des lèvres : tout est dans le volume du service, rien n'est envoyé à un
  service en ligne. Laterna ne reçoit que des identifiants de personnes TMDB, des temps et des
  confiances — jamais une empreinte ni une image.
- **Seuls des acteurs crédités sont nommés** : un visage n'est comparé qu'à la distribution que Laterna
  fournit, et un visage anonyme n'est jamais renvoyé.
- **Rien ne sort** que les téléchargements des poids (au premier démarrage, depuis leurs publications
  officielles) et des photos de la distribution (`image.tmdb.org` seulement). Pas de télémétrie.
- **Le journal ne contient aucun secret** ni le contenu d'aucun fichier.
- Le détail (clé, chemins, poids piégés, contrôle parental côté Laterna) :
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#sécurité-et-vie-privée).

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

**Le service se fait discret** : une analyse à la fois (deux avec la [seconde voie](#voies-danalyse)) ; `nice 10` et `ionice` en classe basse
pour lui et le ffmpeg qu'il lance ; `XRAY_THREADS` fils de calcul (le quota du conteneur par défaut : inférence,
décodage et filtres de ffmpeg, OpenCV, calcul matriciel), plus `XRAY_VOICE_THREADS` (2) pour la voix
et `XRAY_ASD_THREADS` (2) pour la lecture des lèvres ; et, dans l'exemple de composition, `cpus: 6`
(4 pour l'image, 2 pour les voix) et `mem_limit: 4g`.

Combien de fils ? Autant que de cœurs qu'on veut bien lui céder, et pas plus que `cpus:` dans la
composition (en comptant les fils de la voix) : au-delà, les fils se disputent les mêmes cœurs et tout
ralentit. Sur un processeur
à 6 cœurs / 12 fils qui sert aussi Jellyfin, `XRAY_THREADS=8` et `cpus: 8` laissent quatre fils au
reste ; sur 4 cœurs, 3 ; sur une machine partagée avec d'autres services lourds, 4. Le service
restant en priorité basse, il cède de toute façon le processeur à ce qui en demande.

---

## Voies d'analyse

Pendant une analyse sur l'iGPU, l'iGPU est plein et le processeur reste aux trois quarts libre. Une
**seconde voie** peut employer ce reste : la **voie A** est le chemin de toujours (VA-API et inférence sur
l'iGPU, repli sur le processeur pendant une transcodification de Jellyfin) ; la **voie B** analyse un
*autre* élément sur le processeur seul — exactement le chemin de repli de la voie A (décodage par ffmpeg,
détecteur INT8 et empreinte sur le processeur).

**Règles.** La voie A prend la tête de la file, comme avant. La voie B ne prend un ordre `normal` ou `low`
que pendant que la voie A en analyse déjà un, dans l'ordre de la file, jamais le même élément, et
seulement un fichier de 1080p au plus (`XRAY_LANE_B_MAX_PIXELS`) : un épisode 4K HEVC décodé sur le
processeur y passait à 3× le temps réel et ralentissait la voie A. Un ordre `high` va toujours à la voie A
(qui cède entre deux tronçons) ; un élément de la voie B devenu `high` lui est rendu. Pendant une
transcodification de Jellyfin, la voie B s'arrête à la fin de son tronçon (l'élément retourne en file,
`lane_pause` / `lane_resume` au journal) : le processeur n'est jamais demandé deux fois. Chaque voie a
son moteur, son fil des voix et son drapeau d'annulation ; chaque ligne du journal porte sa voie (`lane`),
chaque tronçon aussi (rapport de décision : `devices.lanes`).

**Décision automatique** (`XRAY_LANES=auto`, le défaut), prise une fois au démarrage et écrite au
journal (`action: "lanes"`, avec ses entrées et sa raison), dans `/health` (`lanes`) et dans chaque
rapport : deux voies si l'inférence sur l'iGPU est demandée (`XRAY_OV_DEVICE=GPU`) et que l'iGPU est
là, que le quota de processeur du conteneur (`cpus:`, lu dans le cgroup — pas `nproc`) atteint 8 fils et
que la limite de mémoire (`mem_limit`) atteint 7 Gio ; une sinon. Sans iGPU, une voie : deux voies du
processeur se partageraient les mêmes cœurs. Si l'iGPU ne s'ouvre pas finalement, la voie B s'arrête et
le journal le dit. Fils : un tiers du budget à la voie B (4 sur 12), quelques-uns au ffmpeg de la voie A
sur l'iGPU (4), `XRAY_THREADS` (par défaut tout le budget) à la voie A quand elle calcule sur le
processeur — la voie B est alors arrêtée.

| Variable | Défaut | Rôle |
|---|---|---|
| `XRAY_LANES` | `auto` | `1` ou `2` : imposé, quelles que soient les ressources. |
| `XRAY_LANE_B_THREADS` | un tiers du budget | Fils de la voie B (inférence et ffmpeg). |
| `XRAY_LANE_A_DECODE_THREADS` | 4 à deux voies | Fils du ffmpeg de la voie A quand il décode sur l'iGPU. |
| `XRAY_LANE_B_MAX_PIXELS` | `2304000` (1920×1200) | Plus grande image que la voie B accepte. |

**Mesures** (10/11/2026, Core i7-8700 6 cœurs / 12 fils, UHD 630, `cpus: 12`, sans lecture des lèvres,
copies jetables de la base) :

| Lot | Une voie | Deux voies |
|---|---|---|
| 3 épisodes 1080p HEVC (2 h 29 min) | 429 s, **20,8×** | 406 s, **21,9×** (+6 %) ; pendant le recouvrement, voie A 15,7× + voie B 7,9× = 23,6× (+13 %) |
| 3 épisodes 4K HEVC (95 min), avant la limite de 1080p et avec 6 fils à la voie B | 358 s, **15,9×** | 581 s, **9,8×** : voie B à 3,3×, voie A ralentie de 16 à 12× |
| Processeur du conteneur (moyenne) | ~2,8 fils | ~6,8 fils |
| Mémoire (pic du cgroup, cache de fichiers compris ; usage relevé par `docker stats`) | 3,3 à 3,75 Gio ; 3,2 à 3,4 Gio | 4,9 à 5,05 Gio ; 4,6 à 4,8 Gio |

L'iGPU reste à sa fréquence maximale (1 200 MHz) dans les deux cas. Le gain est donc modeste sur un
processeur de 6 cœurs, où les deux voies se disputent les cœurs physiques : la voie A perd environ un
quart de sa vitesse, que la voie B ne rend qu'en partie. Il grandit avec le nombre de cœurs.

**Résultats.** Une voie ou l'autre applique les mêmes règles aux mêmes réseaux ; la voie B produit ce que
le repli de la voie A produit déjà, avec la même différence d'arithmétique (demi-précision et détecteur
d'origine sur l'iGPU, INT8 sur le processeur ; réduction `scale_vaapi` contre `scale`). Mesurée sur un
épisode 1080p de 53 min analysé par chacune, à mémoire de série identique : 843 plans contre 840 et 840
pistes contre 820 ; 35 bornes de scène sur 40 communes, 33 scènes au même casting ; les mêmes 36
personnes, mais une avec 820 s de présence au lieu de 575 ; 90,6 % des instants de parole au même nom.
Les éléments analysés par la voie A dans les deux passages sont, eux, identiques (scènes, casting, temps
de présence, voix).

---

## Réglages

### Le service

Variables d'environnement du conteneur `laterna-xray` (toutes facultatives sauf la clé) :

| Variable | Défaut | Rôle |
|---|---|---|
| `XRAY_API_KEY` | — | Clé partagée avec Laterna. **Vide : toutes les requêtes sont refusées.** |
| `XRAY_MODEL` | `buffalo_l` | `buffalo_l` ou `auraface` (voir plus haut). |
| `XRAY_THREADS` | budget du conteneur | Fils de calcul (inférence, décodage et filtres de ffmpeg) ; sans réglage, le quota de processeur du conteneur (`cpus:`). Voir [Accélération matérielle](#accélération-matérielle). |
| `XRAY_LANES` | `auto` | Voies d'analyse : `auto`, `1` ou `2`. Voir [Voies d'analyse](#voies-danalyse) (autres réglages là). |
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
| `XRAY_FRAME_WIDTH` | `640` | Largeur des images analysées (pixels). |
| `XRAY_SAMPLE_FPS` | `4` | Images échantillonnées par seconde. |
| `XRAY_CHUNK_SECONDS` | `120` | Longueur d'un tronçon. |
| `XRAY_FFMPEG`, `XRAY_FFPROBE` | `ffmpeg`, `ffprobe` | Programmes à lancer (ceux de jellyfin-ffmpeg dans l'image). |
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

### Côté Laterna

Réglés dans Laterna (Configuration, ou son `.env` ; détail dans son `ENV.md`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `XRAY_ENABLED` | `off` | Pour qui l'analyse est ouverte : `off`, `admins` (seules les séances d'administrateurs commandent, les autres comptes lisent `off`), `tous`. Le planificateur analyse toute la bibliothèque dans les deux cas. |
| `XRAY_URL` | `http://laterna-xray:8000` | L'adresse du service, vue du conteneur de Laterna. |
| `XRAY_API_KEY` | — | La même clé que le service. |
| `XRAY_LIBRARY_ROOTS` | `/media/movies,/media/tv` | `.env` seulement : les dossiers, tels que Jellyfin les voit, dont les fichiers peuvent être analysés. Tout le reste (téléchargements, seeds, livres) n'est jamais commandé. |
| `SOFAR_ENABLED`, `ASK_PERSON_ENABLED`, `ASK_ENABLED` | `off` (les deux premiers suivent le troisième quand ils sont vides) | Les fonctions d'IA de Laterna qui lisent l'analyse : « Jusqu'ici », les questions sur une personne, les questions sur un titre. Elles demandent aussi un fournisseur d'IA configuré. |

---

## Dépannage

Commencer par le journal et le rapport :

```sh
docker exec laterna-xray tail -n 50 /data/logs/xray.log | jq -c .           # le journal JSON
docker exec laterna-xray sh -c 'cat /data/logs/xray.log*' | jq -c 'select(.itemId=="<itemId>")'
docker exec laterna-xray python -c "import os,urllib.request as u; \
  r=u.Request('http://127.0.0.1:8000/items/<itemId>/report', headers={'Authorization':'Bearer '+os.environ['XRAY_API_KEY']}); \
  print(u.urlopen(r).read().decode())" | jq .                                    # le rapport de décision
```

| Symptôme | Où regarder |
|---|---|
| « Tester la connexion » échoue dans Laterna | Les deux conteneurs sur le même réseau Docker ; l'adresse `http://laterna-xray:8000` ; la même clé des deux côtés (`401` sinon). Une clé vide côté service refuse tout. |
| `ready: false` qui dure | Premier démarrage : téléchargement des poids puis production du détecteur INT8 (quelques minutes). `model.error` dans `/health` dit pourquoi (réseau, empreinte SHA-256 qui ne correspond pas — supprimer le fichier pour qu'il soit repris). |
| `inference.int8.state: "failed"` | Le service tourne en float32, plus lent. `models/buffalo_l/int8.failed.json` dit pourquoi ; le supprimer pour réessayer. Une médiathèque vide ou pas montée n'est pas notée : l'essai est refait au démarrage suivant. |
| Un ordre échoue sur « fichier introuvable » ou `400` « hors de la médiathèque » | Le montage n'est pas au même chemin que dans Jellyfin, ou l'utilisateur (`user:`) n'a pas le droit de lire le dossier (`770`, disques fusionnés). |
| `decode.vaapi: false` | `/dev/dri` absent du conteneur, mauvais numéro de groupe `render` (`group_add`), ou iGPU non Intel. Tout passe alors sur le processeur, plus lentement pour la 4K. |
| L'analyse est lente | `stats.stages` de `GET /items/{id}` (ou la partie `cpu` du rapport) dit où passe le temps. `decode_wait` élevé : film 4K HDR ou AV1, décodés en partie sur le processeur. `job_yield` répétés au journal : des ordres plus pressés passent devant. `cpus:` plus petit que `XRAY_THREADS` + `XRAY_VOICE_THREADS` : les fils se disputent les cœurs. |
| L'analyse « ne fait rien » | Avec `XRAY_SCAN_DURING_PLAYBACK=false`, Laterna ne commande rien de neuf pendant une lecture (Configuration → Acteurs à l'écran dit « en attente d'une lecture ») ; paliers en pause ; option coupée. Côté service, `queue` de `/health`. |
| Jellyfin transcode moins vite pendant l'analyse | `JELLYFIN_URL` et `JELLYFIN_API_KEY` posés ? Sans eux, le service ne sait pas que Jellyfin se sert de l'iGPU. Les bascules sont au journal (`gpu_guard`, `device_switch`). |
| Un acteur n'est jamais nommé | Absent de la distribution TMDB de l'épisode (figurant non crédité), photos TMDB rares ou anciennes, rôle maquillé. Le rapport (`faceClusters`) donne le meilleur candidat de chaque groupe anonyme et la raison (`doubt_band`, `runner_up_close`, `too_short`, `person_taken`, `no_reference`). |
| Une voix reste sans nom | Le rapport (`voices`) donne sa raison : `off_screen_no_candidate` (hors champ), `low_contrast` (toujours filmée avec les mêmes), `conflict_memory`, `second_big_voice`… ([docs/API.md](docs/API.md#raisons-dune-voix-sans-nom)). C'est le plus souvent voulu. |
| Une série nomme mal après une erreur ancienne | Configuration → Acteurs à l'écran → Qualité des noms → « Réinitialiser la mémoire » (`POST /series/{id}/memory/reset`) : la mémoire est effacée et la série renommée sans relire les fichiers. |
| Laterna montre « rien » pour un titre analysé | La route du lecteur répond `stale` quand le fichier a changé (autre ETag, durée différente) ; `none` pour un titre que le compte n'a pas le droit de voir ; l'option fermée à ce compte (`admins`) répond `off`. |
| Mémoire épuisée avec l'inférence sur l'iGPU | `XRAY_OV_DEVICE=GPU` demande ~3,3 Go : `mem_limit: 6g`. Sinon revenir à `CPU`. |

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
