FROM node:24-alpine AS deps
WORKDIR /app
# Build tools required for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
# Cache mount rather than a layer: npm's download cache is reused across builds and updated in
# place, so a dependency change re-downloads only what actually changed.
RUN --mount=type=cache,target=/root/.npm npm install

FROM node:24-alpine AS builder
# Le repère du build, repris tel quel dans les réglages. `.git` n'entre pas dans le contexte de
# build (voir .dockerignore), donc le hash ne peut venir que d'ici :
#   BUILD_REF=$(git rev-parse --short HEAD) docker compose build
ARG BUILD_REF=""
ENV BUILD_REF=$BUILD_REF
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm test
# No cache mount on .next/cache any more (26/09/2026). Turbopack keeps its compilation cache
# there, and a build fed the previous one shipped fresh JavaScript with a stale stylesheet: every
# rule added to globals.css since the last build was missing from the image, while the gate and
# `next build` both passed. The cache saved four seconds (2.9 s against 6.6 s compiled cold).
# The image cache the server writes at runtime lives in a volume (docker-compose.yml), not here.
RUN npm run build

FROM node:24-alpine AS runner
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
# `npm ls sharp` quand `next` change.
RUN --mount=type=cache,target=/root/.npm apk add --no-cache libstdc++ tzdata && npm install --no-save sharp@0.35.4

COPY --from=builder --chown=cineapp:cineapp /app/public ./public
COPY --from=builder --chown=cineapp:cineapp /app/.next/standalone ./
COPY --from=builder --chown=cineapp:cineapp /app/.next/static ./.next/static
# Le point d'entrée : il remet les fichiers statiques des builds précédents avant de lancer le
# serveur (voir server-boot/staticCarryover.mjs).
COPY --from=builder --chown=cineapp:cineapp /app/server-boot ./server-boot
# Copy compiled better-sqlite3 native module (compiled for Alpine in deps stage)
COPY --from=deps --chown=cineapp:cineapp /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=deps --chown=cineapp:cineapp /app/node_modules/web-push ./node_modules/web-push

USER cineapp
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server-boot/boot.mjs"]
