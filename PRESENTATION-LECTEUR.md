# Le lecteur Ciné App

**Vos films, tels qu'ils sont sur le disque, lus par l'appareil que vous tenez en main.**

La plupart des lecteurs de médiathèque personnelle font la même chose dès qu'un fichier sort de
l'ordinaire : ils demandent au serveur de le **réencoder** en direct. Le serveur chauffe, le
démarrage traîne, l'image perd en qualité, et le HDR disparaît souvent au passage.

Le lecteur de Ciné App prend le chemin inverse. Le fichier quitte le disque **sans être touché**.
C'est le navigateur de l'appareil qui le prépare et qui le décode avec la puce vidéo du téléphone,
de la tablette ou de l'ordinateur. Le serveur ne fait qu'envoyer des octets.

---

## Ce que ça change

| | Lecteur classique (réencodage serveur) | Lecteur Ciné App |
|---|---|---|
| **Image** | Réencodée, souvent en SDR | **L'originale**, au bit près, HDR et Dolby Vision compris |
| **Son** | Réencodé en stéréo ou en 5.1 | **L'original** quand l'appareil le lit ; sinon décodé et réencodé **sur l'appareil**, canaux à leur place |
| **Charge du serveur** | Un cœur de processeur par film, voire plus | Pratiquement nulle : il envoie des fichiers |
| **Démarrage** | Attente de la préparation du flux | Les premières images en quelques centaines de millisecondes sur le réseau local |
| **Changement de langue** | Nouveau flux, souvent plusieurs secondes | **0,15 à 0,4 s** mesurées, sans écran noir |
| **Nombre de spectateurs** | Limité par le processeur du serveur | Limité par le réseau, pas par le serveur |

---

## Ses atouts

**L'image d'origine, HDR compris.** Le lecteur ne fait que réemballer le fichier : aucun pixel ne
passe par un logiciel. Le HDR10 et le **Dolby Vision** s'affichent en natif sur les écrans qui les
savent, avec le décodage matériel de l'appareil.

**Le son d'origine, et au bon endroit.** Quand l'appareil sait lire la piste, elle lui est
transmise **intacte, au bit près**. Quand il ne sait pas (DTS, TrueHD, FLAC sur iPhone…), le
lecteur la décode lui-même et la réencode dans un format que l'appareil accepte. Il le fait en
**respectant la position des canaux**, que chaque système attend dans son propre ordre : les voix
au centre, les effets derrière. Cet ordre a été **mesuré** navigateur par navigateur, pas supposé.

**Des changements de piste qui ne se voient pas.** Passer de la VF à la VO se fait en une fraction
de seconde. Si la nouvelle piste est dans un autre format, le lecteur se reconstruit à l'endroit
exact, en gardant l'image à l'écran et la pause si le film était en pause.

**Il se souvient de vous.** Il ouvre le film dans la langue audio et de sous-titres de votre compte,
reprend là où vous vous étiez arrêté, et retrouve votre position sur la télévision comme sur le
téléphone.

**Il tient bon.** Coupure de réseau, téléphone verrouillé, appel entrant, fichier mal construit : il
attend, reprend à la seconde et dans la langue où il était, et **dit ce qui se passe** au lieu de
tourner dans le vide. En dernier recours, il passe la main au lecteur du serveur, **à la même
position et sur la même piste**.

**Il se laisse diagnostiquer.** Chaque lecture laisse une trace : chemin choisi, formats, temps de
chaque étape, raison de chaque repli. Un problème signalé depuis un canapé se retrouve et se
corrige, sans avoir à deviner.

**Il parle votre langue.** Français, anglais, espagnol et allemand, jusqu'au nom des pistes :
« Anglais — Dolby TrueHD — 7.1 », « Français (Canadien) — 5.1 ».

---

## Sur quels appareils

Le lecteur tourne dans le navigateur. Il n'y a **rien à installer**, et il s'ajoute à l'écran
d'accueil comme une application.

| Appareil | Navigateur | Image | Son |
|---|---|---|---|
| **iPhone, iPad** | Safari et l'application sur l'écran d'accueil (et tout navigateur iOS) | HEVC 10 bits, **HDR10, Dolby Vision**, AV1 sur les puces récentes | Dolby Digital et Digital+ intacts ; DTS, TrueHD, FLAC et Opus décodés sur l'appareil |
| **Mac** | Safari | HEVC, HDR10, Dolby Vision selon l'écran | Comme l'iPhone |
| **Mac** | Chrome, Edge | HEVC, AV1 selon la puce | FLAC et Opus intacts ; Dolby, DTS, TrueHD décodés |
| **PC Windows** | Chrome, Edge | HEVC (selon la carte graphique), AV1, HDR10 | FLAC et Opus intacts ; Dolby, DTS, TrueHD décodés |
| **PC Windows, Mac, Linux** | Firefox | H.264, AV1 ; HEVC selon la version et le système | FLAC et Opus intacts ; le reste décodé, puis restitué en Opus jusqu'au 5.1 |
| **Android** | Chrome et navigateurs Chromium | HEVC et AV1 selon la puce, HDR10 selon l'écran | FLAC et Opus intacts ; le reste décodé |
| **Télévision** | Par **AirPlay** depuis un iPhone ou un Mac | Passe par le lecteur du serveur le temps de la diffusion | Idem |

Le lecteur ne suppose rien d'un appareil d'après son nom : il **lui demande** ce qu'il sait faire
avant chaque film, et choisit le meilleur chemin à partir de la réponse.

