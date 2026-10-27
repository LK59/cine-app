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

### Attendre une condition, pas une durée

Chaque étape attend ce qu'elle peut **constater**, avec un plafond — jamais une durée fixe :

| Étape | Condition attendue |
|---|---|
| ouvrir | la page a envoyé sa ligne `ouverture` (requête `/api/startup-timing` partie), puis le bouton de lecture est là, dans la fiche (`data-sheet-morph-root`) |
| première image | l'horloge de l'élément avance ; l'issue est fixée plus tôt si une ligne `error` de la séance est écrite, ou si le lecteur serveur n'a rien montré 40 s après sa dernière négociation (son propre chien de garde est de 20 s) |
| sauts | le saut est **parti** (`seeking`, ou la position a bougé de plus de 3 s), puis l'horloge avance ; plafond 60 s |
| poses entre étapes | le film a joué 2 s (après la première image), 1,5 s (après chaque saut, la piste son, les sous-titres), 1 s (avant de fermer) **de film** — l'horloge de l'élément, pas la montre : ce qui est derrière la tête au saut de −10 s (`buffered`) en dépend |
| menus | deux lectures de suite donnent les mêmes lignes ; après un choix, le menu est refermé |
| piste son | la ligne `audio` de la séance (ou `start` du lecteur serveur, un relais, une erreur), puis l'horloge |
| sous-titres | un fichier à côté du film est demandé au choix même : on attend sa réponse ; une piste du film ne demande rien (1 s pour voir partir une demande) |
| épisode suivant | la ligne `start` du nouvel épisode, puis l'horloge |
| fermer | la ligne `stop`, puis 500 ms sans nouvelle ligne de la séance |

Restent fixes les gestes dont la durée est le geste : la pause (3 s, comptées une fois l'élément
constaté arrêté) et l'arrière-plan (6 s).

Les lignes d'une séance sont celles écrites depuis son début **et** portant l'agent de son
navigateur (ou aucun agent : une erreur du serveur lui-même). `brut.json` garde, par séance,
l'heure de chaque étape et de quelques repères (`timings`) : c'est ce qui dit où part le temps.

### Le compte

