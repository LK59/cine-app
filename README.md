# Cine App

Dashboard unifié pour piloter Radarr, Sonarr, Bazarr, Jackett, qBittorrent, Jellyfin et Jellyseerr depuis une seule interface.

## Prérequis

- Le conteneur doit rejoindre le même réseau Docker externe que vos services (`media_net` dans cette config).
- Les clés API de chaque service (visibles dans Settings > General de chaque `*arr`, Settings de Jellyfin/Jellyseerr, ou la conf de Jackett).

## Déploiement

```bash
cp .env.example .env
# éditer .env : renseigner APP_ADMIN_USER / APP_ADMIN_PASSWORD / SESSION_SECRET
# et les API keys + URLs internes de chaque service

docker compose up -d --build
```

L'app écoute sur le port `3000` à l'intérieur du réseau Docker. Exposez-la via votre reverse proxy (ex. Nginx Proxy Manager déjà présent sur `media_net`) en pointant vers `cine-app:3000`, ou décommentez la section `ports` du `docker-compose.yml` pour un test direct.

## Notes

- qBittorrent est joint via `gluetun` (le client partage son network namespace), d'où `QBITTORRENT_URL=http://gluetun:8080`.
- Toutes les clés API restent côté serveur (routes API Next.js) et ne sont jamais envoyées au navigateur.
- L'authentification de l'app est un compte unique défini par variables d'environnement, à protéger en plus par votre reverse proxy si besoin.
