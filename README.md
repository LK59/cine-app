# Cine App

Self-hosted PWA dashboard for managing a cinema/media stack from one mobile-friendly interface.

Cine App brings together Radarr, Sonarr, Bazarr, Jackett, qBittorrent, Jellyfin and Jellyseerr into a single dashboard designed for daily use — on desktop and mobile.

---

## Features

### Library & Media Management

- **Radarr and Sonarr library views** — grid and list modes, filtering, quick search, keyboard navigation
- **Movie and series detail pages** — poster, metadata, cast carousel, active downloads, file info, IMDb/RT/Metacritic ratings
- **Watchlist** — add any title from TMDB, classify with 5 statuses (À voir, Favoris, Vus, À demander, Abandonnés), personal notes, search and sort, IMDb rating badge on every card
- **Discover** — trending movies and series with genre filters, TMDB search, "Pour vous" tab based on Jellyfin play history
- **Recommendations** — personalised rows based on recently watched Jellyfin history
- **Release search modal** — browse and grab releases directly from Radarr/Sonarr inside the app
- **Interactive search** — admin-only Telescope button on Watchlist, Discover and Recommendations cards to add a title and open the release search in one step
- **Remove from Radarr/Sonarr** — discrete button on detail pages with in-app confirmation modal (no browser `confirm()`)

### Unified Visual Identity

All media grids (Watchlist, Discover, Recommendations) share the same card design:

- Poster-only card with `aspect-[2/3]`
- **Desktop** — hover overlay with 5 status buttons, Voir la fiche / Demander, and admin Recherche interactive
- **Mobile** — tap → ActionSheet that slides up with real-time swipe-to-close gesture
- **IMDb rating badge** — always visible bottom-left, fetched via OMDB API (never hover-only)
- **"Dispo" badge** (green) — file actually downloaded
- **"Attente" badge** (amber) — monitored in Radarr/Sonarr but not yet available
- **Delete confirmation** — native in-app modal before removing from watchlist

### Jellyfin Integration

- Resume watching section with per-user progress
- Recently added and recently played
- Mark watched / unwatched from any detail page
- Per-user recommendations based on play history

### Requests & Downloads

- **Jellyseerr request management** — send, track and display requests with status badges
- **qBittorrent monitoring** — live torrent list with section separators (En cours / Seed / Pausés), progress bars, speed indicators, start/stop/remove actions

### Calendar & Timeline

- Media release calendar (upcoming Radarr/Sonarr entries)
- Activity timeline

### Ratings

- **MDBList** — IMDb, Rotten Tomatoes, Metacritic, Letterboxd, Trakt on detail pages
- **OMDB** — IMDb rating fetched per-item on Watchlist cards (cached 24 h server-side)
- TMDB vote average shown on Discover and Recommendations cards

### Stats

- Top actors and directors ranked by number of titles in the library
- Accurate counts: only titles with a downloaded file are considered; cast cap of 50 per title

### Other

- Service health dashboard
- Calendar of upcoming releases
- Bazarr subtitle management per episode
- NFO viewer
- Actor / person modal with filmography
- Collection modal (saga grouping)
- Trailer modal
- Installable PWA
- Web Push notifications including iOS Safari / Apple Web Push
- Mobile-first navigation with haptic feedback
- Guest mode (read-only, watchlist allowed)
- Admin mode (full access including interactive search and deletion)

---

## Requirements

- Docker / Docker Compose
- Existing media stack services (see https://github.com/LK59/cinema)
- API keys for Radarr, Sonarr, Bazarr, Jackett, Jellyfin and Jellyseerr
- A shared Docker network with your media services

---

## Deployment

```bash
cp .env.example .env
```

Edit `.env` and configure:

| Variable | Description |
|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | App admin credentials |
| `RADARR_URL` / `RADARR_API_KEY` | Radarr connection |
| `SONARR_URL` / `SONARR_API_KEY` | Sonarr connection |
| `JELLYFIN_URL` / `JELLYFIN_API_KEY` | Jellyfin connection |
| `JELLYSEERR_URL` / `JELLYSEERR_API_KEY` | Jellyseerr connection |
| `QBITTORRENT_URL` / `QBITTORRENT_*` | qBittorrent credentials |
| `TMDB_API_KEY` | Required for Discover, Recommendations and Ratings |
| `OMDB_API_KEY` | Optional — IMDb ratings on Watchlist cards |
| `MDBLIST_API_KEY` | Optional — multi-source ratings on detail pages |
| `VAPID_*` | Optional — Web Push notifications |

Then start the app:

```bash
docker compose up -d --build
```

The app listens on port `3000` inside Docker. Use a reverse proxy (Nginx Proxy Manager, Traefik, Caddy) or expose the port directly for testing.

---

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

---

## Ratings

### MDBList (detail pages)

Multi-source ratings on movie and series pages: IMDb, Rotten Tomatoes, Metacritic, Letterboxd, Trakt — all from a single API call.

Get a free key at **mdblist.com → Settings → API Key** (free tier: 1 000 req/day).

```env
MDBLIST_API_KEY=your_key_here
```

### OMDB (Watchlist cards)

IMDb ratings displayed as a badge on each Watchlist card, fetched via the OMDB API and cached 24 h server-side.

Get a free key at **omdbapi.com** (free tier: 1 000 req/day).

```env
OMDB_API_KEY=your_key_here
```

Without these keys the rating sections are simply not shown. No rebuild needed if keys are added after first launch — the app reads them at runtime.

---

## Security

Never commit:

```text
.env
data/
*.db
*.db-wal
*.db-shm
```

All service API keys are kept server-side and are never exposed to the browser.

---

## Clara Galle gallery page

Cine App includes an optional enriched page for the actress Clara Galle, with a full-screen photo gallery, detailed biography and external links.

This feature is **disabled by default** and requires a local photo folder on your host.

### Enable it

**1. Prepare the photos folder**

Create a folder anywhere on your host and add your photos (JPG, PNG or WebP).
Also place a file named exactly `clarabanner.jpg` in the same folder — it is used as the full-width banner at the top of the page.

Do not commit this folder or its contents to git.

**2. Mount the folder in your compose file**

```yaml
volumes:
  - /path/to/your/clara/photos:/app/gallery/clara:ro
```

See `docker-compose.example.yml` for the full example.

**3. Set the env var**

```env
CLARA_GALLERY_ENABLED=true
```

**4. Rebuild**

```bash
docker compose up -d --build
```

### Disable it

Set `CLARA_GALLERY_ENABLED=false` (or remove the variable) and rebuild.

---

## Notes

qBittorrent can be reached through a Gluetun container when it shares the same network namespace:

```env
QBITTORRENT_URL=http://gluetun:8080
```

Adjust this value depending on your own stack.
