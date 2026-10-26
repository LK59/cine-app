# Téléchargement pour lecture hors ligne

État : **bêta**, marqué comme tel partout où il paraît. La règle et ses raisons sont dans
[DECISIONS.md §109](../DECISIONS.md) ; ce document décrit le système tel qu'il fonctionne.

## Ce que c'est

Un film ou un épisode se télécharge dans l'application pour être lu sans réseau, ou sur une
connexion trop faible pour la lecture en ligne. Ce n'est pas le fichier d'origine : Jellyfin en
prépare une version légère par son API de transcodage, l'application la range sur le serveur le
temps qu'elle soit récupérée, et l'appareil la garde dans le stockage privé du site (OPFS).

Aucun encodeur n'est ajouté à l'image, et le dossier des médias n'a pas à être monté : le
transcodage passe par Jellyfin, et les fichiers préparés vivent dans le volume de données de
l'application (`data/offline/`).

## Demander un téléchargement

**Un film.** Depuis sa fiche : Lire, Bande-annonce, puis **Télécharger**. Une fenêtre demande
toujours :

- **la piste son** — préchoisie dans la langue du compte, sinon la piste par défaut. Une seule piste
  est gardée ;
- **la qualité** :

  | Qualité | Débit vidéo | Image |
  |---|---|---|
  | Standard (par défaut) | ~2 Mb/s | 720p |
  | Haute | ~4 Mb/s | 1080p |

  Jellyfin choisit lui-même la résolution d'après le débit : 720p jusqu'à 3 Mb/s, 1080p à partir de
  4 Mb/s. Le son est en AAC stéréo. La taille estimée est affichée avant de valider.

Le codec vidéo suit l'appareil : HEVC s'il le décode, H.264 sinon. Une plage dynamique HDR est
convertie en SDR par Jellyfin.

**Un épisode.** Un petit bouton à côté de chaque ligne d'épisode, au bureau comme au téléphone. Son
icône dit l'état (rien, préparation, anneau d'avancement, téléchargé, échec) et ouvre la suite : la
même fenêtre que pour un film, plus « Télécharger automatiquement l'épisode suivant » (coché par
défaut) ; une fois l'épisode là, « Lire le fichier téléchargé » et « Supprimer ». La ligne de
l'épisode reste son bouton de lecture en ligne.

**Une saison.** « Télécharger la saison » annonce la taille estimée et ne pose qu'une question pour
toute la saison : la **langue** (les pistes diffèrent d'un épisode à l'autre ; chaque épisode prend
sa première piste dans cette langue, sinon sa piste par défaut), la qualité et le téléchargement
automatique. Les épisodes absents partent un à un, dans l'ordre. Une place libre insuffisante sur
l'appareil est signalée sans bloquer : certains navigateurs annoncent un quota pessimiste.

**Épisode suivant automatique.** À la moitié d'un épisode lu depuis l'appareil, le suivant est
demandé aux mêmes langue, qualité et codec s'il n'est pas déjà là — seulement avec du réseau, sans
rien dire sinon. Un épisode vu (95 %, ou jusqu'à la fin) est effacé de l'appareil dès qu'un épisode
plus loin de la même suite y est.

## Le téléchargement

- **Pendant la préparation.** L'appareil récupère ce que le serveur a déjà écrit, sans attendre la
  fin de la préparation. Jusqu'à trois téléchargements à la fois, les versions prêtes d'abord.
- **Lire avant la fin.** « Lire le fichier en cours de téléchargement » est possible dès que le
  début est lisible ; ce qui manque sur l'appareil est lu dans la copie du serveur (mêmes octets).
  Un saut au-delà de ce que le serveur a préparé le dit et revient à la position d'avant.
- **Pause, reprise, réessai, suppression.** La pause arrête l'arrivée sur l'appareil, pas la
  préparation sur le serveur. Une coupure reprend là où le fichier s'était arrêté. Un échec se
  relance par « Réessayer ». Annuler et supprimer se confirment.
- **Un onglet à la fois** télécharge pour un compte ; l'écran est gardé allumé tant qu'un
  téléchargement visible avance ; l'application demande au navigateur un stockage persistant au
  premier téléchargement.
- **Session refusée.** Si le serveur ne reconnaît plus la session, les téléchargements s'arrêtent
  jusqu'au prochain chargement de la page, au lieu de réessayer sans fin ; rien n'est perdu.
- **Changement d'adresse.** Les téléchargements partent avec le passage (la liste, pas les fichiers :
  la nouvelle adresse les retélécharge). Sur l'ancienne adresse, un titre est effacé une fois récupéré
  entier sur la nouvelle, et les téléchargements inachevés le sont dès que le passage est fait
  (DECISIONS.md §119).

