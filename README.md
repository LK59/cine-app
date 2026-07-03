# Cine App

Self-hosted PWA dashboard for managing a cinema/media stack from one mobile-friendly interface.

Cine App brings together Radarr, Sonarr, Bazarr, Jackett, qBittorrent, Jellyfin and Jellyseerr into a single dashboard designed for daily use.

## Features

- Unified dashboard for media services
- Radarr and Sonarr library views
- Jellyfin resume watching and playback shortcuts
- Jellyseerr request management
- qBittorrent monitoring and actions
- Calendar and timeline views
- Watchlist and recommendations
- Service health page
- Installable PWA
- Web Push notifications, including iOS PWA support
- Mobile-first navigation

## Requirements

- Docker / Docker Compose
- Existing media stack services
- API keys for Radarr, Sonarr, Bazarr, Jackett, Jellyfin and Jellyseerr
- A shared Docker network with your media services

## Deployment

```bash
cp .env.example .env
```

Edit `.env` and configure:

- app admin credentials
- service URLs
- API keys
- qBittorrent credentials
- optional TMDb / OMDb keys
- optional VAPID keys for push notifications

Then start the app:

```bash
docker compose up -d --build
```

The app listens on port `3000` inside Docker. Use a reverse proxy such as Nginx Proxy Manager, Traefik or Caddy, or expose the port directly for testing.

## Push Notifications

Cine App supports Web Push notifications for installed PWAs, including iOS Safari / Apple Web Push.

Generate VAPID keys with:

```bash
npx web-push generate-vapid-keys
```

Then set:

```env
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com
```

## Security

Never commit:

```text
.env
data/
*.db
*.db-wal
*.db-shm
```

All service API keys are kept server-side and are not exposed to the browser.

## Notes

qBittorrent can be reached through a Gluetun container when it shares the same network namespace:

```env
QBITTORRENT_URL=http://gluetun:8080
```

Adjust this value depending on your own stack.
