# Téléchargement pour lecture hors ligne

État : **conception**. Rien n'est encore implémenté. Ce document fixe l'architecture retenue et
les mesures faites sur le serveur avant d'écrire du code.

## Pourquoi pas un téléchargement « partiel »

L'idée de ne garder sur l'appareil que les images clés, et de télécharger le reste à la volée, ne
tient pas. Une vidéo compressée ne se lit pas à partir de ses seules images clés : les images
intermédiaires sont décrites par différence avec les précédentes, et sans elles on obtient un
diaporama d'une image toutes les deux à dix secondes. Télécharger le reste pendant la lecture, c'est
ce que fait déjà la lecture en ligne avec son tampon. Aucun format lisible par les navigateurs ne
propose une couche de base complétée par des couches d'amélioration.

Le seul hybride utile est celui-ci : une version légère complète sur l'appareil, et l'original
depuis le serveur quand le réseau le permet.

## Architecture

1. **Demande.** Depuis la fiche d'un film, on demande le téléchargement. Le client joint sa sonde
   de codecs (`codecSupport.ts`) : un appareil qui ne décode pas le HEVC reçoit du H.264.
2. **Préparation par Jellyfin.** cine-app demande à Jellyfin le flux transcodé, en MP4 progressif,
   et l'écrit au fil de l'eau sur son disque (`data/…`). Un seul encodage à la fois. L'interface
   affiche « le serveur prépare votre téléchargement ». Les fichiers prêts sont effacés au bout de
   quelques jours.
3. **Prêt.** Une notification push prévient la personne, avec le mécanisme de notifications
   existant.
4. **Téléchargement dans le stockage de l'application** (OPFS, système de fichiers privé du site) :
   - par morceaux, avec reprise après coupure ;
   - avec une barre de progression, et l'écran maintenu allumé ;
   - sur iPhone, l'application doit rester ouverte pendant le téléchargement (Safari ne propose pas
     de téléchargement en arrière-plan) : l'interface le dit clairement. Sur Android et sur
     ordinateur, le téléchargement peut continuer en arrière-plan.
5. **Lecture.** Le fichier téléchargé est lu par défaut, avec un lien discret « Lire depuis le
   serveur » pour retrouver la pleine qualité. Sans réseau, le fichier local est choisi
   automatiquement.

La lecture elle-même ne change pas : le lecteur lit déjà le MP4 (`mediaFile.ts`) et consomme ses
fichiers morceau par morceau à travers une source d'octets (`ByteSource`). Un fichier OPFS n'est
qu'une source d'octets de plus, et le remultiplexeur n'a pas à changer.

## Format visé

- **Image** : HEVC, 1080p au plus, environ 3 à 4 Mb/s. Environ 2,5 à 3,5 Go pour un film de 2 h.
- **Son** : la langue de la personne, et la version originale si elle diffère, en AAC stéréo. Le
  TrueHD et le DTS disparaissent d'office.
- **Sous-titres** : les sous-titres texte, convertis et rangés à côté du fichier. Pas les
  sous-titres image (PGS).
- **Plage dynamique** : par défaut, le HDR est converti en SDR (voir les mesures). C'est le choix le
  plus sûr : le fichier se lit sur tout appareil, y compris ceux qui ne décodent pas le HEVC 10 bits.
  Garder le HDR10 peut devenir une option.

## Configuration proposée (`.env`)

La fonctionnalité repose entièrement sur Jellyfin : aucun encodeur n'est ajouté à l'image de
cine-app. Elle est désactivée par défaut.

| Variable | Défaut | Rôle |
|---|---|---|
| `OFFLINE_DOWNLOADS` | `false` | Active la fonctionnalité |
| `OFFLINE_VIDEO_BITRATE` | `4000000` | Débit vidéo demandé à Jellyfin, en bit/s |
| `OFFLINE_MAX_HEIGHT` | `1080` | Hauteur maximale de l'image |
| `OFFLINE_KEEP_DAYS` | `3` | Durée de conservation des fichiers prêts sur le serveur |
| `OFFLINE_DIR` | `data/offline` | Où le serveur range les fichiers préparés |

## Mesures sur le serveur (25/09/2026)

Configuration de Jellyfin relevée : accélération matérielle Intel QSV, encodage matériel actif, HEVC
autorisé, décodage HEVC 10 bits matériel, conversion HDR→SDR active, limitation de débit
(`EnableThrottling`) active. Encodeurs disponibles dans jellyfin-ffmpeg : `hevc_qsv`, `h264_qsv`,
`hevc_vaapi`, `h264_vaapi`, `libx265`.

Essai : 60 s de transcodage d'un film 4K HEVC Dolby Vision / HDR10+ à 25 Mb/s, demandé par
`/Videos/{id}/stream.mp4` avec `VideoCodec=hevc`, `VideoBitrate=3000000`, `AudioCodec=aac`,
`AudioChannels=2`, `MaxWidth=1920`, `MaxHeight=1080`.

| Mesure | Résultat |
|---|---|
| Vitesse | **5,6× le temps réel**, tenu sur toute la minute (339 s de film en 62 s, ~134 images/s) : un film de 2 h est prêt en ~22 min |
| Limitation de débit | ne s'applique pas à ce flux progressif |
| Débit obtenu | 2,5 Mb/s d'image + 160 kb/s de son |
| Résolution | **1280×690** : Jellyfin choisit la résolution d'après le débit demandé, et descend en 720p à 3 Mb/s |
| Plage dynamique | **SDR 8 bits** (HEVC Main, BT.709) : le HDR est converti |
| Son | AAC stéréo 48 kHz, 160 kb/s |
| Fichier partiel | lisible : le serveur peut l'écrire au fil de l'eau |
| Arrêt | `DELETE /Videos/ActiveEncodings` arrête la tâche proprement |

À vérifier avant l'implémentation : le débit ou le paramètre qui donne réellement du 1080p (4 Mb/s,
ou une largeur imposée), et la façon de garder le HDR10 si l'option est retenue.

## Ordre de réalisation

Chaque étape est utilisable seule.

1. Préparation par Jellyfin, et téléchargement avec reprise vers l'appareil.
2. Lecture depuis le fichier local, avec le lien « Lire depuis le serveur ».
3. Mode hors ligne complet : l'application s'ouvre sans réseau, et le lecteur trouve sur l'appareil
   ce qu'il demande aujourd'hui au serveur (fiche, pistes, position de reprise), enregistré avec le
   fichier.
4. Reprise hors ligne renvoyée à Jellyfin au retour du réseau, en réutilisant le mécanisme des
   séances perdues (`unsentStop.ts`).
5. Gestion de l'espace : liste des téléchargements, taille, suppression, effacement automatique une
   fois vus.