## Ce qui est gardé avec le fichier

- les **sous-titres texte**, toutes langues, convertis en WebVTT par Jellyfin ; pas les sous-titres
  image (PGS, VobSub) ;
- les **aperçus de la barre** (trickplay de Jellyfin) ;
- la **fiche** : affiche, logo, visuel, résumé, année, genres, noms des six premiers rôles (texte
  seul), affiche de la série pour un épisode ;
- les **repères d'intro et de générique** : « Passer l'intro » et « Épisode suivant » dès le
  générique de fin fonctionnent hors ligne ;
- la **position de lecture**.

Les téléchargements faits avant l'ajout d'un de ces éléments le récupèrent au chargement suivant,
avec du réseau.

## La page des téléchargements

Un rond à côté de « Tous les… » sur l'accueil (bureau et téléphone) ouvre la page des
téléchargements, un écran poussé avec sa flèche de retour. Le même contenu sert à l'entrée hors
ligne `/hors-ligne` (plus bas) :

- **la place** : ce que prennent les téléchargements, et ce que le navigateur dit pouvoir encore
  accorder ;
- **« En cours »** : une ligne par téléchargement qui arrive, avec son avancement et ses commandes
  (Pause, Reprendre, Réessayer, Supprimer) ;
- **films et séries** en grille d'affiches. Une affiche ouvre la **fiche hors ligne** : visuel, logo,
  année et genres, Lire (ou Reprendre) en tête — pour une série, l'épisode commencé, sinon le premier
  pas vu —, résumé, distribution, puis les épisodes avec vignette et résumé.

Tout y est lu sur l'appareil, images comprises. La fiche hors ligne a la forme et le mouvement des
fiches du cinéma ; le bouton Retour d'Android la referme.

Sur la fiche d'un titre du cinéma, un fichier téléchargé est proposé en tête (« Lire » ou
« Reprendre », « Fichier téléchargé · 1h10 restantes »), la lecture en ligne restant à côté.

## Le lecteur hors ligne

Un chemin à part (`OfflinePlayerHost`, `src/lib/offline/offlineEngine.ts`), pour que la lecture en
ligne n'en dépende jamais : il ne partage que les commandes et le mini-lecteur. Les fragments du MP4
vont tels quels à MediaSource (ManagedMediaSource sur iPhone) ; seul l'en-tête est retouché.

- Pas de menu son : le fichier n'a qu'une piste.
- Sous-titres texte gardés, aperçus de la barre, partie téléchargée de la barre plus sombre que la
  partie lue, panneau technique.
- « Épisode suivant » lance le fichier de l'appareil s'il est là, sinon la lecture en ligne s'il y a
  du réseau, sinon il n'apparaît pas.

## Ouvrir l'application sans réseau

Le cinéma est rendu par le serveur derrière une session ; sans réseau, une navigation ne peut
aboutir qu'à la page hors ligne du service worker. L'entrée à part est **`/hors-ligne`** : une page
publique, qui liste et lit les téléchargements de l'appareil sans rien demander au serveur.

- **Le compte.** Le cinéma retient sur l'appareil le compte et le nombre de ses téléchargements ;
  `/hors-ligne` montre ceux de ce compte.
- **Le service worker la garde**, avec tout le code qu'elle charge, dans le cache du build en cours —
  seulement sur un appareil qui a des téléchargements. `/hors-ligne` prend le réseau s'il répond en
  2,5 s, sinon cette copie. La page hors ligne générique (`offline.html`) affiche alors
  **« Accéder aux téléchargements »**.
- **Réseau lent.** Sur l'écran de chargement et pendant l'attente du catalogue, le même bouton
  apparaît au bout de 5 s si le compte a des téléchargements. Sur un tel appareil, une navigation
  sans réponse après 6 s est remplacée par la page hors ligne en mode « attente » : la requête
  continue, et la page se recharge dès qu'elle a répondu. Un appareil sans téléchargement ne change
  pas de comportement.

## La reprise

Le lecteur hors ligne rapporte sa lecture à Jellyfin comme le lecteur en ligne : la position est la
même des deux côtés, et Jellyfin applique ses seuils (position de reprise minimale et maximale,
durée minimale). Sans réseau, l'appareil applique les mêmes seuils, relus chez Jellyfin auparavant,
garde la position, et l'envoie au retour du réseau. Un titre vu au seuil de Jellyfin est marqué vu.

