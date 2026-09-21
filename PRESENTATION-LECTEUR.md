# Le lecteur Ciné App

Ciné App lit les films **directement sur l'appareil** : téléphone, tablette ou ordinateur. Le
fichier est envoyé tel quel par le serveur, et c'est le navigateur qui le décode, avec la puce
vidéo de l'appareil.

La plupart des lecteurs de médiathèque personnelle font autrement : dès qu'un fichier n'est pas
lisible tel quel, le serveur le **réencode** pendant la lecture. Cela demande beaucoup de
puissance, retarde le démarrage et dégrade souvent l'image, en particulier le HDR.

---

## Les avantages

| | Réencodage par le serveur | Lecteur Ciné App |
|---|---|---|
| **Image** | Réencodée, souvent sans HDR | Celle du fichier, HDR et Dolby Vision compris |
| **Son** | Réencodé, souvent en stéréo | Celui du fichier quand l'appareil le lit ; sinon converti sur l'appareil |
| **Charge du serveur** | Forte, à chaque lecture | Quasi nulle : il envoie le fichier |
| **Démarrage** | Le temps de préparer le flux | Presque immédiat sur un réseau local |
| **Changement de langue** | Nouveau flux, quelques secondes | Moins d'une demi-seconde |
| **Lectures simultanées** | Limitées par le serveur | Limitées par le réseau |

**Image d'origine.** Le fichier est seulement réorganisé pour le navigateur, jamais réencodé. Le
HDR10 et le Dolby Vision s'affichent en natif sur les écrans compatibles.

**Son d'origine.** Une piste que l'appareil sait lire lui est transmise sans modification. Sinon,
le lecteur la décode et la convertit lui-même, en gardant chaque canal à sa place : les dialogues
au centre, les effets à l'arrière.

**Changement de piste rapide.** On passe de la VF à la VO en cours de film, sans écran noir, à la
même position, et la pause est conservée.

**Préférences du compte.** Le film s'ouvre dans la langue audio et de sous-titres choisie par le
compte, et reprend là où il avait été arrêté, quel que soit l'appareil.

**Résistant aux coupures.** Après une coupure réseau ou un téléphone mis en veille, la lecture
reprend au même endroit et dans la même langue. Si un fichier ne peut vraiment pas être lu sur un
appareil, le lecteur du serveur prend le relais, à la même position.

**Quatre langues.** Français, anglais, espagnol et allemand, y compris pour le nom des pistes
(« Anglais — Dolby TrueHD — 7.1 »).

---

## Appareils

Le lecteur fonctionne dans le navigateur : rien à installer. Sur téléphone, il peut s'ajouter à
l'écran d'accueil comme une application.

| Appareil | Navigateur | Image | Son |
|---|---|---|---|
| **iPhone, iPad** | Safari, application sur l'écran d'accueil, tout navigateur iOS | HEVC 10 bits, HDR10, Dolby Vision, AV1 sur les modèles récents | Dolby Digital et Dolby Digital Plus lus tels quels ; DTS, TrueHD, FLAC et Opus convertis sur l'appareil |
| **Mac** | Safari | HEVC, HDR10, Dolby Vision selon l'écran | Comme sur iPhone |
| **Mac** | Chrome, Edge | HEVC, AV1 selon le modèle | FLAC et Opus lus tels quels ; Dolby, DTS, TrueHD convertis |
| **PC Windows** | Chrome, Edge | HEVC selon la carte graphique, AV1, HDR10 | FLAC et Opus lus tels quels ; Dolby, DTS, TrueHD convertis |
| **Windows, Mac, Linux** | Firefox | H.264, AV1 ; HEVC selon la version et le système | FLAC et Opus lus tels quels ; le reste converti, jusqu'au 5.1 |
| **Android** | Chrome et navigateurs dérivés | HEVC et AV1 selon le modèle, HDR10 selon l'écran | FLAC et Opus lus tels quels ; le reste converti |
| **Télévision** | Par AirPlay depuis un iPhone ou un Mac | Via le lecteur du serveur pendant la diffusion | Idem |

Avant chaque film, le lecteur interroge l'appareil sur ce qu'il sait lire et choisit la meilleure
solution en fonction de la réponse.

---

