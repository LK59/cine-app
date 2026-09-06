# Cine App

Self-hosted PWA that turns a Radarr / Sonarr / Bazarr / Jackett / qBittorrent / Jellyfin / Jellyseerr stack into **two interfaces on one container**: a Netflix-style front end everyone in the household uses, and a management dashboard for whoever runs the box.

## The two interfaces

| | Address | Who it is for |
|---|---|---|
| **Cinema** | `/` | Everyone. Rows of posters, a full-bleed hero, search, personal lists, requests, and in-browser playback. This is the front door. |
| **Management** | `/gestion` | The administrator. Radarr, Sonarr, Bazarr, Jackett, qBittorrent, Jellyfin, Jellyseerr, statistics, settings — the whole stack. |

Both run from the same container, the same session and the same set of API routes. There are only ever **two roles**: `admin` and `user`. A `user` can browse, play, keep lists and request titles; every write to the underlying services is refused server-side in `src/proxy.ts`, whatever the interface happens to show. The management screens are reachable from Cinema through **Compte → Gestion**, which only an administrator sees.

`/player` and `/cinema` are the addresses Cinema had before it became the root; both answer `308` to `/`, so old links, open tabs and already-installed home-screen shortcuts keep working.

<img src="docs/screenshots/dashboard-1.png" height="210"> <img src="docs/screenshots/dashboard-2.png" height="210"> <img src="docs/screenshots/dashboard-mobile.PNG" height="210">

---

## Features

### Home Page

- **Rotating hero banner** - showcases the 10 newest additions across movies and series, TMDB title-logo art when available, auto-advances every 8s with a segmented progress bar to jump back to a previous pick
- **Continue Watching** - Jellyfin resume progress with IMDb rating badge, click straight through to the sheet
- **My List** - quick-glance row of watchlist items marked "A voir"; titles not yet in the library get an inline "Demander" action
- **Recently Added** - separate movie/series rows with a "Voir tout" link to the full library page
- **TV-remote style keyboard navigation** - arrow keys move focus across every row on the home page, Enter opens the highlighted title

### Library & Media Management

- **Radarr and Sonarr library views** - grid and list modes, filtering, quick search, sort (including by IMDb rating), keyboard navigation
- **Movie and series detail pages** - poster, metadata, cast carousel, active downloads, file info, IMDb/RT/Metacritic ratings

<img src="docs/screenshots/fiche-film-1.png" height="210"> <img src="docs/screenshots/fiche-film-2.png" height="210"> <img src="docs/screenshots/fiche-film-mobile.PNG" height="210">
- **Watchlist** - add any title from TMDB, classify with 5 statuses (A voir, Favoris, Vus, A demander, Abandonnes), personal notes, search and sort, IMDb rating badge on every card

<img src="docs/screenshots/watchlist-1.png" height="260"> <img src="docs/screenshots/watchlist-mobile.PNG" height="260">
- **Natural language search** - find titles with queries like `film de guerre de Christopher Nolan`, `serie avec Clara Galle` or `film comedie avec Ryan Gosling`

