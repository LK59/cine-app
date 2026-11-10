# X-Ray — le traitement, étape par étape

Ce document décrit ce que `laterna-xray` fait d'un fichier, dans l'ordre, avec les seuils du code et
les mesures qui les ont fixés. Pour la place du service dans l'installation, la file et le stockage :
[ARCHITECTURE.md](ARCHITECTURE.md) ; pour les routes : [API.md](API.md) ; pour l'installation :
[../README.md](../README.md).

Toutes les mesures citées ont été faites entre le 09 et le 10/11/2026 sur un Core i7-8700 (6 cœurs /
12 fils, iGPU UHD 630), avec le modèle `buffalo_l`, sur des fichiers d'une vraie médiathèque — souvent
sur une machine chargée par d'autres travaux, ce qui est dit à chaque fois.

---

## Sommaire

- [Vue d'ensemble](#vue-densemble)
- [0. Ce qui n'est pas analysé](#0-ce-qui-nest-pas-analysé)
- [1. Décodage](#1-décodage)
- [2. Plans](#2-plans)
- [3. Pistes de visages](#3-pistes-de-visages)
- [4. Personnes](#4-personnes)
- [5. Noms](#5-noms)
- [6. Mémoire des séries](#6-mémoire-des-séries)
- [7. Scènes](#7-scènes)
- [8. Qui parle](#8-qui-parle)
- [9. Lecture des lèvres ciblée](#9-lecture-des-lèvres-ciblée)
- [10. Renommer sans relire](#10-renommer-sans-relire)
- [Performances](#performances)
- [Qualité mesurée](#qualité-mesurée)
- [Calibrage](#calibrage)
- [Limites connues](#limites-connues)

---

## Vue d'ensemble

```
 fichier vidéo (médiathèque, lecture seule)
        │
        ▼
 ┌────────────────────────────┐  un seul ffmpeg par tronçon de 2 min, deux sorties :
 │ 1. décodage                │  image 640 px · 4 i/s (VA-API, images non référencées sautées,
 └─────┬────────────────┬─────┘  HDR adapté en SDR) — et son 16 kHz mono (canal central)
       │ image          │ son
       ▼                ▼
 ┌───────────────┐  ┌─────────────────────────┐
 │ 2. plans      │  │ 8a. parole (Silero VAD) │
 └──────┬────────┘  │     empreintes de voix  │  fil à part (XRAY_VOICE_THREADS)
        ▼           │     (1,5 s / 0,5 s)     │
 ┌───────────────┐  └───────────┬─────────────┘
 │ 3. pistes     │  détection SCRFD (INT8),  │
 │   de visages  │  tri, suivi, ArcFace      │
 └──────┬────────┘  sur les 2 meilleurs      │
        ▼                                    │
 ┌───────────────┐                           │
 │ 4. personnes  │  regroupement hiérarchique│
 └──────┬────────┘                           │
        ▼                                    │
 ┌───────────────┐  photos TMDB + mémoire    │
 │ 5–6. noms     │  de la série, hongrois    │
 └──────┬────────┘                           │
        ▼                                    ▼
 ┌───────────────┐            ┌──────────────────────────────┐
 │ 7. scènes     │───────────▶│ 8b. voix : morceaux, 3 seuils,│  qui est à l'image pendant
 └──────┬────────┘  présence  │ contraste avec les visages,   │  chaque voix
        │                     │ consensus, mémoire            │
        │                     └──────────────┬───────────────┘
        │                                    ▼
        │                     ┌──────────────────────────────┐  plus tard, à basse priorité,
        │                     │ 9. lecture des lèvres ciblée │  pour les seules voix indécises
        │                     └──────────────┬───────────────┘
        ▼                                    ▼
   /items/{id}/scenes                 /items/{id}/voices          + /items/{id}/report
```

Le **tronçon** de deux minutes (`XRAY_CHUNK_SECONDS`) est l'unité de travail : analysé, il est écrit en
base d'un seul bloc (plans, pistes avec leur empreinte, zones de parole, empreintes de voix). Un
redémarrage reprend au premier tronçon non fait. Après chaque tronçon, le résultat est **réassemblé**
(étapes 4 à 8b) : les scènes et les voix sont lisibles pendant l'analyse, sur ce qui est fait.

L'ordre des tronçons suit `startAt` : si quelqu'un lance l'épisode à la 25ᵉ minute, l'analyse commence
au tronçon qui contient cette position, avance jusqu'à la fin, puis revient au début.

---

## 0. Ce qui n'est pas analysé

Les génériques de début et de fin, les rappels (« précédemment ») et les bandes-annonces : Laterna peut
les donner dans l'ordre (`skip`, 32 plages au plus), sinon le service les demande à Jellyfin (ses
*segments* `Intro`, `Outro`, `Recap`, `Preview`, `GET /MediaSegments/{itemId}`) s'il y a accès ; `skip: []`
n'en saute aucun et ne consulte pas Jellyfin. Personne n'y cherche un acteur, et un générique défile
souvent sur des visages qui n'ont rien à faire dans les scènes. Mesuré : **66 à 101 s de moins par
épisode** ; rien sur un film sans segments Jellyfin.

---

## 1. Décodage

Chaque tronçon est décodé par ffmpeg — celui que livre Jellyfin (`jellyfin-ffmpeg`, avec son pilote Intel
iHD, embarqué dans l'image) —, réduit à **640 px de large** (`XRAY_FRAME_WIDTH`) et échantillonné à
**quatre images par seconde** (`XRAY_SAMPLE_FPS`) : assez pour placer une coupe à un quart de seconde près,
assez peu pour que la conversion en Python reste négligeable.

- **VA-API sur l'iGPU** quand il le sait : sur un Coffee Lake (UHD 630), H.264, HEVC Main et Main 10, VP9,
  VP8, MPEG-2, VC-1 ; **pas l'AV1** (arrivé avec Tiger Lake), ni le H.264 10 bits, ni le HEVC
  4:2:2/4:4:4. Sur l'iGPU, la réduction se fait sur la carte et seules les petites images reviennent en
  mémoire. Le reste — et tout tronçon où VA-API échoue, repris aussitôt — passe sur le processeur.
- **Images non référencées sautées** (`-skip_frame noref`, sur l'iGPU comme sur le processeur,
  `XRAY_VAAPI_NOREF`) : sur quatre images par seconde, le filtre prend la plus proche. Un tronçon 4K HEVC
  de 120 s se décode en **3,9 s au lieu de 9,4** sur l'iGPU.
- **HDR adapté en SDR** (PQ ou HLG, Dolby Vision à couche HDR10 compris) *après* la réduction, sur le
  processeur (`tonemapx`, propre à jellyfin-ffmpeg) : quatre petites images par seconde ne coûtent
  presque rien. Lu sans adaptation, le signal HDR donne une image délavée aux couleurs tassées, et des
  coupes passent inaperçues (voir [Calibrage](#calibrage)). `tonemap_vaapi` fonctionne sur l'UHD 630 mais
  rend une image trois fois plus sombre (luminance moyenne 14 contre 35 pour `tonemapx` sur la même
  image) : la carte décode et réduit, le processeur adapte.
- **Jellyfin garde la priorité sur l'iGPU** : avec `JELLYFIN_URL` et `JELLYFIN_API_KEY`, le service
  relit les sessions de Jellyfin avant chaque ordre et toutes les 30 s ; si l'une transcode avec
  l'accélération matérielle, le tronçon suivant est décodé sur le processeur.
- **Le son sort du même ffmpeg** (voir [8](#8-qui-parle)) : une seconde sortie dans un second tuyau
  (`pipe:<fd>`) ; le fichier n'est lu qu'une fois.
- Un ffmpeg que le service arrête lui-même une fois la plage lue n'est pas un échec (avant la v4, ce
  code de sortie −9 faisait reprendre le tronçon sur le processeur, voire échouer l'ordre).

Le décodage tourne dans un fil à part et précharge les images (`decode_wait` dans les statistiques :
le temps où l'analyse attend ffmpeg). Il reste négligeable sauf pour un film 4K HDR (adaptation sur le
processeur : 369 s d'attente sur *Bullet Train*, 2 h 07) et pour l'AV1, décodé sur le processeur.

---

## 2. Plans

Entre deux images successives, on compare les **histogrammes de couleurs** (luminance et chrominance,
32 × 16 × 16 cases) : une coupe change d'un coup les couleurs de l'image ; un mouvement de caméra
déplace l'image sans les changer.

| Écart d'histogramme | Décision |
|---|---|
| ≥ 0,30 | coupe |
| ≥ 0,15 et vignette brute de 32×18 qui change de plus de 0,12 | coupe |
| ≥ 0,10 et vignette **à contraste égal** (centrée, réduite) qui change de plus de 0,60 | coupe |
| sinon | même plan |

La vignette à contraste égal sert les décors sombres d'une seule teinte : un champ-contrechamp y
change peu les couleurs et la luminance, mais pas la forme de l'image. Couper trop souvent ne coûte
presque rien (les morceaux se recollent en scènes, étape 7) ; les seuils penchent donc vers la coupe.

Un **plan fixe** — aucune image ne s'écarte de la première de plus de 0,03 (vignette brute), 0,15
(contraste égal) et 0,06 (couleurs) — est reconnu : rien n'y entre ni n'y bouge assez pour changer qui
l'on voit (1 à 4 % des plans).

---

## 3. Pistes de visages

Dans chaque plan, **deux ou trois images** sont analysées — une de plus toutes les dix secondes pour
un plan long, six au plus ; **deux** pour un plan fixe, quelle que soit sa durée. Sur chaque image :

1. **Détection** des visages et de cinq points (yeux, nez, coins de la bouche) : SCRFD-10G avec
   `buffalo_l`, **quantifié en INT8 sur place** au premier démarrage (voir
   [../README.md](../README.md#modèles-et-licences)) ; YuNet avec `auraface`. Par lots de 8 images avec
   OpenVINO.
2. **Tri** : un visage trop petit (moins de 36 px de côté sur l'image de 640 px, `XRAY_MIN_FACE`), flou,
   ou de profil marqué compte comme une **présence**, mais ne sert pas à identifier. Les autres sont
   **alignés** sur le gabarit ArcFace de 112×112 px et notés (confiance, taille, netteté, frontalité).
3. **Suivi** : d'une image à l'autre du plan, les visages sont reliés en *pistes* par le recouvrement
   de leurs cadres (IoU ≥ 0,25).
4. **Empreinte** — un vecteur de 512 nombres, proche pour deux photos d'une même personne (ArcFace R50
   entraîné sur WebFace600K avec `buffalo_l`, AuraFace v1 avec `auraface`) :
   - seuls les **deux meilleurs visages** de chaque piste sont empreintés (`XRAY_FACES_PER_TRACK`) : la
     moyenne de deux bonnes vues vaut celle de trois ;
   - **par lots** de 32 visages (`XRAY_EMBED_BATCH`), de plusieurs plans à la fois ;
   - **sortie anticipée** dans une série : le meilleur visage d'une piste passe d'abord ; s'il ressemble
     très nettement à un personnage déjà nommé dans les épisodes précédents (similarité ≥ 0,60, avec
     0,25 d'avance sur le deuxième), le second n'est pas calculé. Mesuré : 215 pistes sur *MacGyver*
     S01E06, 100 sur *The Pitt* S02E01 s'arrêtent à un visage, noms et temps de présence identiques ;
   - **règle complète** pour un plan où le recouvrement seul ne suffit pas — un recouvrement moyen (0,25
     à 0,5) entre deux bons visages, ou deux pistes qui ne se montrent jamais sur la même image (un même
     visage a pu bouger) : tous ses bons visages empreintés, pistes refaites avec la ressemblance des
     empreintes (cosinus ≥ 0,45). 12 à 25 % des plans.

Chaque piste reçoit **une** empreinte, moyenne de ses visages empreintés pondérée par leur qualité, et
un **temps de présence** : la durée du plan multipliée par la part des images où elle apparaît (toutes
ses images comptent, empreintées ou non). C'est cette empreinte par piste qui est gardée en base — de
quoi tout refaire plus tard sans relire le fichier ([10](#10-renommer-sans-relire)).

---

## 4. Personnes

Toutes les pistes vues jusqu'ici sont regroupées par **classification hiérarchique** (lien moyen,
distance cosinus, coupée au seuil de regroupement : similarité 0,42 pour `buffalo_l`, 0,40 pour
`auraface`, `XRAY_CLUSTER_THRESHOLD`). Deux groupes fusionnent tant que leurs pistes se ressemblent *en
moyenne* ; le nombre de personnes n'a pas à être connu à l'avance. Le regroupement est refait à chaque
tronçon : plus il voit de pistes, meilleur il est. Depuis la v4 il est **incrémental** (`XRAY_INCREMENTAL`) :
identique à l'octet près au recalcul complet, 3 à 6 fois moins de calcul (≈ 25 s par assemblage sur un
film de 64 tronçons et ~3 000 pistes avant).

---

## 5. Noms

Chaque groupe est comparé à chaque acteur de la **distribution fournie par Laterna** — celle de
l'épisode (rôles crédités puis invités) ou du film, d'après TMDB, avec jusqu'à 12 photos par personne
(Laterna en envoie 8 au plus).

1. **Les photos de référence** sont téléchargées une fois (adresses `https://image.tmdb.org/`
   seulement), leur visage détecté et leur empreinte gardée en base (`photo_emb`) ; une photo sans
   visage exploitable est notée et jamais retentée.
2. **La note** d'un couple groupe × acteur est la moyenne de ses **trois meilleures similarités** avec
   les photos de l'acteur : une photo ratée ne compte pas, une seule photo flatteuse ne suffit pas.
3. **Trois bandes**, relatives au seuil de rejet *T* (0,30 pour `buffalo_l`, 0,28 pour `auraface`,
   `XRAY_LABEL_THRESHOLD`) :

   | Note | Décision |
   |---|---|
   | ≥ *T* + 0,10 | nom **sûr** |
   | *T* + 0,045 à *T* + 0,10 | **à confirmer** : nommé seulement si le deuxième acteur le plus ressemblant est 0,15 au moins derrière **et** si le groupe a été vu 2 s ou sur 2 pistes |
   | < *T* + 0,045 | anonyme |

4. **Un à un** : l'**algorithme hongrois** attribue au plus un groupe par acteur parmi les couples
   acceptables, en maximisant la somme des notes.
5. **Seconde passe** : un acteur filmé sous deux jours très différents peut former deux groupes ; le
   second rejoint le premier s'il ressemble nettement à l'acteur *et* au groupe déjà nommé (marge 0,10),
   ou s'il tombe dans la bande « à confirmer » et en remplit les conditions — jamais s'il a été vu moins
   d'une seconde.

La **confiance** renvoyée vaut 0,5 au seuil et approche 1 quand la ressemblance le dépasse nettement.
**Personne n'est nommé au hasard** : un visage n'est comparé qu'aux acteurs de la distribution, et un
groupe anonyme n'est jamais renvoyé. Le rapport de décision dit, pour chaque groupe resté anonyme, son
meilleur candidat et pourquoi (`doubt_band`, `runner_up_close`, `too_short`, `person_taken`,
`no_reference`).

---

## 6. Mémoire des séries

Pour un épisode (`seriesId`), les visages et les voix nommés avec assurance dans les **autres épisodes**
servent aussi de référence : ils ressemblent davantage à l'image de la série qu'un portrait posé.

- **Une contribution par épisode et par personne** (table `series_memory` : épisode, date, poids, note),
  pour chaque genre (`face`, `voice`) ; la mémoire est leur moyenne pondérée. Refaire un épisode
  **remplace** sa contribution, jamais ne l'ajoute.
- **Bornée** : un épisode pèse au plus 300 s de visage et 60 morceaux de voix par personne, et
  15 personnes.
- **Seulement ce qui est sûr et vient d'une source indépendante** : un visage nommé par les **photos**
  avec une marge de 0,10 et 5 s de présence ; une voix nommée par les **visages** (8 morceaux au moins,
  deux personnes trop proches écartées). La mémoire ne se nourrit jamais de ses propres conclusions, ni
  des voix nommées par la lecture des lèvres.
- **Auditable et réinitialisable** : `GET /series/{id}/memory` liste les contributions ;
  `POST /series/{id}/memory/reset` les efface puis renomme la série. Côté Laterna : Configuration →
  Acteurs à l'écran, carte « Qualité des noms », « Réinitialiser la mémoire ».
- **L'ordre compte** : Laterna fait passer les épisodes d'une série dans l'ordre de la série, puis
  **renomme une fois** la série entière quand tout son plan est traité : ses premiers épisodes profitent
  alors de la mémoire de toute la série.

---

## 7. Scènes

Un plan **rejoint la scène en cours** s'il ressemble par ses couleurs (≥ 0,72) à l'un de ses **quatre
derniers plans** — un dialogue filmé en champ-contrechamp alterne A, B, A, B —, ou s'il montre quelqu'un
qu'on vient d'y voir dans un décor encore voisin (≥ 0,45). Puis :

- **Durée minimale** : une scène de moins de **10 s** est fondue dans sa voisine la plus proche…
- … **sauf une rafale** : plusieurs scènes courtes qui se suivent, 10 s ensemble au moins, dont les
  personnes sont pour **60 %** au moins absentes de la minute voisine de chaque côté, restent une scène
  (un autre lieu, monté en plans brefs que les couleurs ne relient pas). *Ted Lasso* S01E09 : la
  conférence de presse (320–349 s) était fondue morceau par morceau dans le vestiaire (238–320 s), les
  deux décors, sombres, se ressemblant à 0,9 par les couleurs.
- **Durée maximale** : une scène de plus de **180 s** est recoupée à sa frontière de plans la plus faible
  (couleurs les moins semblables, de préférence là où les personnes changent du tout au tout dans la
  minute de part et d'autre), sans laisser de morceau de moins de **30 s** : un décor uniforme — des
  urgences toutes en bleu-vert — enchaînait sinon des scènes de douze minutes.

Pour chaque scène, les personnes nommées sont triées par **temps de présence**, avec leur confiance.
Les scènes sont regroupées à neuf à chaque assemblage depuis les plans gardés en base.

**Pourquoi c'est important pour Laterna** : la rangée « À l'écran » montre la scène de l'instant, et
« Jusqu'ici » coupe ses sources au début de la scène en cours et groupe les répliques par scène. Une scène
qui mêle deux fils montés en alternance fait prêter à un personnage ce qui se passe dans l'autre fil :
la séparation des scènes passe avant la vitesse.

---

## 8. Qui parle

Pour chaque segment de parole : quelle voix, et — quand c'est sûr — à quelle personne de la distribution
elle appartient. Laterna aligne ses répliques de sous-titres sur ces segments par les temps (n'importe
quelle langue de sous-titres convient) et fait précéder d'un nom celles dont la voix est sûre.

### 8a. Pendant l'analyse de l'image

1. **La piste** : la **version originale** — la langue d'origine du titre, que Laterna envoie
   (`originalLanguage`, d'après TMDB) ; sinon une piste dite « VO » / « original » par son titre ou
   marquée comme telle ; sinon la piste par défaut ; sinon la première. **Jamais un commentaire ni une
   audiodescription.** `XRAY_VOICE_TRACK=default` prend d'office la piste par défaut.
2. **Le son** : 16 kHz mono, **le canal central seul** quand la piste en a un (`pan=mono|c0=FC` : c'est là
   que sont les dialogues, sans la musique ni les effets), sinon un mélange mono — la seconde sortie du
   ffmpeg de l'image.
3. **Silero VAD** (v6.2) trouve les zones de parole.
4. **Une empreinte de voix par fenêtre de 1,5 s, tous les 0,5 s**, dans ces zones (80 bandes de Mel à la
   Kaldi, 25 ms / 10 ms) : **WeSpeaker ResNet34-LM** (défaut) ou **CAM++** (`XRAY_VOICE_MODEL`). Le tout
   dans un fil à part (`XRAY_VOICE_THREADS`, 2 par défaut) pendant que l'image avance ; écrit en base
   tronçon par tronçon, empreintes en demi-précision (~0,7 Mo par épisode).

### 8b. L'assemblage des voix (à chaque point d'étape, et à la fin avec les visages complets)

```
 fenêtres de voix ──▶ morceaux de 2 s ──▶ voix, à trois seuils ──▶ noms par contraste ──▶ consensus ──▶ mémoire
                     (coupés aux          0,65 · 0,70 · 0,75      avec les visages,       2 seuils     (série)
                      changements                                 seconde chance,         sur 3
                      de voix)                                    une personne = une voix
```

1. **Morceaux** : chaque zone de parole est coupée là où la voix change (deux fenêtres voisines sans
   recouvrement à plus de 0,5 de distance cosinus), puis en morceaux de **2 s** au plus — l'unité qui
   reçoit une voix.
2. **Voix** : les morceaux sont regroupés (lien moyen, cosinus) **à trois seuils** — 0,65, 0,70, 0,75.
3. **Noms, par contraste local avec les visages** (pour chaque seuil) : pour une voix et une personne,
   sa présence à l'image pendant cette voix, **moins** sa présence pendant les autres voix des mêmes
   scènes. Une voix n'est nommée qu'avec au moins 3 morceaux, un contraste ≥ 0,10, une marge ≥ 0,06 sur
   le deuxième et une présence ≥ 0,3.
4. **Seconde chance** : une personne prise par une autre voix nettement différente est écartée, et le
   candidat suivant considéré.
5. **Une personne, une voix** : une seconde grosse voix (20 morceaux et plus) nettement différente de la
   principale reste sans nom — une voix au téléphone ne reçoit pas le nom du seul visage à l'écran.
6. **Seconde passe** morceau par morceau contre le profil de chaque personne nommée.
7. **Consensus** : un morceau ne garde un nom que si **deux seuils sur trois** au moins le donnent, et
   aucun autre nom. `confidence` = part des avis, réduite quand le morceau ressemble peu à la voix de la
   personne.
8. **Petites voix** : moins de 3 morceaux, jamais nommée ; de 3 à 5, seulement avec une confiance ≥ 0,75
   (une voix de 3 morceaux mêlant deux personnes était nommée à 0,667).
9. **Mémoire de la série** (genre `voice`) : elle nomme une voix que les visages laissent sans nom ; **si
   elle contredit les visages de l'épisode, la voix reste sans nom** et le segment le dit
   (`conflict: true`).

Chaque voix sans nom reçoit une **raison** dans le rapport de décision (de la plus décisive à la
moins) : `conflict_memory`, `too_few_lines`, `small_voice_low_conf`, `second_big_voice`, `no_consensus`,
`asd_memory_conflict`, `asd_anonymous_face`, `asd_too_few_votes`, `asd_split_votes`,
`off_screen_no_candidate`, `low_contrast`, `undecided` (sens détaillé : [API.md](API.md#raisons-dune-voix-sans-nom)).

### 8c. Un ordre fini avant l'étape des voix

Un résultat v4 (antérieur à « qui parle ») n'est pas réanalysé : quand rien de plus pressé qu'un ordre
`low` n'attend, l'ouvrier lit **le son seul** des tronçons qui manquent (bien moins cher que l'image) et
prend les visages en base. De même pour des tronçons dont les réseaux de la voix n'étaient pas encore
prêts, et après un changement de `XRAY_VOICE_MODEL`.

### 8d. Côté Laterna : quand une réplique reçoit un nom

Laterna n'utilise les voix que d'une analyse **complète** (`complete: true`) du même fichier. Une réplique
reçoit « Nom : » seulement si une même voix nommée en couvre au moins **60 %** (élargie de 0,15 s de chaque
côté) et que c'est la voix qui en couvre le plus, avec une confiance ≥ 0,6, sans désaccord, jamais pour
une réplique à deux voix (un tiret en tête d'une ligne après la première) ; et une réplique de moins de
**1,1 s** n'est pas nommée quand le segment de la voix gagnante couvre aussi au moins la moitié de la
réplique d'avant ou d'après (l'analyse découpe la parole en tronçons de plus d'une seconde : une réponse
brève disparaît dans le segment de celui qui parle avant ou après).

---

## 9. Lecture des lèvres ciblée

Le contraste avec les visages ne départage pas deux personnes **toujours filmées ensemble** : leur
présence est la même pendant les deux voix. Après les voix, à basse priorité, le service regarde **qui
bouge les lèvres** — seulement là où cela peut servir, car c'est cher.

1. **Quelles voix** : les voix indécises (au seuil du milieu) d'au moins 4 morceaux, ni nommées ni en
   désaccord. Leurs **candidats** : les deux ou trois personnes les plus présentes pendant elles (15 % au
   moins). Une voix sans candidat à l'image (téléphone, narration) n'est pas lue, ni un morceau où plus de
   quatre personnes sont à l'image (une foule), ni une voix déjà nommée.
2. **Quels instants** : dix de ses morceaux au plus où un candidat est bien visible (la moitié du
   morceau), à 3 s au moins l'un de l'autre, élargis de 0,4 s, voisins joints (12 s au plus).
3. **Chaque fenêtre** est décodée à **25 images par seconde avec son son**, dans le même ffmpeg, sans
   sauter d'image (sur l'iGPU quand il s'y prête et que Jellyfin ne s'en sert pas). Visages détectés une
   image sur cinq par le détecteur de l'analyse (32 px au moins), suivis par recouvrement, boîtes
   interpolées ; chaque piste prend le nom du groupe de visages nommé le plus proche (0,30).
   **Light-ASD** note chaque image de chaque piste (MFCC du son, visage en niveaux de gris 112×112),
   exécuté par **OpenVINO** : le fichier de poids PyTorch est lu **sans PyTorch** par un *unpickler*
   restreint, et le réseau reconstruit est identique à l'original à 2,4·10⁻⁶ près sur la note.
4. **Un vote par morceau** : la piste la plus « parlante » (note moyenne), gardé en base par instants
   (`asd_votes`).
5. **Les voix sont refaites** : une voix encore sans nom prend celui que ses votes désignent — **3 votes au
   moins, 70 % des votes exprimés**, un vote comptant si la note du gagnant est positive. **Jamais contre
   la mémoire de la série** : si elle préfère nettement quelqu'un d'autre (0,1 de cosinus), la voix
   reste sans nom (`conflict`). Les segments ainsi nommés portent `via: "asd"`.

**Plafond** : `XRAY_ASD_BUDGET_S` secondes de processeur par élément (ffmpeg compris, 600 par défaut) ;
au-delà, ce qui est lu compte, le reste reste indécis. Entre deux fenêtres, l'ouvrier cède la place à un
ordre `normal` ou `high` et reprend plus tard où il en était. Les votes sont gardés à travers les
renommages : ils sont rattachés aux morceaux du moment par leurs instants.

---

## 10. Renommer sans relire

Tout ce qui coûte est gardé : plans, empreintes des pistes de visage, zones de parole, empreintes des
fenêtres de voix, votes des lèvres. `POST /items/{id}/relabel`, `/series/{id}/relabel` (dans l'ordre des
épisodes) et `/relabel` (toute la bibliothèque) mettent des éléments en file ; l'ouvrier refait
**seulement** les étapes 4 à 9 sans décodage (regroupement et noms des visages, scènes, puis voix), avec
les seuils du code et la mémoire de la série du moment, par lots de 20 s au plus, jamais devant un ordre
`normal` ou `high`. Le résultat est le même qu'une analyse neuve sur les mêmes données
(`tests/test_relabel.py`).

C'est ce qui permet de changer une règle de noms, de réinitialiser la mémoire d'une série ou d'ajouter
des épisodes à une série sans relire un seul fichier.

---

## Performances

### Vitesse

| Mesure | Résultat |
|---|---|
| *Ted Lasso* S01E09 (4K HEVC, 31 min) refait de zéro, image et voix, service complet (10/11/2026) | 114 s d'ordre (112 s de calcul), **16,8×** ; 16 tronçons sur 16 décodés en VA-API, inférence sur l'iGPU ; ~121 s avec la lecture des lèvres |
| *Ted Lasso* S01E10 (4K, 34 min) pendant une transcodification forcée de Jellyfin (10/11/2026) | 208 s, **9,84×** ; 88 % des appels d'inférence sur l'iGPU (rendue au processeur le temps de la transcodification), aucun échec |
| *Ted Lasso* S01E08 à S01E10 (4K, 95 min) à la suite, une voie (10/11/2026) | 358 s, **15,9×** (110, 115 et 132 s par épisode) ; deux voies : voir [Voies d'analyse](../README.md#voies-danalyse) |
| *MacGyver* S01E06 (HEVC 1080p, 42 min), v4, processeur, `XRAY_THREADS=10` | 187 s, **13,7×** (relancé plus chargé : 239 s, 10,7×) |
| Le même, v4, inférence sur l'iGPU | 173 s, **14,7×** |
| Le même, v3 (avant les optimisations du 09/11 au soir) | 369 s, 6,9× |
| Voix seules (i7-8700, 2 fils) | 0,065 s de calcul par seconde d'épisode, 0,046 par seconde de film ; ~2 min de calcul (~65 s de mur) pour un épisode de 30 min |
| Lecture des lèvres | 1,2 à 1,4 s de calcul par seconde de vidéo lue ; 13 à 162 s par élément sur les titres mesurés ; Light-ASD seul : 2,5 ms par image et par visage |
| Premier tronçon (celui de `startAt`) | prêt en moins d'une minute |

Les versions v3 → v4 sur *MacGyver* S01E06 (machine chargée, charge moyenne 9 à 30 pour 12 fils, d'où
des écarts d'un passage à l'autre) :

| Version | Durée | Détection | Empreinte | Assemblage | Charge |
|---|---|---|---|---|---|
| v3 (avant) | 369 s, **6,9×** | 246 s (102 ms/image) | 93 s (1 091 visages) | 2,3 s | 13 → 23 |
| v4, processeur | 187 s, **13,7×** | 105 s (44 ms/image) | 62 s (1 085 visages) | 1,2 s | 9 → 15 |
| v4, processeur, relancé plus chargé | 239 s, **10,7×** | 150 s (62 ms/image) | 68 s (850 visages*) | 1,7 s | 17 → 28 |
| v4, iGPU (`XRAY_OV_DEVICE=GPU`) | 173 s, **14,7×** | 113 s (47 ms/image) | 32 s (859 visages*) | 2,3 s | 21 → 30 |

\* la mémoire de série était remplie par le passage précédent : moins de visages à empreinter. Les mêmes
8 personnes nommées dans les quatre passages ; temps de présence à 9 s près au plus par personne (sur
100 à 650 s), 51 scènes au lieu de 52.

### Ce que chaque mesure a apporté

| Mesure | Avant | Après | Effet sur le résultat |
|---|---|---|---|
| OpenVINO au lieu d'ONNX Runtime | empreinte 324 ms par visage | 210 ms | identique (cosinus ≥ 0,99999) |
| Lots (empreinte par 32, détection par 8) | 210 à 320 ms par visage | 140 à 170 ; détection −25 à 30 % par image | boîtes à 10⁻⁴ px, cosinus ≥ 0,9999998 |
| Deux meilleurs visages par piste | — | −8 % d'empreintes | identique |
| Images non référencées sautées sur l'iGPU | 9,4 s par tronçon 4K HEVC de 120 s | 3,9 s | une image voisine échantillonnée : résultats v4 |
| Détecteur INT8 | 39,5 / 43,6 / 27,6 ms par image (*MacGyver*, *The Pitt*, *Bullet Train*) | 22,4 / 26,2 / 16,6 ms | 72/72, 136/137, 73/74 visages retrouvés (les manqués sous 36 px) |
| Assemblage incrémental | ~25 s sur un film de 64 tronçons | 3 à 6 fois moins | identique à l'octet près |
| Inférence sur l'iGPU (option) | 4,7 images/s + 19,0 visages/s, ~200 ms de processeur par image | 8,7 + 34,8, 8 ms de processeur | cosinus ≥ 0,9994 ; 3,3 Go de mémoire |
| Génériques sautés | — | 66 à 101 s de moins par épisode | — |

Écartés après mesure : le suivi entre images (détection sur une image analysée sur N, les autres portées
par flot optique ou redétection locale), `antelopev2` (empreinte R100 sur Glint360K) et l'empreinte en
INT8 (mesurée inutilisable).

### Où passe le temps

*MacGyver* S01E06, secondes (`stats` de `GET /items/{id}`), avant et après le passage à OpenVINO et aux
lots (premier banc du 09/11, machine très chargée) :

| Étape | Avant | Après |
|---|---|---|
| Détection | 396 (157 ms/image, 2 513 images) | 288 (120 ms/image, 2 405 images) |
| Empreinte | 284 (232 ms/visage, 1 223 visages) | 79 (90 ms/visage, 876 visages) |
| Attente du décodage | 25 | 11 |
| Plans (coupes) | 15 | 13 |
| Regroupement, noms, scènes | 2,3 | 1,9 |
| Photos de la distribution | 1,9 | 2,5 |

Détection et empreinte font l'essentiel ; le décodage ne pèse que pour un film 4K HDR et pour l'AV1.

### Processeur ou iGPU

| | Processeur | iGPU (`XRAY_OV_DEVICE=GPU`) |
|---|---|---|
| Débit des réseaux (UHD 630) | 4,7 images/s + 19,0 visages/s | 8,7 images/s + 34,8 visages/s |
| Processeur par image | ~200 ms | 8 ms |
| Mémoire | sous 1,5 Go (1,2 Go relevé) | ~3,3 Go au pic (`mem_limit: 6g`) |
| Effet sur une transcodification de Jellyfin en cours | −8 % de vitesse | −39 % — d'où la bascule automatique sur le processeur pendant qu'il transcode |

### Toute une bibliothèque

Une **estimation**, pas une mesure : le plan relevé le 09/11/2026 sur une médiathèque d'environ dix mille
éléments comptait 402 éléments (351 h) au palier 1, 586 (479 h) au palier 2 et 8 020 (6 746 h) au palier
3, l'animation écartée — environ **7 600 h de vidéo**. À 13,7 à 15 fois le temps réel, cela fait
**environ 500 à 550 h de calcul**, soit trois semaines de fond continu ; en pratique davantage, puisque le
fond s'arrête pendant chaque lecture. La page Configuration → Acteurs à l'écran donne la vitesse réelle
(moyenne des trente derniers éléments finis) et le temps restant.

### Place

Un épisode occupe environ **1 Mo** en base pour les visages (une empreinte par piste) et ~0,7 Mo pour les
voix. Poids : `buffalo_l` 180 Mo, `auraface` 260 Mo, l'IR INT8 du détecteur 5 Mo. Le journal : 30 Mo au plus.

---

## Qualité mesurée

### Visages

Jugé sur planches d'images (*MacGyver* S01E06, *The Pitt* S02E01, *Bullet Train*, *Ted Lasso* S01E10) :
voir [Calibrage](#calibrage). Dans chaque cas jugeable entre 0,345 et 0,40 de note, le groupe resté
anonyme sous l'ancienne règle était bien l'acteur ; les noms donnés sous 0,345 ne tenaient pas — d'où la
bande « à confirmer ». Entre versions, les mêmes personnes sont nommées (8 sur 8, 35 sur 35, 28 sur 28 sur
les trois titres du premier banc), avec des temps de présence à quelques secondes près.

### Voix (« qui parle »)

Trois titres étiquetés à la main, réplique par réplique : *Ted Lasso* S01E08 (416 répliques),
*MacGyver* S01E06 (426), *Bullet Train* (120, dont 14 voix hors champ au téléphone — la seule bonne
réponse y est « sans nom »). « Nommé » : part des répliques étiquetées auxquelles la règle de Laterna
([8d](#8d-côté-laterna--quand-une-réplique-reçoit-un-nom)) donne un nom ; « précision » : part de ces noms
qui sont justes. Calculé par le service lui-même, son seul, sur une copie de la base.

**Le choix du modèle** (version originale) :

| | *Ted Lasso* | *MacGyver* | *Bullet Train* | Ensemble | Voix au téléphone nommées |
|---|---|---|---|---|---|
| WeSpeaker ResNet34-LM | 69,5 % / 96,9 % | 63,4 % / 97,4 % | 67,9 % / 100 % | **66,6 % / 97,5 %** | 1 / 14 |
| + mémoire de la série (E09 → E08) | **77,6 % / 96,3 %** | — | — | | |
| CAM++ | 75,7 % / 95,6 % | 60,3 % / 94,2 % | 53,8 % / 100 % | 66,4 % / 95,4 % | 0 / 14 |
| + mémoire de la série | 77,2 % / 95,6 % | — | — | | |

WeSpeaker est retenu : même part nommée, meilleure précision et meilleur *Bullet Train* (un film : pas de
mémoire). CAM++ coûte 40 % de calcul en moins.

**La stabilité** — le défaut d'un seuil unique : un seuil qui scinde ou fusionne une voix change tout. En
déplaçant les seuils de ± 0,05 :

| | seuil 0,65 | seuil 0,70 | seuil 0,75 |
|---|---|---|---|
| un seul seuil | 52,1 % / 93,9 %, 11 téléphones nommés | 66,4 % / 94,3 %, 10 | 66,4 % / 94,4 %, 10 |
| consensus de trois seuils (centré sur) | 62,7 % / 97,3 %, 2 | 66,6 % / 97,5 %, 1 | 66,6 % / 97,3 %, 1 |

**Petites voix et lecture des lèvres** (10/11/2026, copie de la base de production, mêmes vérités de
terrain, mémoire de la série telle qu'en production pour *Ted Lasso*) :

| | *Ted Lasso* E08 | *MacGyver* E06 | *Bullet Train* | Ensemble | Hors champ nommés |
|---|---|---|---|---|---|
| avant (voix v1) | 88,5 % / 94,8 % | 65,3 % / 97,5 % | 67,9 % / 100 % | 75,7 % / 96,4 % | 1 / 14 |
| petites voix à 0,75 | 88,0 % / 95,1 % | 64,8 % / 97,5 % | 67,9 % / 100 % | 75,3 % / 96,5 % | 1 / 14 |
| + lecture des lèvres | 88,0 % / 95,1 % | 64,8 % / 97,5 % | **75,5 % / 100 %** | **76,2 % / 96,5 %** | 1 / 14 |

Les 10 répliques nommées par la lecture des lèvres sont toutes justes ; une note de vote abaissée à −0,5
nommait 9 voix de téléphone de plus — le seuil reste à 0. Sur *Ted Lasso* et *MacGyver*, les voix qui
restent indécises sont pour l'essentiel **des mélanges** (une voix de 27 morceaux dont les votes se
partagent entre deux personnes) : les votes refusent, à raison, de les nommer. Lire plus de voix (seuil de
3 morceaux, 15 morceaux par voix) ne nomme rien de plus.

**La règle des répliques courtes** (Laterna 10.30.1), relue ligne à ligne sur *Ted Lasso* S01E09 : 337
répliques nommées sur 546, dont 5 fausses — toutes d'environ une seconde, avalées par le segment de
l'interlocuteur. Avec la règle : 321 nommées, aucune des cinq, précision 100 % (98,5 % avant), couverture
61,7 → 58,8 %. Sur les trois vérités de terrain, rejouées côté Laterna : précision 96,4 → 97,0 %,
couverture 72,6 → 70,6 %.

**La piste** : sur *Ted Lasso*, le doublage français (voix de studio, un comédien par rôle) se nomme mieux
que la version originale (88,5 % contre 69,5 %) ; sur *Bullet Train*, c'est l'inverse (50,0 % contre
67,9 %). Le défaut reste la version originale.

En résumé : **environ deux répliques sur trois reçoivent un nom, et 96 à 97 % de ces noms sont justes** ;
le reste est laissé sans nom plutôt que deviné.

---

## Calibrage

Mesuré le 09/11/2026 sur trois titres, `buffalo_l` : *MacGyver* (2016) S01E06 (HEVC 1080p SDR), *The Pitt*
S02E01 (HEVC 1080p SDR), *Bullet Train* (2022, HEVC 4K HDR10), puis *Ted Lasso* S01E10 (HEVC 4K Dolby
Vision / HDR10). Les groupes douteux ont été jugés sur planches d'images.

**Noms.** Version 1 : seuil 0,30 en première passe, 0,40 en seconde passe. Dans chaque cas jugeable entre
0,345 et 0,40, le groupe resté anonyme était bien l'acteur — couché (0,37), masqué (0,386), sous chapeau et
lunettes (0,349), de dos à demi (0,386) — et le deuxième acteur le plus ressemblant n'y dépassait jamais
0,25 (écart de 0,17 à 0,30). Les noms donnés sous 0,345 ne tenaient pas : 0,31 pour une seconde d'image,
0,33 sur 12 s ; ni un quatrième groupe d'un même acteur vu une demi-seconde. Recalcul hors ligne des mêmes
pistes (version 1 → 3) :

| Titre | Groupes nommés | Personnes | Temps nommé | Changements |
|---|---|---|---|---|
| MacGyver S01E06 | 9 → 9 | 9 → 8 | 1 507 → 1 508 s | + un groupe d'un acteur couché ; − un invité à 0,31 (1 s) |
| The Pitt S02E01 | 35 → 38 | 34 → 34 | 2 273 → 2 318 s | + deux actrices (masquée, de profil, 19 s et 22 s), + un second groupe |
| Bullet Train | 33 → 40 | 25 → 24 | 3 754 → 3 803 s | + 8 groupes d'acteurs déjà nommés ; − un nom à 0,33, − une demi-seconde |

**Scènes.** Version 1 sans durée maximale : *The Pitt* avait des scènes de 775 s et 703 s (trois au-delà de
300 s). Recalcul sur les mêmes plans :

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

L'adaptation seule ne suffit pas : dans le bureau sombre de *Ted Lasso*, un champ-contrechamp change les
couleurs de 0,10 à 0,27 et la luminance brute de 0,05 à 0,12 — sous les seuils d'origine —, mais à
contraste égal ces coupes s'écartent de 0,65 à 1,0, quand deux images d'un même plan ne dépassent pas
0,49 dans ce décor. Un épisode y était découpé en un plan par tronçon de deux minutes. Couper un peu plus
souvent ailleurs (*MacGyver*, +18 %) ne coûte presque rien : les morceaux se recollent en scènes.

**INT8.** Le détecteur quantifié n'est gardé que s'il retrouve, sur 224 images de la médiathèque, au
moins 95 % des visages identifiables du réseau d'origine sans en inventer plus de 5 % (au banc : 72/72,
136/137, 73/74 — les manqués sous 36 px ; au premier démarrage d'une installation : 181/184 en 150 s, 69 →
38 ms par image).

---

## Limites connues

**Visages**

- **Un visage doit être vu de face, net et assez grand.** Un personnage filmé de dos, de profil, dans
  l'ombre ou de loin compte pour rien : son temps de présence est sous-estimé, et une scène où il n'est
  jamais vu de face ne le cite pas.
- **Seule la distribution fournie peut être nommée.** Un acteur absent de la liste envoyée par Laterna
  (figurant non crédité, crédit incomplet sur TMDB) reste anonyme — c'est voulu. TMDB ne donne souvent
  que le nom du personnage, sans son rôle dans l'histoire.
- **Les photos de TMDB font la qualité.** Un acteur avec une seule photo ancienne, ou des photos très
  retouchées, est moins bien reconnu ; un rôle lourdement maquillé, ou joué à un tout autre âge, peut ne
  pas l'être du tout.
- **Deux personnes du même plan peuvent, en théorie, finir dans un même groupe** : le regroupement ne
  tient pas compte du fait qu'elles apparaissent ensemble.

**Scènes**

- **Les scènes sont approchées.** Le découpage repose sur les couleurs et les personnes, pas sur le
  récit : une scène tournée dans deux décors très différents peut être coupée en deux, et deux scènes du
  même décor qui se suivent peuvent n'en faire qu'une. Deux fils **montés en alternance** (un appel
  téléphonique et l'autre bout de la ligne) peuvent être fondus en une scène.
- **Le HDR est adapté par `tonemapx`**, propre à jellyfin-ffmpeg. Avec un autre ffmpeg, il est analysé sans
  adaptation (le journal le dit) : moins de coupes trouvées, des scènes plus longues.

**Voix**

- **Une voix nommée suppose que la personne soit à l'image quand elle parle**, plus que les autres : un
  personnage toujours **hors champ** (narrateur, voix au téléphone), ou toujours filmé avec le même
  partenaire, reste souvent sans nom — c'est voulu.
- **Les répliques courtes** : un échange rapide sans silence peut tomber dans un même morceau ; la coupe
  aux changements de voix en rattrape la plupart, pas toutes. Laterna ne nomme ni les répliques à deux
  voix, ni une réplique brève avalée par la voix voisine.
- **Le son en avance sur l'image** (une réplique qui commence sur le plan précédent, un *pré-lap* de
  montage) brouille le contraste avec les visages pendant ce recouvrement.
- **Les voix trop courtes** (moins de 3 morceaux) ne sont jamais nommées ; de 3 à 5, seulement avec une
  confiance de 0,75.
- **La lecture des lèvres ne nomme qu'une voix entière** : une voix qui mêle deux personnes reste
  indécise.
- **La version originale**, prise de son de tournage, se regroupe moins bien qu'un doublage de studio.

**Fichier**

- **Le résultat dépend du fichier** : il est lié à son `etag`. Un fichier remplacé est réanalysé, sauf un
  réencodage de même durée (à ±1 s), dont le résultat est rattaché sans analyse (`rebindIfSameDuration`).
