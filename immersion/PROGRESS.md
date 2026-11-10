# Mode « Immersion » — journal de chantier

Ce fichier suffit, avec le cahier des charges, à reprendre le chantier là où il s'est arrêté.
Il est mis à jour à la fin de chaque étape et avant toute opération longue.

## État actuel

- **Étape en cours : 1** (dossier, entrée par la recherche, service de la page, scène provisoire, déplacements).
- Branche `immersion`, dans une **copie de travail à part** (`git worktree`, dossier voisin de la copie
  principale `…-immersion`). La copie principale reste sur `main` : on n'y travaille pas.
- Rien n'est encore fusionné ni déployé.
- Prochaine action : voir « Prochaine action » en bas de fichier.

## Règles de travail (rappel)

- **Portail de l'application** avant tout commit qui touche à son code, sans tuyau, code de sortie lu ;
  depuis la copie de travail, les dépendances de la copie principale sont montées en lecture seule :
  `docker run --rm -v "$PWD":/app -v <copie principale>/node_modules:/app/node_modules:ro -w /app node:26-alpine sh -c 'set -e; npm run typecheck; npm run lint -- --max-warnings=0; npm test'`.
  Quelques tests de chronométrage peuvent échouer seuls sous charge : relancer jusqu'au vert.
- **Compte de test** : le compte Jellyfin de test de la maison (`claude-test`), jamais un autre, jamais un
  compte réel ; identifiants dans `immersion/.env` (ignoré par git). Aucune session ouverte sur la
  production : les tests de bout en bout tournent sur une instance jetable.