Uniquement un compte Jellyfin **standard dédié aux tests**, jamais celui d'une personne réelle ni
l'administrateur de `.env`. Ses identifiants sont lus dans un fichier (`user=` / `password=`)
monté en lecture seule dans le conteneur Playwright ; ils ne sont ni affichés ni écrits. Le banc ne
fait aucune action à effet réel : ni demande, ni signalement, ni réglage (l'écran d'accueil du
compte ne s'affiche pas : le banc pose d'avance dans `sessionStorage` ce qu'y écrit « Passer », qui
n'enregistre rien côté serveur). Les seules écritures vers Jellyfin sont
celles de toute lecture (séance, position) — sur ce compte — et la déconnexion à la fin de chaque
profil rend l'appareil que la connexion avait inscrit.

## Lancer

```sh
export REGRESS_WORK=/chemin/jetable/regress     # dossier de travail (sources, données, dépendances)
export REGRESS_CREDS=/chemin/compte-de-test.txt # user=… / password=…
# REGRESS_ENV (défaut .env du dépôt), REGRESS_DB (défaut data/cine.db), REGRESS_MEDIA, REGRESS_PORT
# (3098), REGRESS_NETWORK (media_net), REGRESS_PROFILES, REGRESS_ONLY (clés de titres, virgules),
# REGRESS_PLAN (séances profil/titre, virgules), REGRESS_MODE=rapide|moyen|complet (voir plus bas)

tools/regress-lecteur/regress.sh run <ref A> $REGRESS_WORK/res-A
tools/regress-lecteur/regress.sh run <ref B> $REGRESS_WORK/res-B
tools/regress-lecteur/regress.sh compare $REGRESS_WORK/res-A $REGRESS_WORK/res-B   # sortie 1 si écart
```

Pour itérer : `build`, `start`, `play <ref> <dossier>`, `stop`, `clean` séparément. Donner un
commit plutôt qu'une branche : le dossier de données et le conteneur sont nommés d'après le commit
que la référence désigne **au moment de l'appel**, et une branche qui avance entre `start` et
`play` fait lire à `play` un journal vide.

Un passage complet dure **environ 32 minutes** (33 séances depuis le 27/10/2026, 36 avant, profils l'un après l'autre, construction
de l'image en cache et démarrage compris ; une heure et sept minutes avant le 23/10/2026).

### Trois niveaux

`REGRESS_MODE` choisit les séances selon ce qui a changé (27/10/2026) :

| Niveau | Séances | Durée | Pour |
|---|---|---|---|
| `rapide` | 8 | ~6 min | une retouche d'interface seule ; une dépendance déjà prouvée par son propre banc |
| `moyen` | 14 | ~18 min | une retouche ciblée du lecteur |
| `complet` (défaut) | 33 | ~32 min | une découpe, une fusion ou une refonte du lecteur, de la source MediaSource, des relais |

**`rapide`** joue Chromium et l'iPhone émulé sur quatre titres — The Kissing Booth, Arthur et les
Minimoys, Aftersun, The Knick. Il couvre : les deux interfaces (bureau à la souris, téléphone au
toucher), les deux lecteurs (Arthur, HEVC, part au lecteur serveur dans Chromium et au remux sur
l'iPhone ; The Knick, DTS, l'inverse), le changement de piste par reconstruction et par
renégociation, les sous-titres d'un fichier à côté (Aftersun) et d'une piste du film, l'épisode
suivant. Il ne couvre pas : Firefox (le remux de tout, TrueHD compris), le WebKit bureau, la 4K
Dolby Vision, les refus nommés (MP2, DTS seul).

**`moyen`** joue chaque profil sur ce qu'il est seul à éprouver, sans doublon :
Chromium — AC-3, le relais HEVC, DTS et l'épisode suivant, le refus MP2 ; Firefox — TrueHD en
WebAssembly, FLAC 24 bits, MP4 et sous-titres externes ; WebKit bureau — Dolby Vision 4K à six
pistes, les blocs sans image, DTS ; iPhone — TrueHD ré-encodé, MP4, DTS et épisode suivant, le
relais MP2 en HLS natif.

**`complet`** joue les neuf titres sur les quatre profils, moins trois séances qui n'apprennent rien :
Des gens bien sur Firefox et WebKit bureau (le refus MP2 est nommé avant tout navigateur, le relais
est le même que dans Chromium ; l'iPhone le garde, il le prend en HLS natif) et Blanche comme neige
sur WebKit bureau (aucune image dans les passages de référence, 60 s d'attente à chaque fois ;
l'iPhone la garde).

`REGRESS_PLAN` (`chromium/arthur,iphone/the-knick`…) remplace le niveau ; `REGRESS_PROFILES` /
`REGRESS_ONLY` l'emportent sur `rapide`. Un passage partiel se compare à un passage complet : chaque
passage écrit `plan.json` (ce qu'il devait jouer), et la comparaison ne compte pas ce qu'un côté
n'avait pas prévu (`·`).

### Une référence gardée

Un passage réussi sert de référence aux suivants : on ne rejoue que le candidat, et on le compare à
la dernière référence. Ranger le dossier de résultats d'un passage validé hors du dossier de travail
jetable, nommé d'après son commit. Si un cas diffère, rejouer ce cas seul (`REGRESS_PLAN`) sur le
commit de la référence et sur le candidat : l'écart vient-il du code, ou de ce qui a changé depuis ?

Le dossier de travail garde les dépendances de Playwright (`pw/`, écrites par root dans le
conteneur) d'un passage à l'autre ; pour les retirer :
`docker run --rm -v "$REGRESS_WORK:/w" alpine:3.22 rm -rf /w/pw`.

Chaque dossier de résultats contient `brut.json` (lignes telles qu'écrites, issues et heures des
étapes), `normalise.json` (ce qui est comparé), `couverture.txt` (ce que chaque moteur a réellement
exercé), `plan.json` (les couples profil × titre prévus) et, en cas d'échec d'une étape, une
capture d'écran.

## Ce qui est comparé

Gardé : le genre et l'ordre des lignes (`start`, `opening`, `seek`, `audio`, `rebuild`, `network`,
`stall`, `fallback`, `error`, `stop`), le chemin (`remux` / `serveur`), les motifs de relais et les
chaînes de refus **exactes**, les pistes changées et ce qui a été fait du son (`copié tel quel`,
`décodé puis ré-encodé en …`), `openedFrom`, les motifs de reconstruction, les compteurs du bilan
`stop` (sauts, changements de piste son et sous-titres, arrière-plans, reconstructions, reprises,
erreurs) et les attentes par paliers (0 / 1-2 / 3-5 / 6+) ; côté navigateur, l'issue de chaque
étape et la nature de la source de l'élément (`blob` = MediaSource, `hls`, `url`).

Écarté : horodatages, séances, build, version, agent, toutes les durées, débits, réserve, `diag.*`,
`timeline`, la trace (`steps`), les positions exactes, et, d'une marche de l'échelle du lecteur
serveur (`trigger`), le témoin qui l'a vue le premier (« élément : code 3 » ou « hls.js : média » :
une course, tranchée tantôt d'un côté tantôt de l'autre par le même commit) — ce qu'elle fait
(« → image en H.264 ») reste comparé. Les lignes d'une séance sont rangées par
genre puis par ordre d'écriture : le moment où `opening` part par rapport aux premiers sauts dépend
de la charge de la machine, pas du code.

## Bruit mesuré

Deux passages du même commit avec le parcours actuel (23/10/2026), 9 titres × 4 profils = 36
séances, 2 097 s et 1 816 s (construction et démarrage compris), sur une machine où tournaient par
moments les tests d'un autre chantier (charge moyenne 10 pour 12 cœurs) :
**36 identiques sur 36**, instables connus compris.

Ce que la comparaison met de côté, et pourquoi :

- **`volatil`** (affiché, jamais compté) : ce qui dépend de la charge de la machine et non du code
  — le nombre de sauts que hls.js compte au lecteur serveur pour un même geste (5 ou 6, 9 ou 11),
  les attentes (palier 1-2 contre 3-5), une ligne `stall` de plus ou de moins, une reprise
  (`recoveries`) 0 ou 1.
- **Les instables connus**, marqués `"instable"` dans `titres.json` et affichés `~` : les deux 4K
  Dolby Vision les plus lourdes dans WebKit bureau, et *Dirty Dancing* aussi dans le profil iPhone.
  Le décodage HEVC 4K y est logiciel (GStreamer) et n'a pas toujours le temps réel : selon la charge,
  la source se ferme (« Media failed to decode: Failed to send data for decoding ») et le lecteur
  reconstruit 1 à 4 fois, ou se bloque et reprend, et l'instant où cela arrive tombe avant ou après
  l'arrière-plan. Sur l'iPhone émulé, *Dirty Dancing* est sorti deux fois différent sur quatre
  passages du parcours actuel (deux reconstructions, ou une source fermée en arrière-plan).
- Le **témoin** d'une marche de l'échelle du lecteur serveur (voir « Ce qui est comparé »).

Avant le 23/10/2026 (parcours à attentes fixes, 9.3.12) : 33 identiques sur deux passages de
64 minutes, 2 instables, 1 écart isolé (une session tombée au milieu d'un titre dans WebKit,
nommée depuis « session perdue » dans les étapes ; s'il se reproduit, repasser).

Une comparaison qui sort `≠` sur un autre couple titre × profil est donc à lire : le diff montre la
ligne qui a changé et les compteurs volatils des deux côtés.

## Ce qui a été essayé

Mesuré le 23/10/2026 — un passage complet durait 4 025 s, dont 3 787 s de séances :

- **Gardé — les attentes sur conditions** (tableau plus haut). Le gros du temps n'était pas dans
  les `sleep` eux-mêmes (~38 s par séance) mais dans ce qu'ils cachaient : Playwright met 2 à 3 s à
  résoudre un sélecteur `:has()` ou un `getByRole` sur la page entière (l'accueil reste monté sous
  le lecteur), à chaque ligne de menu lue — plus d'une minute par séance dans Firefox, qui passe de
  1 297 s à ~390 s. Les menus, le bouton de lecture et la ligne choisie se lisent désormais en un
  aller-retour (`page.evaluate`) et se désignent par une marque (`data-regress-pick`).
- **Gardé — l'issue fixée plus tôt** : les cinq séances qui échouent toujours à la première image du
  lecteur serveur durent 26 à 50 s au lieu de ~99 s, avec les mêmes lignes.
- **Gardé — des poses en temps de film** : supprimer les poses entre étapes changeait ce qui est
  enregistré (le `buffered` du saut de −10 s) et faisait échouer WebKit (une pause ignorée par le
  lecteur serveur juste après un saut, une source fermée sur un saut lancé avant que le précédent
  soit posé). Remplacées par « le film a joué N s », elles coûtent ce qu'elles coûtaient mais ne
  dépendent plus de la charge.
- **Écarté — deux voies en parallèle** (Chromium + Firefox d'un côté, WebKit + iPhone de l'autre,
  même instance, lignes départagées par l'agent, un verrou par titre pour le compte commun) :
  1 603 s au lieu de ~2 050 s, soit 25 % seulement, et **6 séances sur 36 différentes** d'un
  passage à la file du même commit : sauts du lecteur serveur au-delà du plafond (le transcodage
  4K de Jellyfin et le décodage logiciel de WebKit se disputent les cœurs), une source fermée sur
  un 1080p dans l'iPhone émulé. Le gain ne vaut pas le bruit.

## Ce que le banc couvre vraiment

Mesuré le 22/10/2026 avec l'image Playwright 1.63 (`couverture.txt` le redonne à chaque passage) :

| Profil | Ce que le moteur accepte | Ce que le banc exerce réellement |
|---|---|---|
| **Chromium 153** (headless de Playwright ; le canal `chrome` stable installé dans l'image dit exactement la même chose) | H.264, AAC, FLAC, Opus ; **ni HEVC, ni AC-3/E-AC-3** ; `AudioEncoder` Opus | Tout fichier HEVC part au **lecteur serveur** (hls.js) sur le refus nommé `Vidéo non prise en charge par ce navigateur : video/mp4; codecs="hvc1…"` — relais, renégociation au changement de piste (`why: audio`), bilan serveur. Les fichiers H.264 prennent le **remux** : AC-3 et DTS décodés puis ré-encodés en Opus, le MP4 (H.264 + AAC) lu par `mp4Demux` |
| **Firefox 155** | HEVC (4K 10 bits compris, couche de base des Dolby Vision), H.264, FLAC, Opus | Le **remux sur tout** : E-AC3, AC-3, DTS et **TrueHD** (décodeur WebAssembly) décodés puis ré-encodés en Opus, FLAC 24 bits copié tel quel ; MP2 refusé par son nom puis lecteur serveur |
| **WebKit 26.6** (GTK, GStreamer) bureau | `ManagedMediaSource` (élément en `srcObject`), HEVC, H.264, AC-3, E-AC-3, FLAC ; **`AudioEncoder` présent mais inutilisable** (« AudioEncoder is not configured ») | Le **remux** avec son **copié** (AC-3, E-AC-3, FLAC). Tout ce qui demande un ré-encodage est refusé : un fichier en DTS seul part au lecteur serveur, un passage à la piste TrueHD est refusé (`audio` avec `applied: false`, l'ancienne piste continue). C'est le chemin d'un refus de piste, pas celui de Safari |
| **iPhone émulé** (même WebKit, agent et écran d'iPhone, toucher) | comme WebKit bureau | Les mêmes chemins, avec l'interface du téléphone (fiche mobile, commandes au toucher) ; stable en 4K sauf *Dirty Dancing* (voir « Bruit mesuré ») |

Ce qui n'est **pas** exercé ici : le HLS natif de Safari (WebKit pour Linux joue le lecteur serveur
par hls.js), le décodage Dolby Vision, l'encodeur AAC d'Apple et son ordre des canaux, le plafond
de 105 Mo des tampons de l'iPhone, la diffusion (AirPlay, Chromecast), le hors-ligne.

Constat, stable d'un passage à l'autre : pour deux fichiers H.264 (l'épisode en MP2 dans Chromium
et WebKit, le film en DTS seul dans WebKit), le **lecteur serveur ne montre jamais sa première
image** — `error` « pas de première image en 20 s », étape `image`, puis « Le chargement prend trop
de temps » (pour le film en DTS seul, aucune ligne `error` : l'élément reste arrêté, et le banc
conclut 40 s après la négociation). Le même lecteur serveur joue les sources HEVC (Chromium), l'épisode en DTS (WebKit) et
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
