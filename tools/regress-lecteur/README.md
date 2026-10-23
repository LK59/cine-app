# Banc anti-régression du lecteur en vrais navigateurs

Les tests unitaires prouvent qu'une fonction rend ce qu'on attend ; les bancs `*.spec.ts` prouvent
ce que le remultiplexeur produit. Aucun ne dit ce qu'un **moteur de navigateur** fait de la page
entière — l'hôte du lecteur, ses commandes, la source MediaSource, les relais. Ce banc-ci le dit, en
comparant deux versions du code sur les mêmes fichiers de la bibliothèque, dans Chromium, Firefox
et WebKit (bureau, et un iPhone émulé).

Il ne juge pas un passage seul. Il répond à une question : **la version B se comporte-t-elle comme
la version A ?** C'est l'outil d'un remaniement qui ne doit rien changer (déplacer du code entre
`ExperimentalPlayerHost`, `PlayerHost`, `PlayerControls`, `mseSource`…).

## Ce qu'il fait

1. **Construit** l'image d'un commit (`git archive` du commit seul, jamais la copie de travail),
   étiquetée `cine-app:regress-<commit>`.
2. **Lance une instance jetable** `cine-regress-<commit>` : `--env-file` de l'instance réelle,
   `COOKIE_SECURE=false`, son propre dossier de données dans le dossier de travail, la bibliothèque
   montée **en lecture seule**, le port publié sur `127.0.0.1` seulement, le réseau Docker des
   services. Le dossier de données ne reçoit que (voir `prepare-data.py`) :
   - `kv_cache` (les réponses TMDB : pas de quota consommé, ouverture comparable à la production) ;
   - `app_settings` **sans** les clés des sous-titres générés, de la recherche de répliques, des
     alertes ni des tags posés d'office aux nouveaux comptes (`NEW_ACCOUNT_BLOCKED_TAGS` est aussi
     vidé dans l'environnement : l'instance ne modifie aucun compte Jellyfin) ;
   - la liste des appareils Jellyfin des sessions vivantes (colonne `jf_device` seule, jetons et
     comptes effacés) : sans elle, le ménage des appareils, quinze minutes après le démarrage,
     retirerait de Jellyfin ceux d'appareils encore connectés à la vraie instance.

   `repliques.db` n'est ni copiée ni ouverte ; la recherche de répliques est coupée.
3. **Joue** chaque titre de `titres.json` dans chaque profil, avec Playwright
   (`mcr.microsoft.com/playwright`, `--network host` pour joindre l'instance par `localhost` — un
   contexte sécurisé, sans lequel ni `AudioEncoder` ni OPFS n'existent). Un contexte de navigateur
   neuf par titre : rien sur l'appareil, l'ouverture vient toujours du réseau.
4. **Recueille** les lignes que l'instance a écrites dans son `player.log` (et `server.log`, pour
   les erreurs du navigateur) pendant chaque titre, et les **normalise** (`normalise.py`).
5. **Nettoie** : instance, dossier de données (il contient une copie de la base) et image retirés,
   même en cas d'échec.

### Le parcours, identique pour chaque titre

ouvrir (« Recommencer depuis le début » si le compte a une reprise, « Lire » sinon — toujours du
début) → première image → saut à 40 % → saut à 75 % (barre de progression, à la souris) → −10 s
(flèche gauche) → pause 3 s (`k`) → changement de piste son s'il y en a une autre (menu) →
sous-titres allumés puis éteints (menu) → arrière-plan simulé 6 s (`visibilityState` forcé à
`hidden` puis rendu) → pour un épisode, épisode suivant → retour près du début → fermer (la croix).

Le retour près du début avant la fermeture est voulu : sous le seuil de reprise de Jellyfin, aucune
position n'est gardée sur le compte de test, et le passage suivant trouve le même état.

### Le compte

