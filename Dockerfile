# Les manifestes sans leur numéro de version (08/10/2026). La version change à chaque déploiement
# (« version 8.x.y », un commit à part) : copiés tels quels, ils invalidaient l'étape des
# dépendances à chaque build — `npm install` refait de zéro, 742 Mo de cache par build plus autant
# pour leur copie dans l'étape suivante, 138 Go de cache de build en deux semaines. Ici la version
# est remise à 0.0.0 : deux manifestes qui ne diffèrent que par elle donnent les mêmes octets, et
# BuildKit réutilise l'installation. La vraie version reste dans le `package.json` copié avec le
# reste du code (`COPY . .`), où l'application la lit.
FROM node:26-alpine AS manifest
WORKDIR /m
COPY package.json package-lock.json* ./
RUN node -e 'const fs=require("fs");for(const f of ["package.json","package-lock.json"]){if(!fs.existsSync(f))continue;const j=JSON.parse(fs.readFileSync(f,"utf8"));j.version="0.0.0";if(j.packages&&j.packages[""])j.packages[""].version="0.0.0";fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")}'

FROM node:26-alpine AS deps
WORKDIR /app
# Build tools required for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++
COPY --from=manifest /m/ ./
# Cache mount rather than a layer: npm's download cache is reused across builds and updated in
# place, so a dependency change re-downloads only what actually changed.
RUN --mount=type=cache,target=/root/.npm npm install

# Le mode « Immersion » : un monde 3D caché, servi à part (`src/lib/immersionFiles.ts`,
# `immersion/PROGRESS.md`). Son propre projet, ses propres dépendances, son propre build — rien n'en
# entre dans celui de l'application, et cette étape n'est refaite que si `immersion/` change. Les
# fichiers de `src/lib` sont ceux qu'il importe en lecture seule : la détection des codecs et le plafond de
# débit (pour demander à Jellyfin exactement ce que le lecteur demande), et le nom des pistes (pour les
# nommer comme le lecteur). Un import de plus dans `immersion/src` (`@/lib/…`) s'ajoute ici — sans quoi
# cette étape échoue, alors que le build lancé depuis le dépôt entier passe (11/11/2026).
FROM node:26-alpine AS immersion
WORKDIR /build/immersion
COPY immersion/package.json immersion/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY immersion/ ./
COPY src/lib/codecSupport.ts src/lib/webkitEngine.ts src/lib/networkBitrate.ts src/lib/trackLabel.ts src/lib/trackPreferences.ts src/lib/playerSkip.ts /build/src/lib/
# Le contrat des salons du chalet (§146) : les messages et le moteur de « Devine le film », écrits une fois,
# côté service.
COPY salons/src/protocol.ts salons/src/quiz.ts salons/src/tv.ts /build/salons/src/
RUN npm run build

# Le ffmpeg minimal de Lumen serveur (conversion du son, DECISIONS.md §161, docs/remux-serveur/5-conversion-son.md) :
# FFmpeg 7.1.5 épinglé (archive vérifiée par SHA-256), lié statiquement, LGPL — `tools/ffmpeg-lumen/build.sh` et
# son README disent tout. Une étape à part, sur la même Alpine que `node:26-alpine` : gardée en cache tant que le
# script ne change pas (~2 min sans cache, en CI). Toujours dans l'image (4 Mo), jamais appelé tant que l'option
# « conversion du son » est coupée (défaut) ; sa présence et sa version sont détectées au démarrage.
FROM alpine:3.24 AS ffmpeg-lumen
COPY tools/ffmpeg-lumen/build.sh /build.sh
RUN JOBS=4 sh /build.sh

