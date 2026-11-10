# Mode « Immersion » — journal de chantier

Ce fichier suffit, avec le cahier des charges, à reprendre le chantier là où il s'est arrêté.
Il est mis à jour à la fin de chaque étape et avant toute opération longue.

## État actuel

- **Étape en cours : 1** (dossier, déclencheur, service de la page, scène vide, déplacements).
- Branche `immersion`. Rien n'est encore fusionné ni déployé.
- Prochaine action : voir « Prochaine action » en bas de fichier.

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

### Déclencheur

`PlayerSearchPanel` : si le champ vaut exactement `immersion*` (espaces retirés, casse ignorée), la
frappe n'entre pas dans l'état de la recherche — donc aucune requête, aucune ligne d'historique —
et la page part vers `/immersion` par `window.location.assign`. La règle est dans
`src/lib/immersionTrigger.ts`.

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
| `src/components/player/PlayerSearchPanel.tsx` | **modifié** : le déclencheur (import + 4 lignes) |
| `src/lib/immersionTrigger.ts` | nouveau : la règle du déclencheur |
| `src/lib/immersionFiles.ts` | nouveau : lecture des fichiers du build |
| `src/app/immersion/route.ts` | nouveau : la page |
| `src/app/api/immersion/[...path]/route.ts` | nouveau : ses fichiers |
| `src/__tests__/immersion-*.test.ts` | nouveaux : tests des trois précédents |
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
- **Compte de test** Jellyfin `immersion-test` (sans droits d'administration), identifiants dans
  `immersion/.env` (ignoré par git).

## Étapes

1. [ ] Dossier `/immersion`, déclencheur, service de la page, scène vide, déplacements et collisions
2. [ ] Salon : géométrie, matériaux, éclairage
3. [ ] TV, vidéo, son spatialisé, rapports Jellyfin
4. [ ] Interface dans le monde, HUD, menu pause, réglages
5. [ ] Extérieur, neige, ambilight, post-traitement, finitions
6. [ ] Autres pièces du chalet

## Problèmes ouverts

(aucun pour l'instant)

## Prochaine action

Écrire le projet Vite, les deux routes de service et le déclencheur ; lancer le portail de
l'application ; construire une image de test ; premier test Playwright.