## Formats pris en charge

### Vidéo

| Format | Prise en charge |
|---|---|
| **H.264 / AVC** | Décodage matériel, partout |
| **H.265 / HEVC**, 8 et 10 bits | Décodage matériel sur les appareils compatibles (Apple, la plupart des PC et Android récents) |
| **AV1**, 8 et 10 bits | Décodage matériel sur les puces récentes |
| **VP9, VP8** | Décodés par le navigateur |
| **HDR10** | Natif sur écran HDR |
| **Dolby Vision profil 8** (avec base HDR10) | Dolby Vision natif sur les appareils compatibles, HDR10 ailleurs |
| **Dolby Vision profil 5** | Natif sur les appareils Dolby Vision, sinon lu par le serveur |
| **HDR sur écran standard** | Converti pour l'écran |

Conteneurs : **MKV**, réorganisé à la volée, et **MP4**, lu tel quel.

### Audio

| Format | Lu tel quel par | Sinon |
|---|---|---|
| **AAC** | Tous les navigateurs | — |
| **Dolby Digital (AC-3)** | Safari | Converti sur l'appareil, jusqu'au 5.1 |
| **Dolby Digital Plus (E-AC-3)**, y compris **Dolby Atmos** | Safari, avec les informations Atmos | Converti sur l'appareil |
| **Dolby TrueHD**, y compris **TrueHD Atmos** | Aucun navigateur | Décodé sur l'appareil (décodeur de FFmpeg) : le 7.1 de base, restitué en 5.1 là où l'appareil s'arrête au 5.1 |
| **MLP** | Aucun navigateur | Décodé sur l'appareil |
| **DTS**, **DTS-HD Master Audio / High Resolution**, **DTS Express** | Aucun navigateur | Décodé sur l'appareil (cœur DTS, jusqu'au 5.1) |
| **FLAC**, 16 et 24 bits | Chrome, Edge, Firefox | Décodé sur iPhone, iPad et Safari (décodeur libFLAC) |
| **Opus** | Chrome, Edge, Firefox | Décodé en stéréo sur iPhone |

Mono, stéréo, 5.1 et 7.1 sont pris en charge, et les canaux sont remis dans l'ordre attendu par
chaque système.

**À propos de l'Atmos.** Un Dolby Digital Plus Atmos lu sur un appareil Apple est transmis intact,
et l'appareil restitue l'Atmos s'il en est capable. Pour le TrueHD Atmos, le lecteur restitue le
7.1 de base, comme le lecteur du serveur : les effets en hauteur ne sont pas reproduits.

### Sous-titres

| Format | Prise en charge |
|---|---|
| **SRT** (dans le fichier) | Affichés, taille et fond réglables |
| **ASS / SSA** | Le texte, sans la mise en forme |
| **Fichiers `.srt` à côté du film** | Proposés avec ceux du fichier |
| **Sous-titres forcés** | Reconnus automatiquement |
| **PGS, VobSub** (sous-titres en image) | Non affichés par ce lecteur |

---

## Limites

- **Pas de qualité adaptative.** Le fichier est lu tel quel : le lecteur est fait pour un réseau
  local ou une bonne connexion.
- **Anciens `.avi`** (MPEG-4 ASP, MP3) : aucun navigateur ne les décode, ils passent par le lecteur
  du serveur.
- **Hauteur Atmos du TrueHD** : non restituée, voir plus haut.

Dans tous ces cas, le lecteur du serveur prend le relais automatiquement.

---

## Fonctionnement

- **Réorganisation à la volée.** Le fichier MKV est lu par morceaux, converti en MP4 fragmenté et
  confié au lecteur vidéo du navigateur. Cette étape prend quelques dizaines de millisecondes par
  morceau : c'est le débit du réseau qui fixe la vitesse.
- **Décodeurs audio intégrés.** Les décodeurs TrueHD (FFmpeg), FLAC (libFLAC), Dolby Digital et
  DTS sont chargés seulement quand un film en a besoin, puis gardés en cache.
- **Lecteur de secours.** Si un appareil ne peut pas lire un film, le lecteur du serveur (Jellyfin)
  prend le relais.

La documentation technique complète est dans [`DOC-TECH.md`](DOC-TECH.md).