# Le ffmpeg vidéo minimal de la version allégée de Lumen serveur (DECISIONS.md §195) : la même FFmpeg 7.1.5 épinglée,
# avec seulement VAAPI (décodage HEVC/H.264, `scale_vaapi`, encodeur `hevc_vaapi`), le Matroska en entrée et un flux
# HEVC brut en sortie — `tools/ffmpeg-video/build.sh` et son README disent tout. Lié dynamiquement à libva (pas de
# libva statique sur Alpine). ~5 Mo, à la place du paquet Alpine `ffmpeg` et de ses ~180 Mo de bibliothèques.
FROM alpine:3.24 AS ffmpeg-video
COPY tools/ffmpeg-video/build.sh /build.sh
RUN JOBS=4 sh /build.sh

FROM node:26-alpine AS builder
# Le repère du build, repris tel quel dans les réglages. `.git` n'entre pas dans le contexte de
# build (voir .dockerignore), donc le hash ne peut venir que d'ici :
#   BUILD_REF=$(tools/build-ref.sh) docker compose build
ARG BUILD_REF=""
ENV BUILD_REF=$BUILD_REF
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Le dossier du mode « Immersion » n'a rien à faire dans le build de l'application : son étape à elle
# l'a déjà lu. Laissé là, la sortie « standalone » de Next — qui emporte tout le dossier du projet —
# recopiait ses 28 Mo de textures dans l'image, à côté de leur build (relevé sur une image de test).
RUN rm -rf immersion
# Les tests, sauf quand ce même commit vient de les passer (13/11/2026) : la CI construit l'image après son job
# `verify` sur le même commit, et un déploiement local après le portail — la suite tournait deux fois par
# livraison (~2 min chacune). `SKIP_TESTS=1` ne se passe que dans ces deux cas ; sans lui, un
# `docker compose build` à la main reste gardé comme avant.
ARG SKIP_TESTS=""
RUN if [ "$SKIP_TESTS" = "1" ]; then echo "tests déjà passés sur ce commit (SKIP_TESTS=1)"; else npm test; fi
# No cache mount on .next/cache any more (26/09/2026). Turbopack keeps its compilation cache
# there, and a build fed the previous one shipped fresh JavaScript with a stale stylesheet: every
# rule added to globals.css since the last build was missing from the image, while the gate and
# `next build` both passed. The cache saved four seconds (2.9 s against 6.6 s compiled cold).
# The image cache the server writes at runtime lives in a volume (docker-compose.yml), not here.
RUN npm run build
# Le fil de calcul de Lumen serveur (DECISIONS.md §155, §156) : Next n'émet pas d'entrée pour un
# `worker_threads` côté serveur, et le code du moteur (TypeScript, alias `@/…`) ne se charge pas tel
# quel dans Node. rolldown (installé avec vitest) l'empaquette en un module ESM autonome, posé dans
# `server-boot/` — copié plus bas avec le point d'entrée ; `lumenWorkerScript()` le cherche là. Sans
# lui, le même calcul se ferait sur la boucle d'événements, celle qui sert tout le reste.
RUN node tools/lumen-worker/build.mjs server-boot/lumen-worker.mjs

FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 cineapp && adduser -u 1001 -G cineapp -s /bin/sh -D cineapp
# Runtime: libstdc++ for better-sqlite3, sharp for image optimization
# `tzdata` pour que le TZ déclaré dans docker-compose.yml veuille dire quelque chose.
#
# `TZ=Europe/Paris` était bien posé dans l'environnement, et bien ignoré : sans base de fuseaux
# l'image Alpine ne sait pas à quoi ce nom correspond, et retombe sur UTC sans le dire. Le
# conteneur annonçait donc 10:09 quand la machine affichait 12:09.
#
# L'application elle-même n'en souffrait pas — toutes les heures sont mises en forme dans le
# navigateur, avec le fuseau du spectateur, et le journal du lecteur écrit de l'ISO en UTC
# explicitement marqué `Z`. Ce qui en souffrait, c'est tout ce qu'un *opérateur* lit : `date`, les
# horodatages ajoutés par Docker, décalés de deux heures au moment précis où l'on compare un
# journal à l'heure où quelqu'un a appuyé sur un bouton.
#
# À ne pas confondre avec le nom des sauvegardes, qui vient de `toISOString()` : celui-là est en
# UTC quoi qu'il arrive, `tzdata` n'y peut rien, et il a fallu le corriger dans le code — voir
# `dbBackup.ts`.
# sharp épinglé, à la version que demande `next` : non épinglé, un build à froid prenait la dernière
# publiée et un build en cache gardait l'ancienne — deux images différentes pour le même commit, et
# une mise à jour de sécurité de libvips/libheif qui ne passait pas (26/09/2026). À faire suivre
# `npm ls sharp` quand `next` change. 0.35.5 depuis next 16.4.1 (14/10/2026) : faille de librsvg
# (GHSA-wq5f-xc86-pv6w) corrigée dans les libvips qu'il embarque.
RUN --mount=type=cache,target=/root/.npm apk add --no-cache libstdc++ tzdata && npm install --no-save sharp@0.35.5
# Ce que le ffmpeg vidéo de la version allégée (étape `ffmpeg-video`) charge à l'exécution : libva (libva-drm, libdrm)
# et le pilote VAAPI des iGPU Intel récents (`intel-media-driver`, iHD) — indispensable. Sans `/dev/dri` donné au
# conteneur (et le groupe `render` en `group_add`), la détection le voit indisponible et rien d'autre ne change.
RUN apk add --no-cache libva libdrm intel-media-driver

COPY --from=builder --chown=cineapp:cineapp /app/public ./public
COPY --from=builder --chown=cineapp:cineapp /app/.next/standalone ./
COPY --from=builder --chown=cineapp:cineapp /app/.next/static ./.next/static
# Le point d'entrée : il remet les fichiers statiques des builds précédents avant de lancer le
# serveur (voir server-boot/staticCarryover.mjs). Avec lui, le fil de calcul de Lumen serveur empaqueté
# à l'étape précédente (`server-boot/lumen-worker.mjs`).
COPY --from=builder --chown=cineapp:cineapp /app/server-boot ./server-boot
# Le build du mode « Immersion », servi par deux routes (voir l'étape `immersion`).
COPY --from=immersion --chown=cineapp:cineapp /build/immersion/dist ./immersion-dist
# ffmpeg pour la conversion du son de Lumen serveur (étape `ffmpeg-lumen`) et son offre de source (LGPL).
# `LUMEN_FFMPEG_PATH` le cherche ici par défaut ; vide, la conversion est vue comme indisponible.
COPY --from=ffmpeg-lumen /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-lumen /opt/ffmpeg/share/ffmpeg-lumen /usr/local/share/ffmpeg-lumen
# Le ffmpeg vidéo de la version allégée (étape `ffmpeg-video`) et son offre de source (LGPL), à un chemin à lui :
# `LUMEN_VIDEO_FFMPEG_PATH` le cherche ici par défaut. Il ne remplace pas celui du son, chacun appelé par son chemin.
COPY --from=ffmpeg-video /opt/ffmpeg-video/bin/ffmpeg /usr/local/bin/ffmpeg-video
COPY --from=ffmpeg-video /opt/ffmpeg-video/share/ffmpeg-video /usr/local/share/ffmpeg-video
# Copy compiled better-sqlite3 native module (compiled for Alpine in deps stage)
COPY --from=deps --chown=cineapp:cineapp /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=deps --chown=cineapp:cineapp /app/node_modules/web-push ./node_modules/web-push

# Le dossier de données existe dans l'image, au compte de l'application : un volume nommé neuf
# en hérite le propriétaire, si bien que le docker-compose minimal démarre du premier coup, sans
# rien préparer sur l'hôte (DECISIONS.md §48). Un dossier monté depuis l'hôte garde les siens.
RUN mkdir -p /app/data /app/.next/cache && chown cineapp:cineapp /app/data /app/.next/cache

USER cineapp
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server-boot/boot.mjs"]
