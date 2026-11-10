# Mode « Immersion » — journal de chantier

Ce fichier suffit, avec le cahier des charges d'origine, à reprendre le chantier là où il s'est
arrêté. Il est mis à jour à la fin de chaque étape et avant toute opération longue. **Le relire en
entier après toute reprise.**

## État actuel (à jour)

- Branche `immersion`, dans une **copie de travail à part** (`git worktree`, dossier voisin de la
  copie principale, suffixe `-immersion`). La copie principale reste sur `main` : on n'y travaille pas.
- Rien n'est encore fusionné ni déployé. Version visée pour la première livraison : **10.34.0**
  (rebaser sur `main` avant de fusionner ; prévenir l'autre session de travail avant tout build de prod).
- **Fait et commité** : entrée par la recherche, routes de service, projet Vite, salon (géométrie,
  matières, lumière temps réel), télévision (vidéo, passe hors mappage de tons, ambilight, son
  spatialisé), lecture par la route du lecteur serveur (stéréo, HDR → SDR, arrêt, journal), panneau
  Laterna dans le monde, HUD, menu pause, réglages, préréglages + Auto.
- **En cours / à faire** : voir « Plan de travail » plus bas.

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

## Poids

- `public/assets/` : **28,3 Mo** (textures 15,1 ; modèles 9,6 ; HDRI 3,2). `dist/` : ~37 Mo (assets, code
  ~4 Mo, jumeaux `.br` ~4,5 Mo).
- Marge restante avant 40 Mo commités : ~10 Mo pour le panorama, les lightmaps, le canapé, les pièces.
  Leviers si besoin : retirer les jeux de textures inutilisés (`metal_black`, `bark`), les deux HDRI si la
  vue n'en dépend plus, les modèles non posés.

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

**État au 10/11, 23 h** — tourne sans surveillance : la cuisson finale en deux couches (`logs/bake.log`, 40 à
50 min, lancée vers 22 h 55) puis `tools/apres-cuisson.sh` (`logs/suite.log` : build, captures de tous les lieux,
affiche, portail jusqu'au vert). Le panorama v2 (nuit noire, forêts, village qui éclaire la vallée) est encore en
rendu chez son agent : à l'arrivée, rebuild et captures `vue`, `baie`, `terrasse`, `dehors`.
Ajouté depuis : terrasse en surplomb (falaise au nord), nuit noire, canapé v2 + plaid, clavier (AZERTY / QWERTY /
QWERTZ, réglage), chaîne hi-fi. Scénarios 06, 07, 08 verts ; 01 à 05 à rejouer sur le build final.

**Reste avant livraison** : lire `logs/suite.log` ; regarder `captures/` lieu par lieu ; commiter
`public/assets/lightmaps/` et l'affiche ; intégrer le panorama v2 ; scénarios 01–08 ; poids (≈ 44 Mo attendus pour
40 visés) ; portail vert sur cet arbre ; fusion (avance rapide), image candidate, bascule, vérification, push, CI,
ménage (`cine-regress-c992edf9`, `immersion-preview`).

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

## Prochaine action

**Pause du 10/11 vers 19 h 20 (limite de session).** À la reprise : lire ce fichier, puis `immersion/logs/suite.log`.

### Ce qui tourne sans surveillance

1. La **cuisson finale des lightmaps** (`tools/bake/bake.sh --samples 192 --exposure -1.5`, conteneurs
   `immersion-bake-*`), lancée à 18 h 50, ~21 min. Elle écrit `public/assets/lightmaps/` (pas encore commité :
   le dossier est en cours de réécriture). Son journal est recopié dans `logs/bake.log` à la fin.
2. La **chaîne `tools/apres-cuisson.sh`** (journal `logs/suite.log`, une ligne par étape) : attend la fin de la
   cuisson, puis build (`logs/build.log`), captures de chaque pièce en Ultra (`captures/*.jpg`,
   `logs/captures.log`), affiche recadrée (`public/poster.jpg`, `logs/affiche.log` ; la première version est
   gardée dans `logs/poster-v1.jpg`), puis le portail de l'application jusqu'au vert, cinq essais au plus
   (`logs/gate-N.log`, dernière ligne `exit=…`).
   Si rien de cela n'a tourné (processus coupés) : relancer `sh tools/apres-cuisson.sh` depuis `immersion/`
   après `tools/bake/bake.sh --samples 192 --exposure -1.5`.

### Reprise de 19 h 18 — la chaîne est allée au bout

- `logs/suite.log` : cuisson `exit=0`, build, 17 captures, affiche, et **portail VERT au premier essai**
  (`logs/gate-1.log`, 845 fichiers, `exit=0`) sur le commit `ecffedc8` de la branche (application + lightmaps
  comprises) : l'avertissement « sans portail vert » ci-dessous est levé pour cet arbre. Il reste à le refaire
  sur l'arbre **rebasé** avant la fusion.
- Affiche : la version recadrée (écran allumé visible) est retenue et commitée dans `public/poster.jpg`.
- Vu sur `captures/` : salon, entrée et affiche bons avec la lumière cuite. **Défaut à corriger : le canapé
  montre des traits sombres en pointillé le long des coutures** (`captures/canape.jpg`) — texels de la lightmap
  `sofa` cuits noirs dans le creux du passepoil. Piste : dilater les clairs de `assets-src/bake/work/sofa.png`
  (filtre « maximum » 5×5) avant l'encodage KTX2, dans `tools/bake/` pour que ce soit reproductible ; à défaut,
  ne pas poser de lightmap sur le canapé (`Sofa.tsx`).
- Pas encore regardées : `cuisine`, `ilot`, `escalier`, `mezzanine`, `balcon`, `couloir`, `chambre`, `lit`,
  `vallee`, `ouest`, `reglages`.

### Reprise (10/11 au soir) — demandes du propriétaire, puis livraison

Demandé : une télévision dans la chambre, le son de **toutes** les télévisions avec une portée maximale et des
zones où l'on en entend deux, l'écran du salon plus grand ; puis finir le plan, commiter, pousser, déployer.

- [x] Écran du salon 4,6 → 5,2 m (`TV`, `layout.ts`), relevé au-dessus des bougies du manteau ; fermes extérieures
      écartées (`TRUSSES`) pour dégager les coins de l'image. Écran de la chambre 1,25 → 1,9 m, meuble bas élargi.
- [x] Portée par haut-parleur (`Screen.range`, `rangeGain`, `applyAcoustics`) : salon 14 m, cuisine 8, chambre 7,
      fondu sur le dernier quart. Recouvrements voulus : cuisine + salon, mezzanine + cuisine, est du couloir :
      cuisine + chambre. Scénario `06-son` vert.
- [x] Rebase sur `main` fait, version 10.34.0 commitée.
- [ ] Recuisson des lightmaps (géométrie du salon et de la chambre changée) : `logs/bake.log`, puis
      `sh tools/apres-cuisson.sh` (build, captures, affiche, portail) — **le portail doit être vert sur cet arbre**
- [ ] Scénarios 01–06, regard sur les captures, commit des lightmaps et de l'affiche
- [ ] Fusion dans `main` (avance rapide), build depuis une copie propre, déploiement, vérification, push, CI, ménage

### Arrêt de 19 h 30 (limite de session atteinte)

- **Rebase sur `main` FAIT en local, PAS poussé** : `origin/immersion` porte encore l'historique d'avant (même
  contenu, étiquette locale `immersion-avant-rebase`). Le pousser demande un `--force-with-lease` sur la branche
  `immersion`, refusé en mode automatique : à faire avec l'accord du propriétaire, ou ne pas pousser la branche
  et fusionner directement dans `main`.
- Le portail vert de 19 h 17 portait sur l'arbre d'AVANT le rebase : **le refaire sur cet arbre avant toute fusion**.
- Depuis ce portail, deux commits `/immersion` seulement (coutures du canapé, couche intermédiaire du panorama
  effacée derrière le chalet — cette dernière retouche n'a été vue sur aucune capture).
- Reste, dans l'ordre : build + captures (`sh tools/apres-cuisson.sh` refait build, captures, affiche et portail ;
  attention, il réécrit `public/poster.jpg`) ; regarder `cuisine`, `escalier`, `mezzanine`, `couloir`, `lit`,
  `vallee`, `ouest`, `reglages` ; scénarios Playwright 01–05 ; puis points 5 et 6 ci-dessous.


- Poussé : la branche `immersion` sur `origin` (rien sur `main`, rien de déployé).
- Les cinq scénarios Playwright sont verts (01 sur l'instance jetable ; 02 à 05 sur l'aperçu du build).
- **Le côté application (`immersion-bench`, DECISIONS §144, CLAUDE.md) est commité sur la branche SANS portail
  vert**, à la demande du propriétaire pour la pause : cinq passages rouges d'affilée sur le seul
  `cinemaRoute.test.tsx` (bloc « une navigation pendant le retour d'une fermeture » : un `popstate` attendu après
  un vrai `history.back()` de jsdom, 3 ms seul, bloqué 5 s dans la suite complète ; il passe seul, 47/47 ; sans
  rapport avec ces fichiers). **Aucune fusion tant qu'un portail entier n'est pas vert sur l'arbre rebasé.**
- Le rebase sur `main` a été tenté puis annulé : il bute sur `immersion/tools/sofa/previews/` (cinq images
  suivies par un ancien commit, ignorées depuis). Pour le refaire : écarter ce dossier
  (`mv immersion/tools/sofa/previews /tmp/…`), `git rebase main`, le remettre. **Jamais pendant qu'une cuisson
  ou une capture tourne** : le rebase retire les fichiers suivis le temps de rejouer les commits.

### Les six points demandés (cocher au fur et à mesure)

1. [~] Portail vert puis commit côté application — commité (voir ci-dessus), portail encore à obtenir : lire
       `logs/gate-N.log`
2. [~] Cuisson finale lancée ; reste : regarder `captures/` pièce par pièce (ombres des objets posés, pas de
       fuite de lumière, canapé), puis commiter `public/assets/lightmaps/`
3. [~] Scénarios 01–05 verts ; reste : revoir sur captures les retouches du dehors (`vallee`, `ouest`, `baie`,
       fenêtre de la cuisine dans `cuisine`)
4. [~] Affiche : première version faite (`logs/poster-v1.jpg`), recadrage en cours par la chaîne — choisir la
       meilleure des deux, la commiter dans `public/poster.jpg`
5. [ ] Livraison : rebase sur `main` (voir plus haut), portail vert, version 10.34.0 (commit à part,
       `package.json` + `package-lock.json` ligne 3), fusion, prévenir l'autre session, aucune lecture Jellyfin en
       cours, build depuis une copie propre de `main` (`docker build -t cine-app:latest --build-arg
       BUILD_REF=<sha> .`), `docker compose up -d --no-build` dans la copie principale, `docker builder prune -f
       --max-used-space 15GB`, vérification, push en fond, CI lue après coup
6. [ ] Ménage (instance jetable `cine-regress-c992edf9` par `regress.sh clean`, conteneur `immersion-preview`,
       `docker ps`), ce fichier à jour, récapitulatif final
