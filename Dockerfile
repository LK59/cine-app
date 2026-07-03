FROM node:20-alpine AS deps
WORKDIR /app
# Build tools required for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 cineapp && adduser -u 1001 -G cineapp -s /bin/sh -D cineapp
# Runtime: libstdc++ for better-sqlite3, sharp for image optimization
RUN apk add --no-cache libstdc++ && npm install --no-save sharp

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