## Le serveur

- **Les préparations** (`src/lib/offline/jobs.ts`, tables `offline_jobs` et `offline_requests`).
  Jellyfin transcode en MP4 fragmenté ; l'application l'écrit au fil de l'eau dans
  `data/offline/<id>.mp4`. Une version (titre, fichier source, piste, qualité, codec) sert tous les
  comptes qui demandent la même. Deux préparations à la fois ; les autres attendent en file
  (« En file d'attente sur le serveur »). La préparation continue si l'application est fermée.
  Une préparation n'est prête que si elle atteint la fin du film ; deux minutes sans octet sont un
  échec. Une préparation interrompue par un redémarrage repart de zéro, et l'appareil recommence.
- **La place.** Une préparation est refusée s'il ne reste pas sa taille estimée plus une marge sur
  le disque du serveur.
- **La conservation.** Une version prête est gardée trois jours après son dernier téléchargement ;
  une version inachevée est effacée dès que plus aucun compte ne l'attend ; un échec, le lendemain.
- **Le quota** (`OFFLINE_SERVER_QUOTA_GB`, 50 Go par défaut). Quand le total des copies dépasse le
  quota, les copies que tous les appareils ont entièrement récupérées sont effacées, les plus
  anciennes d'abord. Une copie en préparation ou en cours de téléchargement n'est jamais effacée :
  le quota peut donc être dépassé un temps.

Routes : `POST /api/offline/jobs` (demande), `GET`/`DELETE /api/offline/jobs/<id>` (état, retrait),
`…/file` (le fichier, par plages bornées à ce qui est écrit), `…/index` (l'index des fragments d'une
préparation en cours), `/api/offline/details/<id>` (la fiche et les repères),
`/api/offline/subtitles/<id>` (les sous-titres texte).

## Administration

- **Réglages** (Gestion → Configuration → Lecture) :

  | Variable | Défaut | Rôle |
  |---|---|---|
  | `OFFLINE_DOWNLOADS` | `true` | Active la fonctionnalité pour l'installation. Coupée : ni bouton ni préparation. |
  | `OFFLINE_DOWNLOADS_FOR_EVERYONE` | `true` | `true` : tous les comptes. `false` : administrateurs seulement. |
  | `OFFLINE_SERVER_QUOTA_GB` | `50` | Place totale des copies sur le serveur avant effacement des plus anciennes déjà récupérées. |

- **Activité.** Une vue *Téléchargements* liste les copies du serveur (prêtes, en préparation, en
  échec, place occupée), les comptes qui les attendent, et permet d'en effacer une. Chaque étape
  (demande, début, prête, échec, récupérée, annulée, supprimée, expirée, effacée) est écrite dans
  `data/logs/server.log` sous `scope: "offline"`.

## Déconnexion

À la déconnexion, la personne choisit de garder ou de supprimer les téléchargements de cet appareil.
Gardés, ils restent dans le stockage du navigateur ; l'entrée `/hors-ligne` ne les montre plus tant
que le compte ne s'est pas reconnecté.

## Limites

- **Garder l'application au premier plan** pendant un téléchargement : un navigateur, Safari en
  particulier, n'en continue pas un en arrière-plan. La préparation sur le serveur, elle, continue.
- **Une seule piste son** par téléchargement ; une autre piste se lit en ligne, à la même position.
- **Sous-titres image** (PGS, VobSub) non gardés.
- **Le navigateur peut évincer le stockage** — iOS en particulier pour une application installée
  restée longtemps fermée. Le stockage persistant demandé réduit ce risque sans le supprimer.
- Sur iPhone et iPad, `/hors-ligne` ne s'ouvre sans réseau que si l'application a été ouverte avec
  du réseau après le premier téléchargement, pour la version installée.

## Pourquoi une version complète, et pas un téléchargement « partiel »

Garder sur l'appareil les seules images clés et télécharger le reste à la volée ne fonctionne pas :
les images intermédiaires sont décrites par différence avec les précédentes, et sans elles on
obtient un diaporama. Télécharger le reste pendant la lecture, c'est ce que fait déjà la lecture en
ligne. Aucun format lisible par les navigateurs ne propose de couche de base complétée par des
couches d'amélioration. D'où une version légère complète sur l'appareil, et l'original depuis le
serveur quand le réseau le permet.

Jellyfin plutôt qu'un encodeur dans l'image : à ces débits, aucune différence visible n'a été
relevée avec un encodeur réglé à la main, et l'image de l'application reste sans encodeur.