---

## Les formats pris en charge

### Vidéo

| Format | Comment |
|---|---|
| **H.264 / AVC** | Décodage matériel, partout |
| **H.265 / HEVC**, 8 et 10 bits | Décodage matériel sur les appareils qui l'ont (Apple, la plupart des PC et Android récents) |
| **AV1**, 8 et 10 bits | Décodage matériel sur les puces récentes (iPhone 15 Pro et suivants, Mac M3, PC et Android récents) |
| **VP9, VP8** | Décodés par le navigateur, affichés par le lecteur lui-même |
| **HDR10** | Affiché en natif sur un écran HDR |
| **Dolby Vision profil 8** (base HDR10) | **Dolby Vision natif** sur les appareils compatibles, HDR10 ailleurs |
| **Dolby Vision profil 5** | Natif sur les appareils Dolby Vision ; ailleurs, lu par le serveur, sans quoi les couleurs seraient fausses |
| **HDR sur écran standard** | Converti pour l'écran quand l'appareil ne sait pas afficher le HDR |

Formats de fichier : **MKV** (le cas courant, réemballé à la volée) et **MP4** (lu tel quel).

### Audio

| Format | Transmis intact quand l'appareil le lit | Sinon, décodé sur l'appareil |
|---|---|---|
| **AAC** | Partout | — |
| **Dolby Digital (AC-3)** | Safari (iPhone, iPad, Mac) | Oui, jusqu'au 5.1 |
| **Dolby Digital Plus (E-AC-3)**, y compris sa variante **Dolby Atmos** | Safari (iPhone, iPad, Mac) : flux intact, métadonnées Atmos comprises | Oui |
| **Dolby TrueHD**, y compris **TrueHD Atmos** | Aucun navigateur ne le lit | **Oui**, par le décodeur de référence de FFmpeg embarqué dans le lecteur : lit le socle 7.1, restitué en 5.1 sur les appareils qui s'arrêtent là |
| **MLP** | — | Oui |
| **DTS**, **DTS-HD Master Audio / High Resolution**, **DTS Express** | Aucun navigateur ne le lit | **Oui** (cœur DTS 5.1) |
| **FLAC**, 16 et 24 bits, du mono au 5.1 | Chrome, Edge, Firefox | **Oui** sur iPhone, iPad et Mac Safari, par le décodeur de référence libFLAC |
| **Opus** | Chrome, Edge, Firefox | Oui en stéréo sur iPhone |
| **Mono, stéréo, 5.1, 7.1** | — | Canaux replacés dans l'ordre que chaque système attend |

Sur cette médiathèque, **99,5 % des 30 110 pistes audio** sont en mono, stéréo, 5.1 ou 7.1, et
les combinaisons courantes ont été écoutées sur iPhone, Chrome et Firefox.

**Une précision honnête sur l'Atmos.** Dans un **Dolby Digital Plus Atmos** lu sur un appareil
Apple, le flux est transmis intact, et c'est l'appareil qui restitue l'Atmos s'il sait le faire.
Dans un **TrueHD Atmos**, le lecteur restitue le **7.1 de base**, comme le fait le lecteur du
serveur. Les objets sonores en hauteur, eux, ne sont pas reproduits.

### Sous-titres

| Format | Comment |
|---|---|
| **SRT**, texte du conteneur | Affichés, réglables (taille, fond) |
| **ASS / SSA** | Le texte, sans la mise en forme décorative |
| **Fichiers `.srt` à côté du film** | Proposés avec ceux du conteneur, dans la langue du compte |
| **Sous-titres forcés** | Reconnus, même quand seul leur titre le dit |
| **PGS, VobSub** (images) | Non affichés par ce lecteur ; un `.srt` les remplace sur cette médiathèque |

---

## Ce qu'il ne fait pas

- **Pas de qualité adaptative.** Le fichier est lu tel quel. Le lecteur est pensé pour la maison
  et un bon réseau, pas pour une connexion 3G.
- **Les vieux formats `.avi`** (MPEG-4 ASP, MP3) : aucun navigateur ne les décode. Ils passent par
  le lecteur du serveur.
- **La hauteur Atmos du TrueHD**, comme expliqué plus haut.

Pour tout ce qui reste hors de sa portée, le **lecteur du serveur** prend la main automatiquement,
à la même position et dans la même langue. Le spectateur n'a rien à faire.

---

## Sous le capot, en une page

- **Réemballage à la volée.** Le fichier MKV est lu par morceaux, réemballé en MP4 fragmenté et
  confié au lecteur vidéo du navigateur. Un groupe d'images se prépare en 15 à 56 ms, contre
  environ 2,5 s pour le télécharger : ce qui limite, c'est le réseau, pas l'appareil.
- **Décodeurs embarqués.** Le lecteur embarque le TrueHD de FFmpeg et le FLAC de libFLAC,
  compilés pour le navigateur, ainsi que les décodeurs Dolby Digital et DTS. Ils ne sont chargés
  que lorsqu'un film en a besoin, puis mis en cache.
- **Vérifié sur les vrais fichiers.** Chaque décodeur a été comparé à FFmpeg, canal par canal, sur
  des films de la médiathèque (écart de 0,01 à 0,05 dB). Plus de 2 200 tests automatiques
  accompagnent le code.
- **Un secours toujours prêt.** Si un appareil refuse un film, le lecteur du serveur (Jellyfin)
  prend le relais sans interruption visible.

La référence technique complète est dans [`DOC-TECH.md`](DOC-TECH.md).
