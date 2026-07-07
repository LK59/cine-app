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

## Ratings (MDBList)

Cine App can display multi-source ratings on movie and series pages: IMDb, Rotten Tomatoes, Metacritic, Letterboxd, and Trakt — all from a single API call.

Get a free key at **mdblist.com → Settings → API Key** (free tier: 1 000 req/day).

```env
MDBLIST_API_KEY=your_key_here
```

Without this key the rating section is simply not shown. No rebuild needed if the key is added after first launch — the app reads it at runtime.

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

## Clara Galle gallery page

Cine App includes an optional enriched page for the actress Clara Galle, with a full-screen photo gallery, detailed biography and external links.

This feature is **disabled by default** and requires a local photo folder on your host.

### Enable it

**1. Prepare the photos folder**

Create a folder anywhere on your host and add your photos (JPG, PNG or WebP).  
Also place a file named exactly `clarabanner.jpg` in the same folder — it is used as the full-width banner at the top of the page.

Do not commit this folder or its contents to git.

**2. Mount the folder in your compose file**

In your `docker-compose.yml`, add the volume:

```yaml
volumes:
  - /path/to/your/clara/photos:/app/gallery/clara:ro
```

See `docker-compose.example.yml` for the full example.

**3. Set the env var**

In your `.env`:

```env
CLARA_GALLERY_ENABLED=true
```

**4. Rebuild**

```bash
docker compose up -d --build
```

### Disable it

Set `CLARA_GALLERY_ENABLED=false` (or remove the variable) and rebuild. The volume mount can be left in place or removed — the feature is fully controlled by the env var.

---

## Notes

qBittorrent can be reached through a Gluetun container when it shares the same network namespace:

```env
QBITTORRENT_URL=http://gluetun:8080
```

Adjust this value depending on your own stack.