<img src="docs/screenshots/recherche-naturelle-1.png" height="160"> <img src="docs/screenshots/recherche-naturelle-2.png" height="160"> <img src="docs/screenshots/recherche-naturelle-3.png" height="160"> <img src="docs/screenshots/recherche-mobile.PNG" height="160">
- **Discover** - trending movies and series with genre filters, TMDB search, "Pour vous" tab based on Jellyfin play history
- **Recommendations** - personalised rows based on recently watched Jellyfin history
- **Release search modal** - browse and grab releases directly from Radarr/Sonarr inside the app
- **Interactive search (movies)** - admin-only button on Watchlist, Discover and Recommendations cards to add a movie and open the release search in one step; the movie is added unmonitored until a release is actually picked, so an abandoned search doesn't leave Radarr endlessly re-searching an empty entry
- **Add to library (series)** - admin-only button that adds a series to Sonarr directly; per-season interactive search and a one-click automatic search (Sonarr's own standard search, available to every user) both live on the series' own detail page
- **Remove from Radarr/Sonarr** - discrete button on detail pages with in-app confirmation modal, also clears the matching Jellyseerr record so the title can be requested again cleanly

### Unified Visual Identity

All media grids (Watchlist, Discover, Recommendations) share the same card design:

- Poster-only card with `aspect-[2/3]`
- **Desktop** - hover overlay with 5 status buttons, Voir la fiche / Demander, and admin-only Recherche interactive (movies) / Ajouter (series)
- **Mobile** - tap to open an ActionSheet with real-time swipe-to-close gesture
- **IMDb rating badge** - always visible bottom-left, fetched via OMDB API
- **"Dispo" badge** (green) - file actually downloaded
- **"Attente" badge** (amber) - monitored in Radarr/Sonarr but not yet available
- **Delete confirmation** - native in-app modal before removing from watchlist

### Jellyfin Integration

- Resume watching section with per-user progress
- Recently added and recently played
- Mark watched / unwatched from any detail page
- Per-user recommendations based on play history
- **In-app playback** (optional, disabled by default - see [In-App Playback](#in-app-playback)) - play movies and episodes directly in Cine App instead of redirecting to Jellyfin web, with resume, audio/subtitle track selection, chapters, playback speed, trickplay scrubbing previews, skip-intro and automatic next-episode advance
- **Draggable mini-player** - shrink playback into a small, freely draggable window while browsing the rest of the app; playback keeps running uninterrupted

### Requests & Downloads

- **Jellyseerr request management** - requests are made and tracked using each logged-in user's own Jellyseerr account (auto-linked at login via the same Jellyfin credentials), not a shared admin key, so status and history are correctly attributed per person
  - Movies - one-click request with confirmation
  - Series - pick specific seasons to request, based on their actual current status in Jellyseerr (already requested/available seasons are shown as such and excluded); requesting more seasons later for a partially-requested series works as a normal follow-up request, not a rejected duplicate
  - Admins see and manage every pending request instance-wide; regular users only see their own
- **qBittorrent monitoring** - live torrent list with section separators (En cours / Seed / Pauses), progress bars, speed indicators, start/stop/remove actions

### Calendar & Timeline

- Media release calendar (upcoming Radarr/Sonarr entries)
- Activity timeline

### Ratings

- **MDBList** - IMDb, Rotten Tomatoes, Metacritic, Letterboxd, Trakt on detail pages
- **OMDB** - IMDb rating badge shown on Watchlist cards, the home page (hero, Continue Watching, My List, Recently Added) and the Radarr/Sonarr library grids, cached 24 h server-side; movies read Radarr's own rating data directly with no extra API call
- **Sort by IMDb rating** - available on the Radarr and Sonarr library pages alongside the existing sort options
- TMDB vote average shown on Discover and Recommendations cards

### Stats

- Top actors and directors ranked by number of titles in the library
- Accurate library/person statistics across movies and series

<img src="docs/screenshots/menu-stats-mobile.PNG" height="320">

### Other

- Service health dashboard

<img src="docs/screenshots/sante-systeme-1.png" width="100%">

- Bazarr subtitle management per episode
- NFO viewer
- Actor / person modal with filmography

<img src="docs/screenshots/fiche-acteur-1.png" height="260"> <img src="docs/screenshots/fiche-acteur-mobile.png" height="260">
<img src="docs/screenshots/fiche-acteur-recherche-1.png" width="49%"> <img src="docs/screenshots/fiche-acteur.recherche-2.png" width="49%">

- Collection modal (saga grouping)
- Trailer modal
- Installable PWA
- Web Push notifications including iOS Safari / Apple Web Push
- Multi-language interface - French, English, Spanish, German, including the in-app video player
- Mobile-first navigation with haptic feedback (Android/Chromium only - iOS Safari has never implemented the Web Vibration API, even in an installed PWA)

<img src="docs/screenshots/menu-mobile.PNG" height="320">

- Guest mode (read-only, watchlist allowed)
- Admin mode (full access including interactive search and deletion)

---

## Optional services

Only **Jellyfin** and **TMDB** are needed for Cinema to be worth opening; Radarr and Sonarr are what fill it. Everything else is optional, and an integration that is not configured is treated as a configuration, not as a failure:

- `/api/config/public` reports which services are connected — booleans only, never an address or a key, since that route is read without a session.
- A page whose service is missing shows what is missing and the exact variables to add to `.env`, instead of a network error.
- The sidebar dims those entries rather than hiding them, so a page someone is looking for can still be found and explain itself.
- In Cinema, requests disappear when Jellyseerr is absent, and playback falls back to the server-side player when the browser cannot handle a file.

A service that is configured but **down** is a different thing and reads differently: `/health` and the status cards say so, with the error the service itself returned.

## Requirements

- Docker / Docker Compose
- Existing media stack services (see https://github.com/LK59/cinema)
- API keys for Radarr, Sonarr, Bazarr, Jackett, Jellyfin and Jellyseerr
- A shared Docker network with your media services

---

## Deployment

**You do not need to clone this repository.** The published image already
contains the full built app — all you need on your server are two config
files. Create a folder and download them directly:

```bash
mkdir cine-app && cd cine-app
curl -O https://raw.githubusercontent.com/LK59/cine-app/main/.env.example
curl -O https://raw.githubusercontent.com/LK59/cine-app/main/docker-compose.example.yml
```

(Cloning the repo works too if you'd rather browse the code or docs locally — it just isn't required.)

Create your environment file:

```bash
cp .env.example .env
```

Edit `.env` and configure:

| Variable | Description |
|---|---|
| `APP_ADMIN_USER` / `APP_ADMIN_PASSWORD` | Local Cine App admin fallback account |
| `SESSION_SECRET` | Secret used to sign sessions |
| `RADARR_URL` / `RADARR_API_KEY` | Radarr connection |
| `SONARR_URL` / `SONARR_API_KEY` | Sonarr connection |
| `JELLYFIN_URL` / `JELLYFIN_API_KEY` | Jellyfin connection |
| `JELLYSEERR_URL` / `JELLYSEERR_API_KEY` | Jellyseerr connection |
| `QBITTORRENT_URL` / `QBITTORRENT_*` | qBittorrent credentials |
| `TMDB_API_KEY` | Required for Discover, Recommendations and person/media metadata |
| `OMDB_API_KEY` | Optional - IMDb ratings on Watchlist cards |
| `MDBLIST_API_KEY` | Optional - multi-source ratings on detail pages |
| `APP_LANGUAGE` | Default instance language (`fr` \| `en` \| `es` \| `de`) — used for accounts with no saved preference and on the login page (default: `en`) |
| `VAPID_*` | Optional - Web Push notifications |
| `PLAYER_ENABLED` | Optional, default `false` - in-app video playback, may require server-side transcoding depending on the file/browser (see [In-App Playback](#in-app-playback)) |

### Docker Compose Setup

Copy the example compose file, then adapt it to your infrastructure:

```bash
cp docker-compose.example.yml docker-compose.yml
nano docker-compose.yml
```

`docker-compose.yml` is intentionally ignored by git. Keep your production compose local to your server, and commit changes to `docker-compose.example.yml` when you want to update the public template.

`docker-compose.example.yml` uses the pre-built image published on GitHub Container Registry — no build tools, no source checkout required:

```yaml
networks:
  media_net:
    external: true
    # If your existing Docker network has another name, change both this key
    # and the service network reference below.

services:
  cine-app:
    image: ghcr.io/lk59/cine-app:latest
    container_name: cine-app
    env_file:
      - .env
    environment:
      # Adapt to your timezone.
      - TZ=Europe/Paris
    volumes:
      # Persistent app data: SQLite database, watchlist, push subscriptions, etc.
      - ./data:/app/data

      # Optional media root, read-only.
      # Keep this enabled if you want disk/media-size stats based on your host path.
      # Replace the left side with your own media folder. The right side reads
      # MEDIA_ROOT from .env (defaults to /mnt/media/video) — if you override
      # MEDIA_ROOT in .env, it's picked up here automatically, no need to edit
      # this file too.
      - /path/to/your/media:${MEDIA_ROOT:-/mnt/media/video}:ro

      # Optional Clara Galle gallery.
      # Enable only if CLARA_GALLERY_ENABLED=true in .env.
      # The folder must contain:
      #   - JPG / PNG / WebP photos
      #   - clarabanner.jpg, used as the page banner
      # - /path/to/your/clara/photos:/app/gallery/clara:ro

    # If your media folders aren't world-readable (e.g. mode 770 owned by your own
    # user/group), the container's default user won't be able to read them — stats
    # will silently under-report. Set this to "<container-uid>:<your-gid>" (keep the
    # container's own uid, swap in `id -g youruser` from the host) so it can read
    # your files without loosening permissions on the host.
    # user: "1001:1000"

    # Optional direct access without a reverse proxy.
    # If you use Nginx Proxy Manager, Traefik or Caddy, you can leave this commented.
    # ports:
    #   - "3000:3000"

    networks:
      - media_net
    restart: unless-stopped
```

This is the exact content of `docker-compose.example.yml` — the two are kept in sync so there's only one template to adapt, not two diverging ones.

The `data` volume stores local app data such as the SQLite database. Do not commit it to git.

The app also keeps its own rolling safety net for that database: once a day it dumps
`data/cine.db` into `data/backups/cine-YYYY-MM-DD.db` (via SQLite's own online backup API,
no downtime), keeping only the last 7 days. This is not a substitute for a real backup of
the `data` volume itself — it only protects against a corrupted/truncated DB file on the
same host, not disk loss.

In your local `docker-compose.yml`, adapt:

- the external Docker network name;
- the timezone (`TZ`);
- the host media path mounted read-only (left side). The container-side path
  reads `MEDIA_ROOT` from `.env` and defaults to `/mnt/media/video` — same idea
  as Radarr's `/movies` or Sonarr's `/tv`. If you set `MEDIA_ROOT` (or the
  individual `MOVIES_PATH`/`TV_PATH`/`SEEDS_PATH`/etc. vars) in `.env`, it's
  picked up automatically both by the mount and by storage/disk stats — see
  `.env.example`;
- optional gallery/photo mounts;
- the `ports` section if you want direct access without a reverse proxy.

<details>
<summary>Building from source instead (only if you're modifying the code)</summary>

Replace the `image:` line with:

```yaml
build:
  context: .
  dockerfile: Dockerfile
```

Then use `docker compose up -d --build` instead of `docker compose pull` everywhere below. The build runs the test suite first — it fails loudly instead of shipping a broken image.

</details>

### Network / Service URLs

Cine App must be able to reach Radarr, Sonarr, Jellyfin, Jellyseerr, qBittorrent and the other services from inside the container.

Recommended setup:

- Put Cine App on the same Docker network as the rest of your media stack.
- Use Docker service names in `.env`, for example `http://radarr:7878`, `http://sonarr:8989`, `http://jellyfin:8096`.

Alternative setup:

- Use reachable LAN URLs or reverse-proxy URLs if your services are not on the same Docker network.
- Make sure those URLs are reachable from the Cine App container, not only from your browser.

Start the app:

```bash
docker compose pull
docker compose up -d
```

The app listens on port `3000` inside Docker. Use a reverse proxy (Nginx Proxy Manager, Traefik, Caddy) or expose the port directly for testing.

#### Development without rebuilding the image

`docker compose build` re-runs the full production build and writes a new set of image layers
every time — hundreds of megabytes of disk writes per iteration, which is pure waste when all
that changed is a source file.

For iterating, use the development stack instead. It runs `next dev` against the working tree,
bind-mounted, so edits are picked up by hot reload and nothing is rebuilt:

```bash
docker compose -f docker-compose.dev.yml up      # http://<server>:3001, Ctrl-C to stop
docker compose build && docker compose up -d     # deploy, as before
```

It runs alongside production — different container, its own port, its own build directory — so
the two never overwrite each other's output.

When a real build is needed, three things keep it from being expensive:

- `.dockerignore` excludes `data/` — the SQLite database, its backups and the image cache, 633 MB
  of runtime state that was being copied into the build context and into an image layer on every
  build while being useless to the image.
- `npm install` and `next build` use BuildKit cache mounts, so npm's download cache and Next's
  compiler cache survive between builds and are updated in place rather than recompiled from
  scratch into a fresh layer.
- Together: a rebuild after a source change transfers 61 kB of context instead of 676 MB, and
  takes about 35 seconds instead of a minute and a half.

The build cache does accumulate. `docker builder prune` reclaims it whenever it grows past what
you want to give it.

One caveat worth knowing: the development port is plain HTTP, and several browser APIs are
restricted to secure contexts. In particular the experimental WebCodecs player (see below) will
refuse to start there, saying so explicitly. Testing that specific feature needs HTTPS, so either
deploy it or point a reverse-proxy host at port 3001.

#### Reverse proxy: request header size (recommended)

Next.js sends a `Next-Router-State-Tree` header on client-side navigations, describing the route
tree of the page you are leaving. It is normally well under a kilobyte, but it grows with the
depth and number of segments an app has, and it is generated by the framework — an application
cannot split it or opt out of it.

nginx (and therefore Nginx Proxy Manager, which is nginx underneath) defaults to
`large_client_header_buffers 4 8k`, and **does not answer with an error when a header exceeds
that — it closes the connection**. The browser sees a network failure rather than an HTTP status,
which is a confusing thing to debug: a full page load of the same URL works, only the fast
client-side navigation to it dies.

This is a safety margin, not a hard requirement — measured on this deployment, the limit is
crossed somewhere between 8 KB and 10 KB of header, and normal traffic is nowhere near it. If you
run behind Nginx Proxy Manager, add this to the proxy host's **Advanced** tab:

```nginx
large_client_header_buffers 4 32k;
```

Plain nginx: the same directive in the `server` (or `http`) block. Traefik and Caddy have far
higher defaults and need nothing.

### First Login

Open Cine App through your configured URL. You land on **Cinema**, at `/`.

For normal use — including your own — log in with an existing **Jellyfin username and password**. That login carries a Jellyfin identity, which is what playback, resume points, watch state and playback preferences are built on.

The **local admin account** (`APP_ADMIN_USER` / `APP_ADMIN_PASSWORD`) exists for setup and for the day Jellyfin is unreachable. It has no Jellyfin identity, so nothing that depends on one works under it — starting a film, chapters, scrub previews, playback preferences. It therefore lands on `/gestion` rather than on Cinema, which is what it is for.

### Updating

```bash
docker compose pull
docker compose up -d
```

### After Changing `.env`

Most configuration is read by the server process. After changing `.env`, restart the container so the new values are loaded:

```bash
docker compose up -d
```

This restart command is safe to use after any configuration change.

---

## Authentication

Cine App supports two authentication methods.

### Jellyfin Users (Recommended)

Existing Jellyfin users can log in with their Jellyfin username and password.

This is the recommended login method for normal users because Cine App can associate the session with the Jellyfin user account. This enables per-user resume watching, play history, watched/unwatched actions and personalised recommendations.

Jellyfin administrator accounts are granted admin access in Cine App. Non-admin Jellyfin users are logged in as guest/read-only users.

### Local Admin Fallback

`APP_ADMIN_USER` and `APP_ADMIN_PASSWORD` define a local Cine App admin account, independent from Jellyfin.

Use it as a fallback/admin account for setup and maintenance.

---

## Optional Configuration

### Push Notifications

Cine App supports Web Push notifications for installed PWAs, including iOS Safari / Apple Web Push.

Web Push requires a VAPID key pair. These keys are not tied to a specific machine: they are just two secret strings that you generate once, then copy into the `.env` used by Cine App.

You can generate them in any of these environments:

- **On your Cine App server**, if Node.js/npm is installed.
- **On your local computer**, if Node.js/npm is installed, then copy the generated values to the server.
- **With Docker**, if you do not want to install Node.js/npm anywhere.

Option A - generate with Node.js/npm:

```bash
npx web-push generate-vapid-keys
```

Option B - generate with Docker:

```bash
docker run --rm node:20-alpine sh -lc "npm install -g web-push >/dev/null && web-push generate-vapid-keys"
```

The command prints something like:

```text
Public Key:
...

Private Key:
...
```

Copy these two values into the `.env` file on the host running Cine App, in the same directory as `docker-compose.yml`:

```env
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com
```

`VAPID_SUBJECT` can be any contact URI controlled by the administrator, usually an email address.

Then restart the Cine App container so the new environment variables are loaded:

```bash
docker compose up -d
```

After deployment, open Cine App as a user, go to **Settings -> Notifications**, enable push notifications for the current browser/PWA, then use the test button to confirm delivery.

### MDBList (Detail Pages)

Multi-source ratings on movie and series pages: IMDb, Rotten Tomatoes, Metacritic, Letterboxd, Trakt - all from a single API call.

Get a free key at **mdblist.com -> Settings -> API Key** (free tier: 1 000 req/day).

```env
MDBLIST_API_KEY=your_key_here
```

### OMDB (Watchlist Cards)

IMDb ratings displayed as a badge on each Watchlist card, fetched via the OMDB API and cached 24 h server-side.

Get a free key at **omdbapi.com** (free tier: 1 000 req/day).

```env
OMDB_API_KEY=your_key_here
```

Without these keys the rating sections are simply not shown. No rebuild is needed if keys are added after first launch; the app reads them at runtime.

### Clara Galle Gallery Page

Cine App includes an optional enriched page for the actress Clara Galle, with a full-screen photo gallery, detailed biography and external links.

This feature is disabled by default and requires a local photo folder on your host.

#### Enable It

Create a folder anywhere on your host and add your photos (JPG, PNG or WebP).

Also place a file named exactly `clarabanner.jpg` in the same folder. It is used as the full-width banner at the top of the page.

Do not commit this folder or its contents to git.

Mount the folder in your compose file:

```yaml
volumes:
  - /path/to/your/clara/photos:/app/gallery/clara:ro
```

See `docker-compose.example.yml` for the full example.

Set the env var:

```env
CLARA_GALLERY_ENABLED=true
```

Restart:

```bash
docker compose up -d
```

#### Disable It

Set `CLARA_GALLERY_ENABLED=false` (or remove the variable) and restart.

<img src="docs/screenshots/clara-1.png" width="49%"> <img src="docs/screenshots/clara-2.png" width="49%">
<img src="docs/screenshots/clara-3.png" width="49%"> <img src="docs/screenshots/clara-4.png" width="49%">

### In-App Playback

Play movies and episodes directly inside Cine App - custom player with seek, audio track and subtitle selection (size and manual offset), chapters, playback speed, trickplay scrubbing previews, resume, fullscreen, AirPlay/Chromecast casting, a draggable mini-player, skip-intro and automatic next-episode advance (via the [Intro Skipper](https://github.com/intro-skipper/intro-skipper) Jellyfin plugin, if installed) - instead of redirecting to Jellyfin's own web client.

Playback negotiates DirectPlay / DirectStream / Transcode the same way Jellyfin's own web client does, based on what the source file and the requesting browser actually support: a compatible file plays untouched (DirectPlay), an incompatible container with compatible streams gets remuxed without re-encoding (DirectStream), and only a genuinely incompatible codec/profile triggers a real transcode. A "Playback Info" panel inside the player shows which of the three is active, the reason if transcoding, and an estimated network bitrate.

Transcoding, when it does happen, still needs real server-side CPU/GPU work - how often that is depends entirely on your library's formats and the browsers you actually watch on. In-app playback is disabled by default as a precaution against that variable cost. Only enable it if your Jellyfin server has hardware transcoding (Quick Sync, NVENC, VAAPI, ...) or enough spare CPU to transcode in software when it's actually needed.

Without it, the existing "Open in Jellyfin" link still works exactly as before - this feature is purely additive.

Set the env var:

```env
PLAYER_ENABLED=true
```

Restart:

```bash
docker compose up -d
```

Disable again with `PLAYER_ENABLED=false` (or removing the variable) and restarting.

#### The second player: no server work at all

Behind an opt-in setting there is a second playback path that asks the server for
nothing beyond the file itself - no transcoding, no stream negotiation, no HLS.
The browser fetches the `.mkv` by byte ranges and everything else happens in the
tab: the file is repackaged into fragmented MP4 and handed to a real `<video>`,
so the picture is decoded in hardware and HDR is displayed natively. Where the
codecs make that impossible it decodes with WebCodecs onto a canvas instead, and
an `.mp4` is simply handed to the browser untouched.

It is the answer to the paragraph above: the transcoding cost is not reduced, it
is not incurred. On this library it plays 4K Dolby Vision + HDR10+ HEVC with
E-AC3 Atmos, on an iPhone, with nothing running on the server.

**[Full technical documentation](DOC-TECH.md)** - the three
paths, how the remuxer reconstructs decode times, what a keyframe really is in
Matroska (and why trusting the container is the single largest source of crashes
this player had), how audio is delivered or re-encoded, what the server is still
told about playback, and every trap that only real files revealed.

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

### Sessions

A session is a signed token (HMAC-SHA256) in an `httpOnly` cookie, with a server-side row so it can be revoked immediately rather than only on expiry. Three things are worth knowing:

- **The Jellyfin token and the Jellyseerr cookie travel inside it, encrypted** (AES-GCM, key derived from `SESSION_SECRET`). Signing is not hiding: without this, a stolen cookie handed over a working Jellyfin token rather than just a Cine App session.
- **Sessions slide.** The cookie is reissued past a day of age, keeping the same session id, so daily use never ends in a weekly sign-out.
- **Signing your other devices out affects Cine App only.** The Jellyfin sessions those logins opened are left alone — deliberately: nobody clicking that button expects to lose Jellyfin with it.

`SESSION_SECRET` must be set. Left at its default, the server refuses to start rather than logging a line nobody reads.

---

## Troubleshooting

### App Cannot Reach Radarr / Sonarr / Jellyfin

Check that:

- the service URL in `.env` is reachable from inside the Cine App container;
- Cine App is attached to the same Docker network as your media services, or uses reachable LAN/proxy URLs;
- the API key is correct;
- the target service is running.

If you use Docker service names, the name must match the service/container DNS name on the shared network.

### Jellyfin Login Fails

Check that:

- `JELLYFIN_URL` points to the internal URL reachable by Cine App, for example `http://jellyfin:8096`;
- the Jellyfin username/password works directly in Jellyfin;
- the Jellyfin server is reachable from the Cine App container.

The local admin login (`APP_ADMIN_USER` / `APP_ADMIN_PASSWORD`) is independent from Jellyfin and can be used as a fallback.

### Push Notifications Do Not Appear

Check that:

- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` are set in `.env`;
- the app was rebuilt/restarted after setting them;
- the app is served over HTTPS, which is required by most browsers for Web Push;
- notifications are enabled in **Settings -> Notifications** for the current browser or installed PWA;
- browser or OS notification permissions are not blocked.

On iOS, install the app to the Home Screen first, then enable notifications from inside the installed PWA.

### Recommendations Are Empty

Check that:

- `TMDB_API_KEY` is configured;
- the logged-in Jellyfin user has watch history;
- Cine App was opened with Jellyfin authentication, so it can associate the session with a Jellyfin user.

### Ratings Are Missing

Check that:

- `MDBLIST_API_KEY` is set for detail-page multi-source ratings;
- `OMDB_API_KEY` is set for IMDb badges on Watchlist cards;
- API free-tier limits have not been reached.

Without these keys, the app still works; the rating sections are simply hidden.

---

## Notes

qBittorrent can be reached through a Gluetun container when it shares the same network namespace:

```env
QBITTORRENT_URL=http://gluetun:8080
```

Adjust this value depending on your own stack.