- **Déploiement**, aux jalons validés seulement : lectures en cours vérifiées d'abord ; version montée dans
  `package.json` et `package-lock.json` (commit à part) ; fusion dans `main` ; image construite depuis une
  copie propre de `main` (`docker build -t cine-app:latest --build-arg BUILD_REF=<sha> .`), puis
  `docker compose up -d --no-build` dans la copie principale, puis `docker builder prune -f --max-used-space 15GB` ;
  push en arrière-plan, CI lue après. Pas de page Nouveautés (c'est un secret).
- **Machine partagée** : conteneurs nommés `immersion-*`, supprimés après usage, `docker ps` vérifié en fin
  d'étape ; captures sur le processeur graphique brèves.
- **Poids** : ~40 Mo au total dans le dépôt et dans l'image, pas plus. Le poids réel est noté plus bas.

## Ce que le dépôt est vraiment (relevé avant de commencer)

Le cahier des charges parle d'un front React et d'un back FastAPI. Le dépôt est une application
**Next.js 16** (App Router, React 19, TypeScript, un seul conteneur). Conséquences :

- Il n'y a pas de « montage statique FastAPI » : la page est servie par **deux routes de service**
  ajoutées à l'application (voir « Service de la page »).
- Le navigateur ne parle jamais à Jellyfin : tout passe par les routes `/api/jellyfin/*` de
  l'application, **sur la même origine**. Il n'y a donc **aucun CORS à configurer** :
  `crossOrigin="anonymous"` sur une vidéo de même origine donne une texture lisible et un son
  exploitable par Web Audio. Rien n'a été changé chez Jellyfin.
- Il n'y a ni Node ni npm sur la machine : tout tourne dans Docker (builds, outils, tests).
- La session est un cookie `httpOnly` vérifié par `src/proxy.ts` pour toute adresse hors liste
  publique. `/immersion` et `/api/immersion/*` n'y sont pas : sans session, la page renvoie à la
  connexion et les fichiers répondent 401. Un lien de partage (rôle `share`, liste fermée) n'y a
  pas accès.

## Décisions (et pourquoi)

### Service de la page — routes de service, pas `public/`

- `GET /immersion` (`src/app/immersion/route.ts`) rend `index.html` du build.
- `GET /api/immersion/<fichier>` (`src/app/api/immersion/[...path]/route.ts`) rend les fichiers du
  build (JS, textures, modèles). Vite est configuré avec `base: "/api/immersion/"`.
- Le build (`immersion/dist`) est produit par une étape à part du `Dockerfile` et copié dans
  l'image sous `/app/immersion-dist`. Absent (développement, tests) : les deux routes répondent 404.

Pourquoi pas `public/immersion/` : le service worker de l'application (`public/sw.js`) recopie dans
son cache tout GET hors `/api/` qui n'est ni une image ni une page. Les dizaines de mégaoctets de
textures y auraient été gardés en double, pour toujours (ce cache n'est jamais purgé). Sous
`/api/`, le worker ne touche à rien — et `sw.js` n'a pas à être modifié. Pourquoi pas le relais
inverse : il est partagé avec d'autres sites et ne connaît pas la session.

La politique de sécurité (CSP) générale suffit telle quelle (`wasm-unsafe-eval`, `worker-src blob:`,
`media-src blob:`), à une condition tenue par le pipeline d'assets : **aucune ressource embarquée
dans un `.glb`** (three les relit par `fetch(blob:)`, que `connect-src` refuse). Les modèles sont
donc des `.gltf` avec `.bin` et `.ktx2` à côté.

### Entrée — une affiche dans la recherche

Chercher exactement « immersion » (espaces et casse ignorés) pose en tête des résultats une affiche de
plus, « Le Chalet » / « Laterna Experience », au format des autres (`PlayerResultCard`). La presser
part vers `/immersion` par une navigation ordinaire. Tout autre mot reste une recherche. La règle est
dans `src/lib/immersionTrigger.ts` (DECISIONS.md §144) ; l'affiche est `immersion/public/poster.jpg`,
une image du vrai chalet (capture de la scène, refaite quand la scène change).

La première idée — rediriger dès que le champ vaut `immersion*` — a été abandonnée pour celle-ci :
l'application parle par affiches, et celle-ci ne se montre qu'à qui cherche ce mot.

### Accueil — « Laterna Experience »

La page s'ouvre sur la marque de Laterna animée (le L se dresse, le faisceau s'allume, « Laterna
Experience »), qui sert d'écran de chargement : la barre suit le chargement réel de la scène, puis
devient « Cliquer pour entrer » — le geste que le navigateur exige pour verrouiller le pointeur et
laisser sortir du son.

### Lecture — le chemin du lecteur serveur, même route

Le lecteur principal a deux chemins : le remultiplexeur local (plusieurs milliers de lignes, lié à
Next) et le lecteur serveur (`POST /api/jellyfin/playback/start` → DirectPlay / DirectStream /
Transcode par Jellyfin, lu par hls.js). L'Immersion utilise **la même route** que le lecteur
serveur, avec le même corps de demande : c'est elle qui construit le DeviceProfile
(`buildDeviceProfile`) et dérive la méthode de lecture. Rien n'est réécrit côté serveur.

- **Importé en lecture seule** (alias `@/` → `../src`) : `src/lib/codecSupport.ts` (et
  `webkitEngine.ts` dont il dépend) — la détection des codecs, avec son cache `localStorage`
  partagé : l'Immersion annonce exactement ce que le lecteur principal annonce.
- **Réécrit en version minimale** dans `immersion/src/media/` : l'appel de négociation, le
  câblage hls.js, les rapports `playing` / `progress` / `stop`, la reprise
  (`/api/jellyfin/playback-state/<id>`). Les modules d'origine tirent tout le lecteur avec eux.
- « Forcer SDR » = le champ `lighter: true` de la même route (profil sans HDR, 1080p au plus).

### Physique — `@react-three/rapier`

Contrôleur de personnage cinématique de Rapier (capsule) : glissement le long des murs, marches
franchies seules (escalier de la mezzanine), collage au sol. La géométrie du chalet est écrite en
code, donc ses collisions sont des boîtes posées à côté — pas de maillage à traverser. Coût : le
module WebAssembly (~600 Ko compressé), chargé seulement sur cette page.

### Panneau Laterna — drei `<Html transform>`

Du vrai DOM posé dans le monde : texte net, champ de recherche natif, affiches en `<img>` (pas de
texture à téléverser, pas de CORS sur les images). L'occultation ne se pose pas : à l'ouverture le
pointeur est libéré et la caméra se place face au panneau.

### Rendu — vidéo hors du mappage de tons

Avec un compositeur de post-traitement, le mappage de tons s'applique à toute l'image, vidéo
comprise (`toneMapped={false}` n'agit que sur un rendu direct à l'écran). La vidéo est donc
redessinée **après** le compositeur, telle quelle, par une passe qui teste la profondeur de la
scène ; la version qui passe par le compositeur ne sert qu'au halo (bloom).

### Ombres

Rien ne bouge dans le chalet (le visiteur n'a pas de corps) : les cartes d'ombre sont calculées une
fois puis figées (`shadowMap.autoUpdate = false`).

## Plan des fichiers

Hors de `/immersion` (tout est additif, sauf la ligne du déclencheur) :

| Fichier | Nature |
|---|---|
| `src/components/player/PlayerSearchPanel.tsx` | **modifié** : l'affiche du Chalet (un import, trois endroits) |
| `src/lib/immersionTrigger.ts` | nouveau : la règle (le mot, l'adresse, l'affiche) |
| `src/lib/immersionFiles.ts` | nouveau : lecture des fichiers du build |
| `src/app/immersion/route.ts` | nouveau : la page |
| `src/app/api/immersion/[...path]/route.ts` | nouveau : ses fichiers |
| `src/__tests__/immersion-{trigger,files,proxy}.test.ts` | nouveaux : la règle, le service des fichiers, le proxy |
| `DECISIONS.md` | §144 : la règle, sa fonction, son appelant, ses tests |
| `Dockerfile` | une étape de build en plus, une copie en plus |
| `.dockerignore` | ce qui n'entre pas dans le build |
| `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts` | `immersion` exclu (projet à part), comme `streamdeck-plugin` |

Dans `/immersion` : projet Vite + React 19 + TypeScript (`src/`), assets optimisés
(`public/assets/`), pipeline d'assets (`tools/assets/`), tests et captures Playwright (`tests/`).

Dépendances de `/immersion` : `three`, `@react-three/fiber`, `@react-three/drei`,
`@react-three/postprocessing` (+ `postprocessing`), `@react-three/rapier`, `hls.js`, `zustand`,
`react`, `react-dom` ; en développement `vite`, `@vitejs/plugin-react`, `typescript`,
`@types/three`, `@playwright/test`.

## Environnements de travail

- **Build et outils** : conteneurs `node:26-alpine` nommés `immersion-*`, supprimés après usage.
- **Instance jetable** de l'application (image construite depuis un commit, dossier de données
  jetable, port local) pour les tests de bout en bout — jamais la production.
- **Captures** : Playwright 1.63 (image officielle), Chromium sans écran. Le processeur graphique
  intégré de la machine est utilisable (`--device /dev/dri`, `--use-angle=gl-egl`) ; à défaut,
  SwiftShader.
- **Compte de test** : celui de la maison (voir « Règles de travail »). En attendant ses identifiants,
  l'instance jetable reçoit une session posée directement dans **sa** base (rien côté Jellyfin) : elle
  ouvre les pages et le catalogue, pas la lecture.

## Étapes

1. [ ] Dossier `/immersion`, entrée par la recherche, service de la page, scène provisoire, déplacements et collisions
2. [ ] Salon : géométrie, matériaux, éclairage
3. [ ] TV, vidéo, son spatialisé, rapports Jellyfin
4. [ ] Interface dans le monde, HUD, menu pause, réglages
5. [ ] Extérieur, neige, ambilight, post-traitement, finitions
6. [ ] Autres pièces du chalet

## Poids

(à relever quand les assets sont produits : `public/assets/`, `dist/`, total commité)

## Problèmes ouverts

- Les identifiants du compte de test ne sont pas sur la machine : sans eux, la lecture d'un vrai film
  (étape 3) ne peut pas être vérifiée de bout en bout sur l'instance jetable.

## Prochaine action

Portail de l'application vert → commit de l'étape 1 côté application ; image de test ; instance jetable ;
scénarios Playwright `tests/e2e/01-entree` et `02-monde`.
