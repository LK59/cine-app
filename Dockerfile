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
# Next's compiler cache lives in .next/cache and is what makes a rebuild incremental. As a cache
# mount it survives between builds and is updated in place, instead of every build recompiling
# the whole app and writing a fresh layer for the result.
RUN --mount=type=cache,target=/app/.next/cache npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 cineapp && adduser -u 1001 -G cineapp -s /bin/sh -D cineapp
# Runtime: libstdc++ for better-sqlite3, sharp for image optimization
RUN --mount=type=cache,target=/root/.npm apk add --no-cache libstdc++ && npm install --no-save sharp

COPY --from=builder --chown=cineapp:cineapp /app/public ./public
COPY --from=builder --chown=cineapp:cineapp /app/.next/standalone ./
COPY --from=builder --chown=cineapp:cineapp /app/.next/static ./.next/static
# Copy compiled better-sqlite3 native module (compiled for Alpine in deps stage)
COPY --from=deps --chown=cineapp:cineapp /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=deps --chown=cineapp:cineapp /app/node_modules/web-push ./node_modules/web-push

USER cineapp
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
