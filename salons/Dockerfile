# laterna-salons — le temps réel du mode Immersion à plusieurs (README.md, docs/DEPLOIEMENT.md).
#
# Node 26 exécute le TypeScript tel quel (types retirés au chargement) : rien n'est compilé. Les tests
# tournent dans la construction : une image ne sort pas d'un code rouge.
FROM node:26-alpine AS test
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run typecheck && npm test

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8090
# À l'utilisateur `node` : copiés tels quels, les fichiers gardent les droits de la machine qui construit.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=test --chown=node:node /app/src ./src
# Les tests n'entrent pas dans l'image.
RUN find src -name '*.test.ts' -delete
USER node
EXPOSE 8090
# La santé sans la clé répond 401 : c'est assez pour dire que le service écoute.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -S -O /dev/null http://127.0.0.1:8090/health 2>&1 | grep -q "HTTP/1.1 401" || exit 1
CMD ["node", "src/main.ts"]