Uniquement un compte Jellyfin **standard dédié aux tests**, jamais celui d'une personne réelle ni
l'administrateur de `.env`. Ses identifiants sont lus dans un fichier (`user=` / `password=`)
monté en lecture seule dans le conteneur Playwright ; ils ne sont ni affichés ni écrits. Le banc ne
fait aucune action à effet réel : ni demande, ni signalement, ni réglage (l'écran d'accueil du
compte est passé par « Passer », qui n'enregistre rien). Les seules écritures vers Jellyfin sont
celles de toute lecture (séance, position) — sur ce compte — et la déconnexion à la fin de chaque
profil rend l'appareil que la connexion avait inscrit.

## Lancer

```sh
export REGRESS_WORK=/chemin/jetable/regress     # dossier de travail (sources, données, dépendances)
export REGRESS_CREDS=/chemin/compte-de-test.txt # user=… / password=…
# REGRESS_ENV (défaut .env du dépôt), REGRESS_DB (défaut data/cine.db), REGRESS_MEDIA, REGRESS_PORT
# (3098), REGRESS_NETWORK (media_net), REGRESS_PROFILES, REGRESS_ONLY (clés de titres, virgules)

tools/regress-lecteur/regress.sh run <ref A> $REGRESS_WORK/res-A
tools/regress-lecteur/regress.sh run <ref B> $REGRESS_WORK/res-B
tools/regress-lecteur/regress.sh compare $REGRESS_WORK/res-A $REGRESS_WORK/res-B   # sortie 1 si écart
```

Pour itérer : `build`, `start`, `play <ref> <dossier>`, `stop`, `clean` séparément. Un passage
complet dure environ une heure (36 séances, profils l'un après l'autre : les lignes d'une séance
sont découpées dans le journal par position, deux navigateurs en même temps les mêleraient).

Le dossier de travail garde les dépendances de Playwright (`pw/`, écrites par root dans le
conteneur) d'un passage à l'autre ; pour les retirer :
`docker run --rm -v "$REGRESS_WORK:/w" alpine:3.22 rm -rf /w/pw`.

Chaque dossier de résultats contient `brut.json` (lignes telles qu'écrites, issues des étapes),
`normalise.json` (ce qui est comparé), `couverture.txt` (ce que chaque moteur a réellement
exercé) et, en cas d'échec d'une étape, une capture d'écran.

## Ce qui est comparé

Gardé : le genre et l'ordre des lignes (`start`, `opening`, `seek`, `audio`, `rebuild`, `network`,
`stall`, `fallback`, `error`, `stop`), le chemin (`remux` / `serveur`), les motifs de relais et les
chaînes de refus **exactes**, les pistes changées et ce qui a été fait du son (`copié tel quel`,
`décodé puis ré-encodé en …`), `openedFrom`, les motifs de reconstruction, les compteurs du bilan
`stop` (sauts, changements de piste son et sous-titres, arrière-plans, reconstructions, reprises,
erreurs) et les attentes par paliers (0 / 1-2 / 3-5 / 6+) ; côté navigateur, l'issue de chaque
étape et la nature de la source de l'élément (`blob` = MediaSource, `hls`, `url`).

Écarté : horodatages, séances, build, version, agent, toutes les durées, débits, réserve, `diag.*`,
`timeline`, la trace (`steps`), les positions exactes. Les lignes d'une séance sont rangées par
genre puis par ordre d'écriture : le moment où `opening` part par rapport aux premiers sauts dépend
de la charge de la machine, pas du code.

## Bruit mesuré

Deux passages du même commit (9.3.12, 22-23/10/2026), 9 titres × 4 profils = 36 séances, environ
64 minutes chacun (construction de l'image en cache comprise) :

- **33 identiques** une fois mis à part ce qui dépend de la charge de la machine (`volatil`, ci-dessus).
  Avant cette mise à part, les écarts étaient tous de cette nature : le nombre de sauts que hls.js
  compte au lecteur serveur pour un même geste (5 ou 6, 9 ou 11), les attentes (palier 1-2 contre
  3-5), une ligne `stall` de plus ou de moins, une reprise (`recoveries`) 0 ou 1.
- **2 instables connus**, marqués `"instable": ["webkit"]` dans `titres.json` : les deux 4K Dolby
  Vision les plus lourdes dans WebKit **bureau**. Le décodage HEVC 4K y est logiciel (GStreamer) et
  n'a pas le temps réel à 1440×900 : selon la charge, la source se ferme (« Media failed to decode:
  Failed to send data for decoding ») et le lecteur reconstruit 1 à 4 fois, ou se bloque et reprend.
  Le même fichier dans le profil iPhone (même moteur, petit écran) est identique d'un passage à
  l'autre. Un écart y est affiché `~`, jamais compté.
- **1 écart isolé** : une fois, dans WebKit bureau, la session est tombée au milieu d'un titre (une
  requête du flux refusée « due to access control checks », puis l'écran de connexion). Il est
  désormais nommé « session perdue » dans les étapes. Un troisième passage de WebKit seul (18 min)
  l'a redonné identique, comme les six autres titres stables de ce profil. S'il se reproduit,
  repasser : un tel écart sur un seul titre n'est pas un comportement du lecteur.

Une comparaison qui sort `≠` sur un autre couple titre × profil est donc à lire : le diff montre la
ligne qui a changé et les compteurs volatils des deux côtés.

## Ce que le banc couvre vraiment

Mesuré le 22/10/2026 avec l'image Playwright 1.63 (`couverture.txt` le redonne à chaque passage) :

| Profil | Ce que le moteur accepte | Ce que le banc exerce réellement |
|---|---|---|
| **Chromium 153** (headless de Playwright ; le canal `chrome` stable installé dans l'image dit exactement la même chose) | H.264, AAC, FLAC, Opus ; **ni HEVC, ni AC-3/E-AC-3** ; `AudioEncoder` Opus | Tout fichier HEVC part au **lecteur serveur** (hls.js) sur le refus nommé `Vidéo non prise en charge par ce navigateur : video/mp4; codecs="hvc1…"` — relais, renégociation au changement de piste (`why: audio`), bilan serveur. Les fichiers H.264 prennent le **remux** : AC-3 et DTS décodés puis ré-encodés en Opus, le MP4 (H.264 + AAC) lu par `mp4Demux` |
| **Firefox 155** | HEVC (4K 10 bits compris, couche de base des Dolby Vision), H.264, FLAC, Opus | Le **remux sur tout** : E-AC3, AC-3, DTS et **TrueHD** (décodeur WebAssembly) décodés puis ré-encodés en Opus, FLAC 24 bits copié tel quel ; MP2 refusé par son nom puis lecteur serveur |
| **WebKit 26.6** (GTK, GStreamer) bureau | `ManagedMediaSource` (élément en `srcObject`), HEVC, H.264, AC-3, E-AC-3, FLAC ; **`AudioEncoder` présent mais inutilisable** (« AudioEncoder is not configured ») | Le **remux** avec son **copié** (AC-3, E-AC-3, FLAC). Tout ce qui demande un ré-encodage est refusé : un fichier en DTS seul part au lecteur serveur, un passage à la piste TrueHD est refusé (`audio` avec `applied: false`, l'ancienne piste continue). C'est le chemin d'un refus de piste, pas celui de Safari |
| **iPhone émulé** (même WebKit, agent et écran d'iPhone, toucher) | comme WebKit bureau | Les mêmes chemins, avec l'interface du téléphone (fiche mobile, commandes au toucher) ; stable même en 4K |

Ce qui n'est **pas** exercé ici : le HLS natif de Safari (WebKit pour Linux joue le lecteur serveur
par hls.js), le décodage Dolby Vision, l'encodeur AAC d'Apple et son ordre des canaux, le plafond
de 105 Mo des tampons de l'iPhone, la diffusion (AirPlay, Chromecast), le hors-ligne.

Constat, stable d'un passage à l'autre : pour deux fichiers H.264 (l'épisode en MP2 dans Chromium
et WebKit, le film en DTS seul dans WebKit), le **lecteur serveur ne montre jamais sa première
image** — `error` « pas de première image en 20 s », étape `image`, puis « Le chargement prend trop
de temps ». Le même lecteur serveur joue les sources HEVC (Chromium), l'épisode en DTS (WebKit) et
l'épisode en MP2 dans Firefox. Rare en production (deux lignes dans le journal courant) ; à regarder
à part, ce banc ne fait que le constater.

## Limites

- **Ce ne sont pas les navigateurs des spectateurs.** WebKit est celui de Linux (GStreamer), pas
  celui d'iOS ou de macOS : ni `AudioToolbox`, ni le plafond de 105 Mo par tampon de l'iPhone, ni la
  lecture HLS d'AppleTV/AirPlay. Le profil « iphone » n'émule que l'agent, l'écran et le toucher.
  Chromium n'a pas de décodeur HEVC sans GPU (le canal `chrome` stable non plus, vérifié) : tout
  fichier HEVC y part au lecteur serveur. Ce qu'un moteur réel refuse ou accepte sur un appareil
  reste à voir sur l'appareil.
- **Le parcours est un parcours.** Il n'essaie ni les rafales de sauts, ni la diffusion, ni le
  hors-ligne, ni les longues lectures (le banc d'appareil du panneau Compte, DOC-TECH « Device test
  bench », mesure l'horloge et les images ; celui-ci compare des comportements).
- **Le réseau est local** : aucune ligne `network`, aucun choix de qualité plus légère, presque
  jamais d'attente. Un défaut qui ne paraît que sur un lien lent n'y paraît pas.
- **Le lecteur serveur dépend de Jellyfin** (transcodage en direct) : ses temps varient, et une
  machine chargée peut faire dépasser un délai.
- **La bibliothèque change** : un titre retiré de `titres.json` ou du catalogue est noté « absent du
  catalogue », et les deux passages comparés doivent être faits le même jour.
