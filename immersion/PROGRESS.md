# Mode « Immersion » — journal de chantier

Ce fichier suffit, avec le cahier des charges d'origine, à reprendre le chantier là où il s'est
arrêté. Il est mis à jour à la fin de chaque étape et avant toute opération longue. **Le relire en
entier après toute reprise.**

## État actuel (à jour)

- **10.35.1 le 11/11 au matin** (`929e2388`) : les corrections du premier essai du propriétaire sur iPhone — voir
  « Retour du propriétaire sur la v2 ».
- **V2 livrée : 10.35.0, en production depuis le 11/11/2026 vers 3 h 15** (`dcd3f449`) — voir « V2 — la nuit du
  11/11/2026 » plus bas : ce qui a été mesuré, ce qui ne l'a pas été.
- **Livré : 10.34.0, en production depuis le 10/11/2026 à 23 h 47** (`020a0b04`), puis **10.34.1 le 11/11 à 0 h 04**
  (`b14b2510` : l'interrupteur des tâches de fond, DECISIONS §145 — rien ne change dans le mode), puis **10.34.2 le
  11/11** (`6511d9a4` : la page ne se chargeait pas en production, voir « Pièges rencontrés »). Le mode est
  accessible en cherchant exactement `immersion` dans la recherche du cinéma (affiche « Le Chalet »).
- La branche `immersion` et `main` sont au même commit. La copie de travail à part (suffixe `-immersion`) reste
  l'endroit où travailler ; la copie principale reste sur `main`. `origin/immersion` porte un ancien historique
  (d'avant le rebase) : ne pas s'y fier, repartir de `main`.
- Contenu : le chalet complet (salon, cuisine, mezzanine, couloir, chambre, terrasse en surplomb et bain), trois
  télévisions synchronisées, lumière cuite en deux couches, « le chalet vivant » (voir plus bas), chaîne hi-fi,
  clavier AZERTY / QWERTY / QWERTZ.
- Vérifié : portail de l'application vert, tests du Dockerfile verts, huit scénarios Playwright verts sur le build
  de production servi par l'aperçu. **Pas vérifié** : les scénarios à travers l'image finale (voir « Incident »),
  et rien sur la machine cible — le bouton « Mesurer » des réglages donnera les chiffres.

### Incident du 10/11 — l'instance du banc et le masquage des demandes

Mon instance jetable (`tools/regress-lecteur/regress.sh start`) est restée ~7 h 30. Le banc lance l'application
avec le `.env` de la production : la tâche `requestHide` y tournait contre le vrai Jellyfin, avec une base recopiée
sans les décisions de masquage — toutes les cinq minutes elle retirait le tag de masquage des 92 titres cachés au
compte visé, et la production le remettait à son passage suivant. Arrêtée à 23 h 39 ; état rétabli par la
production. Corrigé dans le banc : `REQUEST_HIDE_ACCOUNT` vidé et X-Ray coupé au lancement (réglages `XRAY*` écartés
de la base recopiée). **À retenir : une instance du banc parle aux vrais services ; ne jamais la laisser tourner des
heures, et vérifier `docker logs` de l'instance dès son démarrage.** L'interrupteur unique demandé ensuite par
le propriétaire est livré en 10.34.1 : `CINE_BACKGROUND_JOBS=off`, que `regress.sh` passe à ses instances.

### Suite possible

- Mesures sur la machine cible (bouton « Mesurer »), puis réglage des préréglages d'après `startup.log`
  (`kind: "immersion-bench"`).
- Phase 2 : multijoueur (`docs/MULTIJOUEUR.md`), VR (`docs/VR.md`).
- Poids : `public/assets` fait 41 Mo pour 40 visés (lumière en deux couches, musique, terrasse).

## Règles de travail (rappel)

- **Portail de l'application** avant tout commit qui touche à son code, sans tuyau, code de sortie lu ;
  depuis la copie de travail, les dépendances de la copie principale sont montées en lecture seule :
  `docker run --rm -v "$PWD":/app -v <copie principale>/node_modules:/app/node_modules:ro -w /app node:26-alpine sh -c 'set -e; npm run typecheck; npm run lint -- --max-warnings=0; npm test'`.
  Quelques tests de chronométrage échouent seuls sous charge : relancer **au calme** (rien d'autre de
  lourd sur la machine) jusqu'au vert. Jamais de commit sur un portail rouge. Ne pas modifier le code de
  l'application pendant qu'un portail tourne.
- **Compte de test** : le compte Jellyfin de test de la maison, jamais un autre, jamais un compte réel ;
  identifiants dans `immersion/.env` (ignoré par git ; variables `JELLYFIN_TEST_USER` /
  `JELLYFIN_TEST_PASSWORD`). Jamais affichés. Aucune session sur la production : les tests de bout en bout
  tournent sur une instance jetable. Tout nettoyage côté Jellyfin se fait par l'identifiant exact du
  compte de test.
- **Déploiement**, aux jalons validés seulement : lectures en cours vérifiées d'abord ; version montée dans
  `package.json` et `package-lock.json` (commit à part) ; fusion dans `main` ; image construite depuis une
  copie propre de `main` (`docker build -t cine-app:latest --build-arg BUILD_REF=<sha> .`), puis
  `docker compose up -d --no-build` dans la copie principale, puis `docker builder prune -f --max-used-space 15GB` ;
  push en arrière-plan, CI lue après. Pas de page Nouveautés (c'est un secret).
- **Machine partagée** : conteneurs nommés `immersion-*`, supprimés après usage, `docker ps` vérifié en fin
  d'étape ; captures sur le processeur graphique brèves ; rendus Blender bornés (`--cpus 6`).
- **Poids** : ~40 Mo au total dans le dépôt et dans l'image, pas plus. Voir « Poids ».
- **Documents** (ce fichier, README, ASSETS, DECISIONS) : génériques — ni prénom, ni réglage personnel.

## Ce que le dépôt est vraiment (relevé avant de commencer)

Le cahier des charges parle d'un front React et d'un back FastAPI. Le dépôt est une application
**Next.js 16** (App Router, React 19, TypeScript, un seul conteneur). Conséquences :

- Pas de « montage statique FastAPI » : la page est servie par **deux routes de service** de l'application.
- Le navigateur ne parle jamais à Jellyfin : tout passe par `/api/jellyfin/*`, **sur la même origine**.
  **Aucun CORS à configurer** ; `crossOrigin="anonymous"` sur une vidéo de même origine donne une texture
  lisible et un son exploitable. Rien n'a été changé chez Jellyfin.
- Ni Node ni npm sur la machine : tout tourne dans Docker.
- La session est un cookie `httpOnly` vérifié par `src/proxy.ts`. `/immersion` et `/api/immersion/*` ne
  sont dans aucune liste publique : sans session, la page renvoie à la connexion (307) et les fichiers
  répondent 401. Un lien de partage n'y a pas accès.

## Décisions (et pourquoi)

### Service de la page — routes de service, pas `public/`

- `GET /immersion` (`src/app/immersion/route.ts`) rend `index.html` du build.
- `GET /api/immersion/<fichier>` (`src/app/api/immersion/[...path]/route.ts`) rend les fichiers du build.
  Vite a `base: "/api/immersion/"`. Logique commune : `src/lib/immersionFiles.ts` (types servis, cache
  `immutable` pour les fichiers nommés par leur contenu ou portant `?v=`, `.br` servi par les marqueurs
  de cadrage de l'application).
- Le build (`immersion/dist`) est produit par l'étape `immersion` du `Dockerfile` et copié sous
  `/app/immersion-dist`. Absent : les deux routes répondent 404.
- Pourquoi pas `public/immersion/` : le service worker recopie dans son cache tout GET hors `/api/` qui
  n'est ni une image ni une page, et ce cache n'est jamais purgé. Pourquoi pas le relais inverse : il est
  partagé et ne connaît pas la session.
- La politique de sécurité (CSP) générale suffit, à une condition : **aucune ressource embarquée dans un
  `.glb`** (three les relit par `fetch(blob:)`, que `connect-src` refuse). Modèles en `.gltf` + `.bin` +
  `.ktx2` séparés ; pas de police ni d'environnement chargés d'un CDN.

### Entrée — une affiche dans la recherche (DECISIONS.md §144)

Chercher exactement « immersion » pose en tête des résultats l'affiche « Le Chalet » / « Laterna
Experience » (`PlayerResultCard`). La presser part vers `/immersion`. Règle : `src/lib/immersionTrigger.ts`.
L'affiche est `immersion/public/poster.jpg` — **à produire** : une capture du vrai chalet (2:3), refaite
quand la scène change. (La première idée, rediriger sur `immersion*`, est abandonnée.)

### Accueil — « Laterna Experience »

La marque de Laterna animée (le L se dresse, le faisceau s'allume) sert d'écran de chargement : la barre
suit le chargement réel, puis devient « Cliquer pour entrer » (le geste qu'exigent le verrou du pointeur et
le son).

### Lecture — le chemin du lecteur serveur, même route (validé)

`POST /api/jellyfin/playback/start`, même corps que le lecteur serveur ; hls.js ; rapports
`progress` / `stop` ; reprise par `/api/jellyfin/playback-state/<id>`. Lus tels quels dans le code de
l'application (alias `@/` → `../src`) : `codecSupport.ts`, `webkitEngine.ts`, `networkBitrate.ts` (copiés
dans l'étape Docker). Quatre points validés par le propriétaire :

1. **Stéréo au plus** : `forceAudioTranscode: true` dans la demande (le profil plafonne à 2 canaux ; une
   piste stéréo lisible est copiée, le reste ré-encodé en AAC stéréo).
2. **Arrêt à chaque sortie** (« Quitter », `pagehide`, changement de film, fin, erreur) : un seul chemin,
   `finish()` dans `src/media/playback.ts` — rapport `stop` (Jellyfin coupe le transcodage) + ligne `stop`.
   **À vérifier en fin d'étape : plus aucune séance de transcodage du compte de test après une sortie.**
3. **Journal** : toutes les lignes (`start`, `stop`, `error`) portent `player: "immersion"`
   (`src/media/log.ts`). Côté application : `src/lib/activity/seances.ts` reconnaît ce lecteur et
   `diagnosis.ts` l'écarte du diagnostic « le fichier ou l'appareil ».
4. **HDR → SDR par le serveur, actif par défaut, pour les seuls fichiers HDR** : la plage vidéo est lue
   avant de négocier (`/api/jellyfin/direct/<id>` → `video.isHdr`) ; HDR → `lighter: true` (profil sans
   HDR, 1080p au plus) ; SDR → négociation normale. Réglage « Conversion HDR → SDR ». La ligne `start`
   porte `sdr: "serveur"`.

### Physique — `@react-three/rapier`

Contrôleur de personnage cinématique (capsule) : glissement le long des murs, marches franchies seules
(escalier de la mezzanine), collage au sol. Collisions = boîtes déclarées à côté de la géométrie.

### Panneau Laterna — drei `<Html transform>`

Du vrai DOM posé dans le monde, devant le visiteur, entre lui et la télévision la plus proche : texte net,
champ de recherche natif, affiches en `<img>`. Taille réglée pour ~1 pixel de contenu par pixel d'écran.

### Rendu — vidéo hors du mappage de tons

AgX dans le compositeur. La vidéo est redessinée **après** le compositeur, telle quelle, par une passe qui
relit la profondeur de la scène (`Television.tsx`) ; la version qui traverse le compositeur ne sert qu'au
halo. `VideoTexture` de three n'est téléversée qu'à chaque nouvelle image du film
(`requestVideoFrameCallback`, c'est three qui le fait).

### Stratégie qualité (décision du propriétaire)

Cible : **Ultra à la résolution native, 60 images/s, sur un Intel Core Ultra 7 155H (Arc intégré — précisé par le propriétaire le 10/11 ; le journal disait 255H / Arc 140T)**. Le
processeur graphique du serveur (UHD 630) n'est qu'un plancher de test.

1. **Lumière précalculée** (lightmaps + occlusion ambiante cuites dans Blender sans écran) pour toute la
   géométrie fixe, pièce par pièce. Elle remplace l'occlusion en espace écran (N8AO), qui reste au plus
   une option d'Ultra. — **À FAIRE.**
2. **Temps réel limité à ce qui bouge** : scintillement des bougies, lumière des écrans (ambilight),
   neige, une seule ombre dynamique au plus. Reflets par une capture de la pièce faite une fois
   (`Atmosphere.tsx`, fait).
3. **Vidéo** : téléversement par image seulement (fait, voir plus haut). Si un flux 4K copié pèse trop,
   mesurer une texture plafonnée à 1080p avant de décider.
4. **Préréglages** (`src/lib/settings.ts`, fait) : Ultra = tout, à la résolution native ; Élevé / Moyen /
   Bas en dessous ; **suréchantillonnage** (au-delà du natif) = option à part, coupée par défaut.
5. **« Auto » par défaut** (fait) : part d'Ultra ; le moniteur de performance baisse d'abord la résolution
   interne puis coupe les effets coûteux un par un (`AUTO_LEVELS`), et remonte s'il y a de la marge.
6. **Mesure sur la vraie cible** — **À FAIRE** : bouton « Mesurer » (réglages) qui joue un parcours de
   caméra fixe de 20 s par préréglage, avec et sans vidéo, et envoie images/s moyennes et 1 % bas au
   journal (`startup.log`, `kind: "immersion-bench"`, avec le nom du processeur graphique —
   `WEBGL_debug_renderer_info` — et la résolution réelle de rendu). C'est sur ces chiffres, relevés sur
   la machine cible, que se règlent Auto et l'objectif Ultra. Côté application : une branche de plus
   dans `/api/viewport-diag` (déjà ouverte aux comptes) et dans `logViewportDiag`.

### Décor extérieur en couches (retour du propriétaire — À FAIRE)

Les sapins en cônes et le relief simplifié trop près de la vitre cassent l'illusion. À remplacer par :

- **Fond** : une vraie chaîne de montagnes rendue **une fois, hors ligne** (Blender sans écran) à partir
  d'un relief réel libre (Copernicus GLO-30 ou SRTM — licence vérifiée et notée dans ASSETS.md), neige,
  clair de lune, ciel étoilé cohérent avec l'éclairage. Sortie : une grande image panoramique fixe
  (cylindrique ou équirectangulaire, KTX2 ou tuiles), vue longue (sommets à plusieurs kilomètres, vallée en
  contrebas). Coût à l'affichage : à peine plus qu'une texture.
- **Plan intermédiaire** : forêts et vallons en cartes / imposteurs à quelques centaines de mètres, avec un
  léger décalage de parallaxe.
- **Premier plan** : quelques vrais sapins 3D enneigés (instanciés), le sol de neige près du chalet ; la
  neige qui tombe reste devant.
- L'HDRI ne sert plus qu'à l'éclairage et aux reflets.

### Plusieurs télévisions synchronisées (À FAIRE)

- **Un** `<video>`, **une** `VideoTexture`, partagés par tous les écrans (salon, cuisine, autres pièces).
- Son : la même source vers une `PositionalAudio` **par écran** (panoramiques en parallèle depuis le même
  `MediaElementSource`) ; le son suit l'écran le plus proche ; le passe-bas derrière les murs reste.
- Ambilight par écran ; un écran hors de vue n'est ni rendu ni échantillonné.
- Une seule lecture, pilotée depuis n'importe quel écran (le panneau s'ouvre devant la télévision où l'on est).

### Chalet complet (À FAIRE)

Cuisine ouverte avec sa télévision, mezzanine avec escalier, couloir, chambre(s) — même finition que le
salon, pièce par pièce. Lumière précalculée par pièce. **Découpage par pièces** : ne dessiner que la pièce
courante et ce qui se voit par les ouvertures. Le **canapé** : c'est ce qui fait le plus « maquette » — un
vrai modèle ou une géométrie plus riche (coutures, coussins arrondis, plis), avec le tissu lin déjà choisi.

### Les portes de la VR et du multijoueur restent ouvertes (décisions — `docs/VR.md`, `docs/MULTIJOUEUR.md`)

Ni VR ni réseau en phase 1 : **aucun code WebXR, aucun `@react-three/xr`, aucun WebSocket**. Mais
l'architecture ne ferme rien, et c'est fait :

- **Interface séparée de la scène** : l'état du panneau, du menu, des réglages et de la lecture vit dans
  `src/state/store.ts` ; tout passe par `src/state/actions.ts`. Les composants de `src/ui/` dessinent
  l'état et appellent les actions — un rendu en 3D lirait le même état.
- **Entrées par une couche d'intentions** (`src/input/intents.ts`) : « ouvrir », « valider », « s'asseoir »,
  « retour », un mouvement, un regard. Clavier et souris (`keyboardMouse.ts`) ne sont qu'un périphérique.
- **Personnage ≠ caméra, et pas de singleton** (`src/world/rig.ts`) : un registre de personnages
  (identifiant, position, orientation) ; celui de la page est l'entrée `local` ; `Player.tsx` pose la
  caméra d'après lui.
- **L'état de lecture est la vérité, le `<video>` le suit** : ce qui est voulu (titre, pause, saut) est
  écrit dans `Playback` par les **commandes** (`src/media/commands.ts`, `dispatch`) ; `follow()` dans
  `src/media/playback.ts` y conforme l'élément. Aucun composant ne touche au `<video>`.
- **Rien ne suppose un seul compte** : chaque page négocie, rapporte et journalise sous sa session.
- Réglages de rendu par préréglages (un futur « VR » s'y ajoute).

## Plan de travail (ordre)

1. [x] Dossier `/immersion`, entrée par la recherche, service de la page, déplacements et collisions
2. [x] Salon : géométrie, matières, lumière temps réel, mobilier, objets
3. [x] Télévision, vidéo, son spatialisé, rapports Jellyfin, journal — **vérifié de bout en bout** avec le
       compte de test sur l'instance jetable (`tests/e2e/03-lecture.spec.ts`) : film SDR, film HDR converti
       en SDR 1080p, pause / sauts / reprise par les commandes, arrêt au changement de film et à la sortie
       de page (position écrite côté Jellyfin), aucun ffmpeg restant. Seul un navigateur tué net laisse une
       séance, que Jellyfin referme de lui-même
4. [x] Panneau dans le monde, HUD, menu pause, réglages — scénarios : `02-monde`, `03-lecture` (reste : un
       scénario du panneau)
5. [x] Couche d'intentions et d'actions, interface pilotée par le store, commandes de lecture, registre de personnages ; `docs/VR.md`, `docs/MULTIJOUEUR.md`
6. [x] Plusieurs télévisions : une texture partagée, un haut-parleur par écran, une lumière d'écran qui suit le visiteur (`Screens.tsx`) — **reste : poser les écrans de la cuisine et de la chambre dans de vraies pièces**
7. [x] Pièces : cuisine + TV, mezzanine + escalier, couloir, chambre ; découpage par pièces (`visibleGroups`) ;
       canapé : vrai modèle (`tools/sofa/`, 84 000 triangles, 1,36 Mo) avec le tissu de la maison, la version en
       boîtes en secours si le modèle ne se charge pas
8. [x] Extérieur en couches (`Exterior.tsx`, `Snow.tsx`) : ciel + panorama lointain (`public/assets/panorama/`,
       relief Copernicus GLO-30 rendu dans Blender par `tools/panorama/`), deux couches détourées sur cylindres
       (parallaxe ; la plus proche s'efface hors de l'axe de la vallée), sol de neige, sapins instanciés en
       couronnes de branches (neige posée par le programme), neige qui tombe. Vérifié sur captures (`vallee`,
       `baie`, `ouest`). Sans panorama le ciel de secours suffit
9. [~] Lumière précalculée : `tools/bake/export.ts` (géométrie en OBJ dans l'ordre des sommets de la page +
       `scene.json` : lumières, teintes, boîtes d'ombre des objets posés) → `tools/bake/bake.sh` (Blender Cycles,
       ~21 min à 192 échantillons, étalonnage vérifiable par `--calibrate`) → `public/assets/lightmaps/` (4 atlas,
       4,2 Mo) ; côté page `lightmaps.ts` (UV de lumière posés si les sommets témoins concordent, variante de
       matière : diffuse = lightmap seule, la lumière de l'écran en plus, reflets gardés), `Lights.tsx` réduit à
       trois lumières sans ombre, plus de N8AO ni d'ombres temps réel quand la lumière cuite est là.
       Première cuisson livrée et chargée par la page. **Reste : relancer `export.sh` (boîtes d'ombre des objets
       ajoutées après le premier export) puis `bake.sh --samples 192`, vérifier chaque pièce sur captures,
       commiter `public/assets/lightmaps/` et `tools/bake/`**
10. [x] Bouton « Mesurer » (`src/bench/bench.ts`, `ui/BenchOverlay.tsx`, bloc dans les réglages) + ligne
        `immersion-bench` (route `viewport-diag`, test) — **reste : le portail vert avant de commiter le côté
        application, et un passage réel sur l'instance jetable**
11. [ ] Affiche `poster.jpg` (capture), finitions, captures de référence, tests complets
12. [ ] Rebase sur `main`, portail, version 10.34.0, fusion, build, déploiement, vérification, push

Sous-traitance (agents plus légers, tâches mécaniques bornées) : panorama Blender à partir d'un relief réel ;
modèle du canapé ; script de cuisson des lightmaps. L'architecture et le rendu restent ici.

## Fichiers touchés hors de `/immersion`

| Fichier | Nature |
|---|---|
| `src/components/player/PlayerSearchPanel.tsx` | **modifié** : l'affiche du Chalet (un import, trois endroits) |
| `src/lib/immersionTrigger.ts` | nouveau : la règle (le mot, l'adresse, l'affiche) |
| `src/lib/immersionFiles.ts` | nouveau : lecture des fichiers du build |
| `src/app/immersion/route.ts`, `src/app/api/immersion/[...path]/route.ts` | nouveaux : la page, ses fichiers |
| `src/lib/activity/seances.ts`, `src/lib/activity/diagnosis.ts` | **modifiés** : le lecteur « immersion » reconnu, écarté du diagnostic (demandé : point 3 de la lecture) |
| `src/__tests__/immersion-{trigger,files,proxy,activity}.test.ts` | nouveaux |
| `DECISIONS.md` | §144 |
| `Dockerfile` | étape `immersion`, copie du build, `rm -rf immersion` dans l'étape de l'application |
| `.dockerignore` | ce qui n'entre pas dans le build |
| `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts` | `immersion` exclu, comme `streamdeck-plugin` |
| `src/app/api/viewport-diag/route.ts`, `src/lib/eventLogs.ts`, `src/__tests__/viewport-diag-route.test.ts` | **modifiés** : la ligne `immersion-bench` (point 6 de la stratégie qualité) |

## Environnements de travail

- **Build** : `docker run --rm --user $(id -u):$(id -g) -e HOME=/tmp -v "$PWD/..":/repo -w /repo/immersion node:26-alpine npm run build`
  (le `tsc` strict puis Vite). Mise au point : `npx vite build --minify false`.
- **Aperçu** : `vite preview` dans un conteneur `immersion-preview` (port local 5198) ; avec
  `LATERNA_URL=http://127.0.0.1:3097`, les routes de l'application sont relayées vers l'instance jetable.
  Il sert le build **sous la politique de sécurité de l'application**, lue dans `next.config.js`. Sans instance
  derrière, `SANS_APPLICATION=1 BASE=http://127.0.0.1:5198 tests/run.sh e2e/02… 05… 06… 07… 08…` rejoue ce qui ne
  demande rien à l'application (les scénarios 01, 03 et 04 ont besoin d'une instance).
- **Instance jetable** de l'application : `tools/regress-lecteur/regress.sh build|start|clean <commit>`
  (variables `REGRESS_WORK`, `REGRESS_ENV`, `REGRESS_DB`, `REGRESS_PORT=3097`) — image construite depuis un
  commit, données jetables. Ses fonctions de fond qui parlent à d'autres services sont coupées dans **sa**
  base après démarrage.
- **Captures** : `tests/capture.sh <vues…>` (Playwright 1.63, Chromium sans écran, processeur graphique de la
  machine par `--device /dev/dri` + `--use-angle=gl-egl`). `TV=1` joue une mire ; `STATE=<fichier>` donne la
  session ; `QUALITY=` choisit le préréglage. Vues : `entree salon tv baie canape charpente retour`, et
  l'interface : `panneau fiche pause reglages`.
- **Scénarios** : `tests/run.sh` (`tests/e2e/`).
- **Assets** : `tools/assets/` (image `immersion-assets-tools` ; `fetch.py`, `build.sh`, `gen-assets-md.py`).

## Pièges rencontrés (ne pas les refaire)

- Une texture dont un côté n'est pas une puissance de deux, compressée par blocs avec mipmaps et répétée,
  sort **noire** : le pipeline ramène tout à des puissances de deux.
- N8AO 2.0 en demi-résolution casse avec three r187 (cible de rendu multiple) : toujours en pleine résolution.
- `EffectComposer` (postprocessing 6.39) : la profondeur stable n'existe que si on appelle
  `createDepthTexture()` ; membres internes — version épinglée.
- La passe de la vidéo vit dans sa propre scène : c'est la matrice **locale** de sa dalle qu'il faut poser.
- Avec les matières ordinaires, la lumière du lustre sortait par la baie et grisait la neige : le dehors a
  ses propres shaders, qui ignorent les lumières de la pièce.
- La sortie « standalone » de Next emporte tout le dossier du projet : `immersion/` est retiré de l'étape de
  build de l'application.
- Le verrou du pointeur est demandé de façon asynchrone : dans un script, rendre le pointeur avant d'ouvrir
  le menu pause, sinon le mode repasse en « visite ».
- `tsc` de `/immersion` n'inclut pas `vite.config.ts` (il lui faudrait les types de Node).

- **La page tourne sous la politique de sécurité de l'application, et tout test doit la subir aussi**
  (11/11/2026). En 10.34.0 et 10.34.1 le chargement restait à 86 % en production : le transcodeur Basis de three
  (colle « embind » d'emscripten) fabrique ses fonctions avec `new Function`, interdit par `script-src` sans
  `'unsafe-eval'`, jusque dans le travailleur de `KTX2Loader` — aucune texture ne se décodait. Les huit scénarios
  étaient verts : l'aperçu ne posait pas cette politique. Depuis : le transcodeur est émis sans fabrication de
  code (`withoutEval`, `vite.config.ts` — le build échoue si three change le fichier), l'aperçu pose la politique,
  et SMAA (tables en images `data:`, refusées par `img-src`) a laissé place à FXAA. Avant d'ajouter une
  dépendance qui charge du WebAssembly, un travailleur ou des images embarquées : chercher `Function(`, `eval(` et
  `data:image/` dans `dist/`. Reste dans le bundle un `Function(…)` de la colle de Rapier, jamais appelé quand
  `globalThis` existe (la physique tourne sous la politique, scénario 02).

- **Ne jamais relire l'image de la vidéo par un canevas 2D** (11/11/2026, première mesure sur la machine cible :
  56 images par seconde écrans éteints en Ultra, 21 avec vidéo, et la même chute à tous les préréglages). La
  copie réduite pour l'ambilight passait par `drawImage(video)` + `getImageData`, quinze fois par seconde : pour
  une image décodée par la carte graphique, le navigateur la rapatrie en mémoire et le rendu attend. Elle est
  faite par la carte graphique (petite cible de rendu, `Screens.tsx`) et relue sans attendre
  (`readRenderTargetPixelsAsync`). Et la mire de la mesure, un canevas capté en flux, pesait elle-même sur la
  mesure : c'est un fichier (`assets/bench/mire.webm`). La ligne `immersion-bench` porte `maxMs`, `over33`,
  `over50`, `slowAt` pour situer les à-coups — à lire avant de retoucher quoi que ce soit au rendu.

- **Un import `@/lib/…` de plus dans `immersion/src` doit être ajouté au `COPY` de l'étape `immersion` du
  `Dockerfile`** (11/11/2026) : cette étape ne reçoit que les fichiers de l'application qu'on lui nomme. Le build
  lancé depuis le dépôt entier passait ; celui de l'image a échoué (`Cannot find module '@/lib/trackLabel'`). Pour
  le voir avant : `docker build --target immersion .` depuis la racine.

## Poids

- `public/assets/` : **46 Mo** au 11/11/2026 (v2) — textures, modèles, panorama, lightmaps (13 Mo : six atlas,
  trois couches), musique, mire de mesure (1,4 Mo). C'est au-dessus des 40 Mo visés au départ.
- Leviers si besoin : les couches `ecrans` sont lisses — encodées à demi-définition elles perdraient ~2 Mo sans
  se voir ; les jeux de textures inutilisés (`metal_black`, `bark`), les HDRI si la vue n'en dépend plus, les
  modèles non posés.

## « Le chalet vivant » (demandé le 10/11 au soir — fait d'une traite, à livrer en une fois)

Le propriétaire a demandé les sept points d'un coup, plus une chaîne hi-fi, « magnifique même si c'est plus
coûteux, tant que ça reste raisonnable : en Ultra, correct sur une machine sans carte graphique dédiée ».

1. [x] **Le vrai reflet du film** et 4. [x] **l'ambilight par zones** : `screenLight.ts`, greffé sur toutes les
       matières standard (prototype de `MeshStandardMaterial` + les trois matières à retouche propre). Six zones
       par écran, halo sur le mur porteur, reflet par rayon réfléchi sur le plan de la dalle (image nette + copie
       48×27 pour les surfaces rugueuses). Tous les écrans éclairent, chacun dans le volume de sa pièce. La
       lumière rectangulaire de three est retirée.
2. [x] **Mode cinéma** (`Lights.tsx`, réglage `cinema`, actif par défaut) : les lampes tombent à 10 % pendant
       un film, 45 % en pause. Repose sur la **cuisson en deux couches** (`nuit` / `lampes`, `lightmaps.ts`,
       `tools/bake/`) ; avec une cuisson d'une seule couche, tout baisse ensemble.
3. [x] **Le feu** (`Fire.tsx`, `FIRE` dans le plan) : foyer en ruban creusé dans le massif sous le manteau,
       flammes et braises en bruit, lueur dansante par `screenLight`, crépitement spatialisé. S'allume et
       s'éteint (E).
5. [x] **Le dehors** : ciel avec nuages qui dérivent et aurore par moments (`Exterior.tsx`) ; **terrasse**
       (`geometry/terrace.ts`, groupe cuit `terrasse`) avec garde-corps enneigé et **bain nordique**
       (`HotTub.tsx` : eau, vapeur, bouillonnement) ; **porte-fenêtre** coulissante (`Door.tsx`). Panorama v2
       (forêts, village) : sous-traité, à intégrer.
6. [x] **Matières de près** : givre au bas des vitres (`glass.ts`), poussière dans le faisceau (`Dust.tsx`),
       grain léger (`Effects.tsx`). Canapé v2 (plis, coussins, plaid) : sous-traité, à intégrer.
7. [x] **Des choses à faire** (`interactions.ts`) : s'allonger sur le lit, entrer dans le bain, lampes par
       pièce, feu, porte, chat (`Cat.tsx`), musique. Scénario `07-vie` vert.
8. [x] **Chaîne hi-fi** (`HiFi.tsx`, `media/music.ts`) : platines au salon et dans la chambre, une enceinte par
       pièce (portée et filtre comme les écrans), deux morceaux de jazz calme (Kevin MacLeod, CC BY 4.0, crédités
       dans les réglages et `ASSETS.md`), tue pendant un film.

**Limites connues** : les interrupteurs agissent par groupe de pièces (salon / cuisine-mezzanine / chambre-
couloir), pas lampe par lampe — une couche de lightmap par lampe coûterait trop ; la lumière des écrans et du feu
ne projette pas d'ombre ; les objets posés (modèles) ne sont pas cuits.

**État au 10/11, 23 h 30 — prêt à livrer.** Cuisson finale en deux couches faite (cinq atlas, 8,6 Mo), panorama
v2 intégré, appliques ajoutées dans la chambre. Portail de l'application **vert** (`logs/gate-1.log`, 846 fichiers,
`exit=0`) sur l'arbre rebasé en 10.34.0 ; rien n'a changé hors de `immersion/` depuis. Les huit scénarios
Playwright passent sur le build de production. Poids de `public/assets` : 41 Mo.

**Reste** : instance jetable du commit final et scénarios à travers l'application ; fusion dans `main` (avance
rapide) ; image depuis une copie propre ; bascule ; vérification ; push ; CI ; prévenir l'autre session (scan X-Ray
à relancer) ; ménage (`cine-regress-*`, `immersion-preview`).

## Phase 2

- **VR** : voir [`docs/VR.md`](docs/VR.md).
- **Multijoueur** : voir [`docs/MULTIJOUEUR.md`](docs/MULTIJOUEUR.md).
- Mini-jeux, mobile : hors périmètre de la phase 1.

## Problèmes ouverts

- Sous-traitances en cours : panorama Blender (`tools/panorama/`), cuisson des lightmaps (`tools/bake/`) ;
  image Blender partagée `immersion-blender` (`tools/blender/`). Le canapé est livré et intégré.
- Avec la lumière cuite, les objets posés (modèles) ne projettent plus d'ombre temps réel : leur ombre vient
  des boîtes d'ombre de l'export (`propShadows`, à tenir à jour si un objet déménage dans `Props.tsx`).
- Sous forte charge de la machine, le contexte WebGL du navigateur de test peut se perdre au chargement
  (l'écran « Le rendu 3D s'est interrompu » s'affiche alors — c'est le comportement voulu) : relancer.
- Le serveur d'aperçu redirige `/` vers la page du mode ; sur la vraie application `/` est le cinéma.

## V2 — la nuit du 11/11/2026 (demande du propriétaire après son premier essai)

**Consigne : un seul déploiement, à la fin** (« ne fais pas 50 déploiements »). Tout s'accumule sur la branche
`immersion` ; commit, push, build et bascule une fois, quand tout est vérifié. Prévenir l'autre session avant le build.

Son retour, sur un portable Core Ultra 7 155H (Arc intégré), Chrome, 2560 × 1229 :
- mesure : Ultra 56 i/s écrans éteints (1 % à 30), **21 avec vidéo** ; Bas 148 → 35. La chute est la même à tous
  les préréglages et **aussi quand la lecture est en pause** ; la vidéo saccade ; « gros input lag » ;
- reflets des vitres et des télévisions trop forts, pas beaux ;
- la rambarde en haut de l'escalier monte trop haut et trop près du mur (mélange de barrières) ;
- de la cuisine on voit un bloc — la chambre ; un couloir bizarre ; architecture « correcte mais perfectible » ;
- les lumières : « hyper belles » — **ne pas les abîmer** ;
- il veut : 60 i/s stables en Ultra pendant une lecture sur sa machine ; l'ambilight allégé ou coupé si besoin ;
  le mobile (joystick + deux ou trois boutons) ; plus de commandes de lecture (pistes audio, sous-titres).

Ordre de travail :
1. **Banc sur une vraie carte graphique** : ce serveur a une UHD 630 (`/dev/dri/renderD128`), plus faible que la
   cible. Faire tourner Chromium dessus (conteneur `immersion-gpu`), mesurer effet par effet. Les tests d'avant
   tournaient en rendu logiciel, qui cache ces coûts.
2. Performances (cible ci-dessus) ; 3. reflets ; 4. rambarde, bloc de la chambre, couloir, cohérence (toute
   géométrie changée = recuisson du groupe) ; 5. latence des commandes à vérifier une fois le rendu remonté ;
   6. commandes tactiles ; 7. pistes audio et sous-titres.

### État (tout est livré en 10.35.0 ; ce qui suit est le récit de la nuit)

Commités (22ff093d, e73a6bc6 ; portail vert) : copie réduite de la vidéo par la carte graphique, mire de mesure en
fichier, `maxMs`/`over33`/`over50`/`slowAt` (route + test côté application), zoom à la molette assis, commandes
de lecture dans le panneau (`NowPlaying`), scénario 09, banc `tests/perf.mjs`.

**Le banc tourne sur la vraie puce graphique du serveur** (UHD 630, `IMMERSION_GL=egl`, déjà le défaut de
`capture.sh`) : `SCRIPT=perf.mjs SIZE=2560x1229 QUALITY=ultra tests/capture.sh canape` (variantes : `VARIANTS=`,
`MODE=eteint`) ; `SCRIPT=hitch.mjs` (images longues, `BISECT=2`) ; `SCRIPT=inspect.mjs PREP='…'`. Lire la
**moyenne**, pas la médiane (sans écran, le navigateur présente à 60 Hz puis bloque d'un coup). Le scan X-Ray
utilise le même iGPU : demander à l'autre session de le mettre en pause pendant les mesures, et la prévenir à la fin.

Mesuré, à la résolution du propriétaire (2560 × 1229, Ultra, vue du canapé), sur l'UHD 630 :
- avant : 126 ms écrans éteints. **La moitié venait de deux lanternes** (glTF `KHR_materials_transmission`) : three
  redessine alors toute la scène une seconde fois par image. Retiré dans `Model.tsx` → ~60 ms.
- avec vidéo : ~80 ms, dont ~21 pour la lumière des écrans calculée dans toutes les matières. Sur sa machine
  (≈ 7 fois plus rapide, d'après ses 17,8 ms d'origine) : ~11 ms, soit ~85 i/s estimés, contre 21 mesurés.

Fait dans la nuit :
- **couche `ecrans` de la lightmap** : les dalles cuites en lumières de surface, un tiers d'image par canal
  (`tools/bake/export.ts`, `bake.py` type `area`, albédo gris pour cette couche) ; à l'affichage une lecture de
  texture (`lightmaps.ts`, `SL_BAKED`) ; le reflet du film seulement sur les matières lisses (`SL_MIRROR`) ; trois
  zones au lieu de six. Cuisson complète lancée (`logs/bake-v2.log`, ~45 min). **À faire après : régler le gain à
  l'œil contre l'ancien rendu (captures TV=1), puis banc.** Copie des lightmaps d'avant : `assets-src/bake/avant/`.
- reflets : vitres (plus de reflet direct des lampes, `envMapIntensity` 0,55), dalle éteinte moins miroir ;
- structure : escalier raccourci (palier de 1,05 m), rampe arrêtée sous le plancher, garde-corps de la trémie sur
  toute sa longueur ; nouveau groupe `dehors` (`geometry/outside.ts` : toit, neige, bardage, porte d'entrée,
  lanterne de l'aile de la chambre) ; le couloir devient l'entrée (porte, patère, banc).
- **tactile** : `input/touch.ts` (manche à gauche, regard à droite, toucher bref = valider, deux doigts = cadrer),
  `ui/TouchControls.tsx` (boutons agir / s'asseoir / lecture / menu), `capability.ts` (`isTouchDevice`, paysage
  exigé, `flatPanel` : sur petit écran le panneau est à plat, plein écran), « Auto » part du niveau 6 et la densité
  de points est plafonnée à 1,5 ; scénario 10 (téléphone émulé 844 × 390). **Jamais essayé sur un vrai iPhone** :
  mémoire des textures, ManagedMediaSource et son restent à constater sur l'appareil.
- **pistes audio et sous-titres** : `media/subtitles.ts` (WebVTT de la route du lecteur serveur, réplique du
  moment dessinée dans un canevas posé au bas des dalles, `Screens.tsx`), `switchAudio` (négociation refaite
  avec `audioStreamIndex`), deux listes dans `NowPlaying`, noms par `@/lib/trackLabel` ; scénario 11 (réponses
  de l'application écrites à la main — pas d'instance). Sous-titres en images : hors périmètre.
- **Résultat mesuré (2 h 50, iGPU libre, 2560 × 1229, Ultra, UHD 630)** : canapé 59 ms écrans éteints, 61 ms avec
  vidéo (au départ 126 et ~145) ; entrée 56 / 57 ; cuisine 57 / 55. La vidéo ne coûte plus rien de mesurable ; le
  halo (bloom) reste le premier poste des effets (~7 ms). Sur la machine du propriétaire (≈ 7 fois plus rapide
  d'après sa première mesure) : ~9 ms par image, estimés — **à confirmer par son bouton « Mesurer »**.
- Cuisson v2 faite (trois couches, six atlas, 11,9 Mo de KTX2 ; `logs/bake-v2.log`) ; le halo autour des dalles
  est adouci à l'affichage (un genou dans `lightmaps.ts`), il brûlait au blanc.
- Scénarios 02, 05, 06, 07, 08, 09, 10, 11 verts sur ce build, sous la politique de sécurité (01, 03, 04 demandent
  une instance de l'application : non rejoués).

## Retour du propriétaire sur la v2 (11/11/2026, matin) — corrigé en 10.35.1

Essai sur un iPhone 15 Pro Max : « impressionnant », fluide, 60 images par seconde en Ultra même en lecture ; le
changement de piste audio a marché sur un vrai film (deux lignes `why: "audio"` au journal). Ses remarques, et
ce qui a été fait :
- **Couleurs ternes** (films HDR, mais aussi SDR) : une vraie erreur — la passe finale de la vidéo convertissait
  une seconde fois l'image vers l'espace de l'écran (128 → 187, 40 → 110). Retirée (`Screens.tsx`) ; vérifiée
  sur des aplats connus (`tests/couleur.mjs`) et gardée par le scénario 12 (`readPng` dans `helpers.ts`).
- **Zoom assis au doigt** : le doigt posé à gauche prenait le manche et faisait se lever. Assis, plus de manche :
  tout l'écran sert au regard et au cadrage (`touch.ts`, option `seated`).
- **Trop sombre pendant un film** hors du salon : le mode cinéma baisse pièce par pièce (`CINEMA` dans
  `Lights.tsx` : salon 0,14 ; sud 0,5 ; nuit 0,6), et la cage d'escalier a deux appliques (`STAIR_SCONCES`,
  lumières et abat-jour seulement — recuisson de la seule couche `lampes` de `sud`, les autres gardées : la
  géométrie n'ayant pas changé, le dépliage est le même).
- **Bruits de fond** : vent et bain plus bas, et en retrait pendant un film (`ambience`, `audio.ts`).
- **Réglages sur téléphone** : menu et réglages en plein écran, sans logo ni cadre.
- **Point de visée** : s'efface après 2,5 s sans mouvement (`Reticle`, `Hints.tsx`).
- **« Rendu 3D interrompu » en quittant** : le contexte rendu par le démontage n'est plus pris pour une panne.
- **Barre de chargement** : ne recule plus (0 recul sur une liaison de 20 Mb/s, `tests/chargement.mjs`), dit
  « Téléchargement des décors · n / total » puis « Préparation de la scène », et un reflet y passe en continu.
- **Plantage pendant la mesure sur iPhone** : au changement de préréglage, pendant les passages avec film. Au
  doigt, la mesure ne joue plus que le préréglage en cours. Ses lignes d'avant : Ultra 45 i/s écrans éteints,
  60 avec film ; sur iPhone tous les préréglages rendent à la même définition (la densité est plafonnée à 1,5).

## Prochaine action

**Demandé par le propriétaire le 11/11/2026 (à faire, pas commencé)** — le confort de regarder :

1. **Enchaîner sans quitter le canapé.** À la fin d'un épisode, proposer « épisode suivant » (compte à rebours,
   annulable) ; pendant le générique de début et le récapitulatif, « passer ». La négociation
   (`POST /api/jellyfin/playback/start`) rend déjà `introSkip`, `recapSkip` et `creditsStart` (voir
   `playerMarkers` côté application) : le mode ne les lit pas encore (`media/api.ts`, type `Negotiation`).
   L'épisode suivant se trouve par la liste des épisodes de la série (`media/library.ts`, `episodesOf`) ; lancer
   par la commande `open` (`media/commands.ts`), jamais en touchant au `<video>`.
2. **Une télécommande légère.** Le panneau complet couvre l'image pour une simple pause. Une barre discrète au bas
   de l'écran (lecture / pause, −10 s, +30 s, barre de progression, sous-titres) : au clic ou à la molette sur
   ordinateur quand on regarde l'écran, au toucher sur mobile — sans ouvrir le panneau. Les gestes passent par les
   mêmes commandes que `NowPlaying` (`ui/Panel.tsx`) ; `ui/Hud.tsx` affiche déjà titre et progression.

À tenir : textes dans les quatre langues (`lib/i18n.ts`) ; un scénario par fonction, jouable sans instance
(`SANS_APPLICATION=1`, réponses de l'application écrites à la main comme dans `tests/e2e/11-pistes.spec.ts`) ;
`docker build --target immersion .` avant de livrer ; une seule livraison à la fin.

Ensuite, selon son retour : entrer plus vite (charger le salon d'abord), des préréglages qui se distinguent
vraiment sur téléphone (la densité y est plafonnée à 1,5 : tous rendent à la même définition), le multijoueur.

Toujours attendu de lui :
- sa mesure sur ordinateur (« Mesurer », lignes `immersion-bench` de `startup.log`, avec `maxMs`, `over33`, `over50`, `slowAt`) :
  la cible est 60 images par seconde stables en Ultra pendant une lecture ; si des à-coups restent, `slowAt` dit où ;
- les sous-titres sur un vrai film ; le plantage pendant « Mesurer » sur iPhone (contourné, cause non prouvée).
Leviers de performance encore disponibles, par ordre de rendement mesuré sur l'UHD 630 : le halo (bloom, ~7 ms
sur 60 — à demi-définition ou à moins de niveaux) ; les lumières ponctuelles temps réel (reflets seulement, ~5 ms) ;
l'environnement (~5 ms) ; le relief des matières (~7 ms).
