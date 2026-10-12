# Deploying Cine App

Step-by-step installation of Cine App on your own server, from the pre-built image published on
GitHub Container Registry.

**You do not need to clone this repository, and you do not need Node, npm or a build toolchain on
your server.** The published image already contains the built application. All you need is Docker,
a folder, and two configuration files — or one, since `.env` is optional: everything it holds can
also be entered in the application.

Everything below assumes a Linux host with Docker Engine and the Compose plugin. Roughly 20
minutes end to end, most of it spent collecting API keys.

---

## Contents

1. [What you are installing](#1-what-you-are-installing)
2. [Prerequisites](#2-prerequisites)
3. [Create the deployment folder](#3-create-the-deployment-folder)
4. [Collect your API keys](#4-collect-your-api-keys)
5. [Fill in `.env`](#5-fill-in-env)
6. [Adapt `docker-compose.yml`](#6-adapt-docker-composeyml)
7. [Prepare the data folder](#7-prepare-the-data-folder)
8. [Start the container](#8-start-the-container)
9. [Verify the installation](#9-verify-the-installation)
10. [Put it behind a reverse proxy](#10-put-it-behind-a-reverse-proxy)
11. [First login](#11-first-login)
12. [Optional features](#12-optional-features)
13. [Updating](#13-updating)
14. [Backups and restore](#14-backups-and-restore)
15. [Troubleshooting](#15-troubleshooting)
16. [Uninstalling](#16-uninstalling)

---

## 1. What you are installing

| | |
|---|---|
| **Image** | `ghcr.io/lk59/cine-app:latest` (public, no login required to pull) |
| **Also published as** | `ghcr.io/lk59/cine-app:<commit-sha>` — use it to pin or roll back |
| **Architecture** | `linux/amd64` |
| **Listens on** | port `3000` inside the container |
| **Runs as** | uid `1001`, gid `1001` (user `cineapp`), not root |
| **Writes to** | one volume: `/app/data` — SQLite database and its daily backups, generated secrets, logs, image cache, generated subtitles, problem-report screenshots |
| **Reads** | your media folder, read-only and optional — used for disk statistics only |
| **Containers** | one. There is no separate database, cache or worker container to run |
| **Health check** | `GET /api/ping` — answers when the server is up and can read its database |

Cine App is a **front end**, not a media stack. It does not download, transcode, index or store
anything itself: it talks to the services you already run. At minimum it needs Jellyfin (identity
and playback) and a TMDB key (metadata); Radarr and Sonarr are what fill it with a library.
Everything else is optional and degrades gracefully — a service you do not configure is treated as
a configuration, not as a failure.

---

## 2. Prerequisites

**On the server:**

- Docker Engine 24+ with the Compose plugin (`docker compose version` must answer).
- A user allowed to run `docker`.
- About 1 GB of free disk for the image, plus room for the image cache — count roughly 1 GB per
  2 000 library titles, at the high end.

**On your stack:**

- A running Jellyfin, reachable from the Docker host.
- Radarr and/or Sonarr, if you want a library to browse.
- Optionally Jellyseerr, qBittorrent, Bazarr, Jackett.
- **A Docker network your media services are attached to.** Check its name:

  ```bash
  docker network ls
  docker inspect jellyfin --format '{{json .NetworkSettings.Networks}}' | tr ',' '\n'
  ```

  If your services do not share a network, see [Network options](#network-options) in step 6.

**Accounts:**

- A free [TMDB](https://www.themoviedb.org/settings/api) API key. Without it there are no
  backdrops, no cast, no Discover and no recommendations — treat it as required.
- An administrator account on each service you want to connect (to read its API key).

---

## 3. Create the deployment folder

> **In a hurry?** [QUICKSTART.md](QUICKSTART.md) is a single compose file with no `.env`: a
> first-launch assistant asks for the account and the service keys in the browser. What follows is
> the advanced deployment — shared network, media folder, `.env`, hardening — and everything in it
> is optional.

Pick a folder that will hold the configuration and the persistent data. It is the only state of
this installation.

```bash
mkdir -p ~/cine-app && cd ~/cine-app

curl -O https://raw.githubusercontent.com/LK59/cine-app/main/.env.example
curl -O https://raw.githubusercontent.com/LK59/cine-app/main/docker-compose.advanced.yml

cp .env.example .env
cp docker-compose.advanced.yml docker-compose.yml
```

You now have four files. `.env` and `docker-compose.yml` are yours to edit; the two `.example`
files are the upstream templates, kept so you can diff against them after an update.

> Cloning the repository works too, if you would rather browse the code and the docs locally. It
> changes nothing about the deployment — the compose file still pulls the published image.

---

## 4. Collect your API keys

Open each service's web interface and copy its key. Do this before editing `.env`; it is the only
tedious part, and having all of them in front of you makes the next step a single pass.

| Service | Where the key lives |
|---|---|
| **Radarr** | Settings → General → Security → **API Key** |
| **Sonarr** | Settings → General → Security → **API Key** |
| **Bazarr** | Settings → General → Security → **API Key** |
| **Jackett** | Top-right of the dashboard → **API Key** |
| **Jellyfin** | Dashboard → Advanced → API Keys → **+** → name it `cine-app` |
| **Jellyseerr** | Settings → General → **API Key** |
| **qBittorrent** | No API key — its Web UI **username and password** are used |
| **TMDB** | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) → API Read Access / API Key (v3) |
| **OMDb** *(optional)* | [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx) — free tier, 1 000 req/day |
| **MDBList** *(optional)* | mdblist.com → Settings → API Key — free tier, 1 000 req/day |

<!-- CAPTURE : deploy-jellyfin-apikey.png
     Jellyfin Dashboard → API Keys, with a key named "cine-app" in the list.
     Crop to the panel; blur or redact the key value itself.
     Then uncomment:
<img src="docs/screenshots/deploy-jellyfin-apikey.png" width="70%">
-->

**No secret to invent.** `SESSION_SECRET`, which signs and encrypts sessions, and the Web Push key
pair are generated on first launch when `.env` leaves them empty, and kept in
`data/config/secrets.json`. To use your own session secret instead:

```bash
openssl rand -hex 32
# or, without openssl on the host:
docker run --rm node:24-alpine node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

A value set in `.env` always wins over the generated one. **The server refuses to start when that
value is shorter than 16 characters or one of the published example values**, deliberately — a
forged admin session is not something to warn about in a log nobody reads. Changing the secret
later, or losing `secrets.json`, signs everyone out.

---

## 5. Fill in `.env`

```bash
nano .env
```

`.env.example` is annotated section by section; the tables below are the summary. Anything you
leave empty simply disables the feature that needed it.

<a id="settings-in-the-app"></a>
**`.env` or the application.** Every variable below except the deployment options (secrets, admin
account, `TRUSTED_PROXIES`, `TZ`, media paths, the gallery, poster-preparation tuning) can also be
set in **Management → Settings → Server settings**. The order is: the value set in the application,
then `.env`, then the default. A change made in the application applies without a restart (poster
preparation from the next start); the page shows which values come from `.env`, and **Back to the
.env value** hands control back to the file. A change to `.env` takes effect when the container is
recreated (`docker compose up -d`).

**The first-launch assistant.** When `.env` does not already set Jellyfin, TMDB and Radarr or
Sonarr, the first visit opens an assistant at `/setup` that creates the administrator account and
asks for those services ([QUICKSTART.md](QUICKSTART.md)). An installation configured through `.env`
skips it; `SETUP_COMPLETE=true` skips it explicitly. Until the assistant's administrator account
exists, anyone who can reach the app can create it: run it straight after the first start.

### Required

| Variable | Value |
|---|---|
| `APP_ADMIN_USER` / `APP_ADMIN_PASSWORD` | Local admin account, independent from Jellyfin. Your way in during setup and the day Jellyfin is down. Optional when the assistant created one (set here, it replaces it). With neither, only Jellyfin accounts can sign in. The old example value `change-me` stops the startup. |
| `JELLYFIN_URL` | Internal URL, reachable **from inside the container** — e.g. `http://jellyfin:8096`. Not the address in your browser's bar. |
| `JELLYFIN_API_KEY` | The key created in step 4. |
| `TMDB_API_KEY` | Metadata, artwork, cast, Discover, recommendations. |

### Strongly recommended

| Variable | Value |
|---|---|
| `JELLYFIN_PUBLIC_URL` | Public Jellyfin address, used by the "Open in Jellyfin" links. |
| `RADARR_URL` / `RADARR_API_KEY` | The movie library. |
| `SONARR_URL` / `SONARR_API_KEY` | The series library. |
| `COOKIE_SECURE` | `true` as soon as the app is served over HTTPS. Leave `false` only while testing over plain HTTP. |
| `APP_LANGUAGE` | Default instance language: `fr`, `en`, `es` or `de`. Used on the login page and for any account with no saved preference. |

### Optional services

| Variable | What it adds |
|---|---|
| `SESSION_SECRET` | Generated on first launch when empty — see [step 4](#4-collect-your-api-keys). |
| `JELLYSEERR_URL` / `JELLYSEERR_API_KEY` | Requests. Without it, the request buttons disappear from the interface. Jellyfin accounts are imported into Jellyseerr automatically — see [step 11](#11-first-login). |
| `QBITTORRENT_URL` / `QBITTORRENT_USERNAME` / `QBITTORRENT_PASSWORD` | Live torrent monitoring in the management interface. |
| `BAZARR_URL` / `BAZARR_API_KEY` | Subtitle management. |
| `JACKETT_URL` / `JACKETT_API_KEY` | Indexer status. |
| `OMDB_API_KEY` | IMDb rating badges on cards. |
| `MDBLIST_API_KEY` | IMDb / Rotten Tomatoes / Metacritic / Letterboxd / Trakt on detail pages. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push notifications. The key pair is generated on first launch when empty — see [step 12](#12-optional-features). |
| `RADARR_QUALITY_PROFILE` / `SONARR_QUALITY_PROFILE` | Quality profile given to titles added from the app (its numeric ID). Empty: the first profile the service lists. Easier to pick from the list in *Server settings*. |
| `PLAYER_ENABLED` | In-app playback. Default `true` — see [step 12](#12-optional-features). |
| `PLAYER_SERVER_FALLBACK` | Whether a file the browser cannot play is handed to Jellyfin. Default `true`; `false` guarantees no playback can start a transcode. |
| `PLAYER_AUTO_FRAME` | Enlarge the picture over black bars baked into the file. Default `true`; needs Jellyfin's trickplay images. |
| `CHROMECAST_FOR_EVERYONE` | Who sees the Chromecast button: every account (`true`, default) or administrators only (`false`) — see [step 12](#chromecast-and-airplay). |
| `CAST_RECEIVER_APP_ID` | The receiver application a Chromecast opens. Empty: Google's Default Media Receiver. |
| `SUBTITLE_GEN_*` | Generated subtitles: provider, API key, model, monthly budget, prices — see [step 12](#generated-subtitles). Without a key the feature does not exist. |
| `POSTER_PREWARM` / `POSTER_PREWARM_WIDTHS` / `POSTER_PREWARM_LOCALES` | Prepare the catalogue's posters in the background (default on; widths `384,750`; languages `fr` plus `APP_LANGUAGE`). Read at startup. |
| `CLARA_GALLERY_ENABLED` | An optional enriched person page, with a public slideshow. Needs a photo folder mounted; off by default — see [step 12](#12-optional-features). |
| `TRUSTED_PROXIES` | The reverse proxy whose `X-Forwarded-For` the app may believe — see [step 10](#10-put-it-behind-a-reverse-proxy). Empty keeps the older behaviour. |
| `NEW_ACCOUNT_BLOCKED_TAGS` | Jellyfin tags blocked automatically on every account created after the first start, e.g. a tag reserving some titles to a few accounts. Also settable in *Server settings → Default settings*. |
| `HOME_BROWSE_BUTTON` / `HOME_CONTINUE_HERO` | Default home layout: the *Browse all* button (default `true`) and a banner showing what an account is watching first (default `false`). Each account can override both in *Account → Interface*. |

### Storage paths

Used only by the disk and library-size statistics.

| Variable | Default |
|---|---|
| `MEDIA_ROOT` | `/mnt/media/video` — the media root **as seen inside the container** |
| `MOVIES_PATH` | `$MEDIA_ROOT/movies` |
| `TV_PATH` | `$MEDIA_ROOT/tv` |
| `SEEDS_PATH` | `$MEDIA_ROOT/downloads/seeds` |
| `SEED_MOVIES_PATH` / `SEED_TV_PATH` / `CROSS_SEED_PATH` | Derived from `SEEDS_PATH` |

Leave the sub-paths empty unless your tree differs from the standard Radarr/Sonarr layout.
`MEDIA_ROOT` is picked up by the compose file's media mount automatically, so setting it in one
place is enough.

### About service URLs

The URLs in `.env` are resolved **by the container**, not by your browser. Three cases:

- **Same Docker network (recommended)** — use container names: `http://radarr:7878`,
  `http://sonarr:8989`, `http://jellyfin:8096`.
- **Services on the host, container on a bridge network** — use the host's LAN IP,
  e.g. `http://192.168.1.20:8096`. `localhost` inside the container means the container itself.
- **Services behind a reverse proxy** — the public HTTPS URL works, at the cost of a round trip
  through the proxy for every call.

A common special case: when qBittorrent shares a VPN container's network namespace, its address is
the VPN container's — `QBITTORRENT_URL=http://gluetun:8080`.

---

## 6. Adapt `docker-compose.yml`

```bash
nano docker-compose.yml
```

The template is `docker-compose.advanced.yml`, reproduced here with what each block is for. Four
things need your attention: the **network name**, the **timezone**, the **media path**, and
whether you need **`ports`**.

### The service

```yaml
services:
  cine-app:
    image: ghcr.io/lk59/cine-app:latest
    container_name: cine-app
    env_file:
      - .env
    environment:
      - TZ=Europe/Paris
```

`TZ` is what makes container timestamps match your own clock — set it to your zone
([list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)). It does not affect times
displayed in the app, which are always formatted in each viewer's own browser.

To pin a version instead of following `latest`, replace the tag with a commit SHA:
`image: ghcr.io/lk59/cine-app:a1b2c3d…`.

### The volumes

```yaml
    volumes:
      - ./data:/app/data
      - ./data/image-cache:/app/.next/cache/images
      - /path/to/your/media:${MEDIA_ROOT:-/mnt/media/video}:ro
      # - /path/to/your/clara/photos:/app/gallery/clara:ro
```

| Mount | Required | What it holds |
|---|---|---|
| `./data:/app/data` | **Yes** | SQLite database, lists, settings made in the app, push subscriptions, generated secrets, logs, daily backups, generated subtitles. Lose it and you lose every list and every setting. |
| `./data/image-cache:/app/.next/cache/images` | Optional | Optimised posters, backdrops and logos. Without this line the app links the same folder (`data/image-cache`) at startup, so the cache survives updates either way; the line is kept so older installs see no change. |
| the media mount | Optional | Read-only, used for disk/size statistics. Remove the line if you do not want them. |
| the gallery mount | Optional | Only if `CLARA_GALLERY_ENABLED=true`. |

**Only edit the left-hand side of the media mount** — your host path. The right-hand side reads
`MEDIA_ROOT` from `.env`, so the container path and the statistics paths can never drift apart.
Mount the same root Radarr and Sonarr see, so the paths they report actually exist for Cine App
too.

### File permissions

```yaml
    # user: "1001:1000"
```

The container runs as uid `1001`. If your media folders are not world-readable — mode `770` owned
by your own user, typically — that uid cannot read them, and the statistics silently under-report
instead of failing.

The fix is to keep the container's uid and give it your group:

```bash
id -g "$USER"     # e.g. 1000
```

```yaml
    user: "1001:1000"
```

The media mounts stay `:ro`, so this grants reading, never writing.

### The network

```yaml
networks:
  media_net:
    external: true
```

```yaml
    networks:
      - media_net
```

`external: true` means "this network already exists, do not create it". Replace `media_net` with
your own network's name **in both places**.

<a id="network-options"></a>
**If your services do not share a network**, you have three options, best first:

1. Attach them to a shared network — create one with `docker network create media_net`, then add
   it to each service's compose file. This is the setup the app is designed for.
2. Use LAN IPs in `.env` and drop the `networks:` blocks entirely.
3. `network_mode: host` — works, but gives up container isolation and the `ports` mapping.

### Limits and hardening

```yaml
    mem_limit: 2g
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/api/ping"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
```

`mem_limit` is a ceiling against a leak, well above normal use (nothing heavy runs in this
container: transcoding is Jellyfin's, remuxing happens in the browser). The process needs no
capability and no privilege. The container cannot be `read_only`: startup rewrites
`.next/static`. The health check reports `healthy` once the server answers and can read its
database; Docker does not restart an `unhealthy` container by itself — read the status in
`docker compose ps` or with a monitoring tool.

### Exposing the port

```yaml
    # ports:
    #   - "3000:3000"
```

Leave this commented if a reverse proxy on the same Docker network will forward to the container
by name. Uncomment it to reach the app directly at `http://<server>:3000` — useful for the first
test, and the only option if your proxy runs outside Docker. Change the left number if 3000 is
already taken: `"3005:3000"`.

---

## 7. Prepare the data folder

The container is not root, and Docker creates missing bind-mount folders owned by root. Create
them yourself first, owned by the container's uid:

```bash
mkdir -p data/image-cache
sudo chown -R 1001:1001 data
```

If you set `user: "1001:1000"` in the compose file, match it here: `sudo chown -R 1001:1000 data`.

Skipping this step is the single most common failed first start: the app cannot write to its
data directory and exits.

---

## 8. Start the container

```bash
docker compose pull
docker compose up -d
```

Watch the first start:

```bash
docker compose logs -f cine-app
```

A healthy start prints a few `[démarrage]` lines (secrets read from `data/config/secrets.json`,
poster cache linked), the Next.js banner and `Ready in …`. Then `Ctrl-C` to stop following — the
container keeps running. A refusal is printed as `[démarrage] refusé : …` and the process exits.

| What you see instead | What it means |
|---|---|
| `SESSION_SECRET est la valeur d'exemple publiée.` (or `…fait N caractères — 16 au moins.`, or `…est vide.`) followed by `Posez-en un dans .env (openssl rand -hex 32) — sans lui, une session administrateur peut être forgée.`, and an immediate exit | The secret set in `.env` is an example value or too short — set a proper one, or empty the line to have one generated. `…est vide.` means the generated one could not be written: see the data-folder row below. The message is in French. This is intentional. |
| `APP_ADMIN_PASSWORD est la valeur d'exemple publiée.` and an immediate exit | The admin password was left at `change-me`. Choose one, or leave it empty to disable the local admin account. |
| `DATA_DIR (/app/data) ne peut pas être écrit (EACCES). Donnez le dossier au compte du conteneur (chown -R 1001:1001 data).` and an immediate exit | Step 7 was skipped, or the ownership does not match `user:`. |
| `network media_net declared as external, but could not be found` | The network name in the compose file does not match `docker network ls`. |
| The container restarts in a loop | `docker compose logs --tail=50 cine-app` has the reason; the loop itself is `restart: unless-stopped` doing its job. |

---

## 9. Verify the installation

**Is it running?**

```bash
docker compose ps
```

With the health check of step 6, the status reads `healthy` about a minute after the start.

**Can it reach your services?** Open `http://<server>:3000/status` — this page is deliberately
public, no login required, precisely so it can be read when logging in is what fails. Signed out,
it only says whether signing in and watching work; signed in as the administrator, each service
answers for itself: connected, not configured, or unreachable with the error it returned. (Port
3000 on the host only answers with the `ports:` line uncommented — otherwise use your proxy's
address, or the shell check below.)

<!-- CAPTURE : deploy-status-page.png
     The public /status page, right after a successful install: every configured service green,
     the unconfigured ones shown as such.
     Full width, desktop, dark theme. Redact any hostname you would rather not publish.
     Then uncomment:
<img src="docs/screenshots/deploy-status-page.png" width="100%">
-->

The same summary, from the shell (signed out, so the three sign-in and playback capabilities):

```bash
curl -s http://localhost:3000/api/status/public | head -c 400
```

That needs the `ports:` line uncommented. This one works either way, from inside the container:

```bash
docker exec cine-app wget -qO- http://127.0.0.1:3000/api/status/public | head -c 400
```

**Can it reach a specific service?** Test from *inside* the container — that is the only vantage
point that counts:

```bash
docker exec cine-app node -e \
  "fetch(process.env.JELLYFIN_URL + '/System/Info/Public').then(r => console.log(r.status))"
```

`200` means the URL in `.env` is right. A timeout means a network problem, not a key problem.

---

## 10. Put it behind a reverse proxy

The app speaks plain HTTP on port 3000 and expects a proxy to terminate TLS. HTTPS is not optional
in practice: installing the PWA, Web Push and several browser APIs the player relies on are all
restricted to secure contexts.

Forward your hostname to `cine-app:3000` (same Docker network) or `<server-ip>:3000` (`ports`
uncommented), then set `COOKIE_SECURE=true` in `.env` and restart.

**Nginx Proxy Manager / plain nginx — one directive to add.** Next.js sends a
`Next-Router-State-Tree` header on client-side navigations. It is normally well under a kilobyte,
but it grows with the depth of the route tree, and nginx's default
`large_client_header_buffers 4 8k` **does not answer with an error when a header exceeds it — it
closes the connection**. The browser reports a network failure rather than an HTTP status, which
is confusing to debug: a full page load of the same URL works, only the fast client-side
navigation to it dies.

In NPM, the proxy host's **Advanced** tab; in plain nginx, the `server` or `http` block:

```nginx
large_client_header_buffers 4 32k;
```

In practice the limit is crossed somewhere between 8 KB and 10 KB, and normal traffic is nowhere
near it — this is a safety margin, not a hard requirement. **Traefik and Caddy
have far higher defaults and need nothing.**

No WebSockets are used. The live download messages arrive as server-sent events on `/api/sse`,
which must not be buffered: the app sends `X-Accel-Buffering: no`, which nginx (and so NPM)
honours; any other proxy needs buffering disabled for that path.

**Declare the proxy in `TRUSTED_PROXIES`.** Sign-in limits and logs are keyed by the client's
address. The app records the address of each connection itself and believes `X-Forwarded-For`
only when the connection comes from a proxy listed there — otherwise any container sharing the
Docker network could reach port 3000 directly and claim a new address on every attempt. Give the
proxy's container name (resolved every five minutes, so a recreated container with a new address
keeps working), an address, or an IPv4 network, separated by commas:

```dotenv
TRUSTED_PROXIES=nginx-proxy-manager
```

Restart after changing it. Left empty, the last `X-Forwarded-For` entry is used as before.

**Forward the original scheme and host, and leave the app's own headers alone.** Two features write
absolute addresses from `X-Forwarded-Proto` and `X-Forwarded-Host` (falling back to `Host`): casting
to a television, which fetches the stream itself, and the optional gallery's public slideshow.
Most proxies send them by default. The app also sets its own `Content-Security-Policy` — which
allows exactly the Google Cast sender scripts the Chromecast button loads — and answers the CORS
preflight (`OPTIONS`) a Chromecast sends for the stream; a proxy that replaces that header or
answers `OPTIONS` itself breaks casting.

**Cap the request body.** Problem reports accept screenshots up to 100 MB in total, and the app
refuses larger bodies — but only once the proxy has received them. A proxy with no limit
(`client_max_body_size 0` in nginx) will accept and spool anything first; something like
`client_max_body_size 110m;` on the Cine App host keeps that bounded.

---

## 11. First login

Open your URL. You land on **Cinema**, at `/`.

<!-- CAPTURE : deploy-login.png
     The login page, at the URL a new install lands on.
     Desktop, full width, no credentials typed in.
     Then uncomment:
<img src="docs/screenshots/deploy-login.png" width="70%">
-->

**Log in with a Jellyfin username and password** — yours included, for normal use. That login
carries a Jellyfin identity, and playback, resume points, watched state and playback preferences
are all built on it. Jellyfin administrators become Cine App administrators; everyone else logs in
as a regular user.

**The local admin account** — the one the first-launch assistant created, or the one set by
`APP_ADMIN_USER` / `APP_ADMIN_PASSWORD` — exists for setup and for the day Jellyfin is unreachable. It has no Jellyfin identity, so nothing depending on one works under
it — starting a film, chapters, scrub previews, playback preferences. It therefore lands on
`/gestion` rather than on Cinema, which is what it is for.

Nothing to create, invite or provision: every Jellyfin account on your server can already log in.

A forgotten password for the assistant's account is reset from the shell:
`docker exec -it cine-app node server-boot/reset-admin-password.mjs` (it asks twice, without
echoing). An account set in `.env` is changed there instead.

**With Jellyseerr:** a Jellyfin account Jellyseerr does not know yet is imported the first time it
signs in or makes a request — creating the account in Jellyfin is enough. If Jellyseerr still
cannot tell who is asking (unreachable, import refused), the request is refused with a message
rather than filed under the API key, which Jellyseerr would treat as its administrator.

---

## 12. Optional features

Each of these is a setting in **Management → Settings → Server settings**, applied at once, or a
variable in `.env` followed by `docker compose up -d`. Nothing ever needs a rebuild.

### Web Push notifications

Notifies a user when a title they requested becomes available. Works on installed PWAs, including
iOS Safari.

The VAPID key pair is generated on first launch and kept in `data/config/secrets.json`; nothing to
do unless you want to bring your own. To generate one — two secret strings, not tied to a machine:

```bash
docker run --rm node:24-alpine sh -lc \
  "npm install -g web-push >/dev/null && web-push generate-vapid-keys"
```

```env
VAPID_PUBLIC_KEY=…
VAPID_PRIVATE_KEY=…
VAPID_SUBJECT=mailto:admin@example.com
```

`VAPID_SUBJECT` must be a `mailto:` or HTTPS URI you control — Apple Web Push rejects anything
else. Restart, then in the app: **Account → Notifications**, enable them for this browser, and use
the test button. On iOS, install to the Home Screen *first*, then enable from inside the installed
app.

### In-app playback, and what it costs

In-app playback is **on by default** — films and episodes play inside Cine App instead of
redirecting to Jellyfin's web client, with resume, track selection, chapters, speed, trickplay
previews, skip-intro and next-episode advance.

```env
PLAYER_ENABLED=true            # the default; false removes in-app playback entirely
PLAYER_SERVER_FALLBACK=true    # the default; see below
```

The ordinary path costs the server nothing beyond serving bytes: the browser fetches the file over
byte ranges, repackages it in the tab and hands it to a native `<video>` — hardware decoding,
native HDR, no transcode. That is why the flag defaults to on; it was opt-in when every play meant
a Jellyfin transcode, and that is no longer what happens.

**The one case that can cost CPU** is the safety net. A file the native path cannot carry is
handed to Jellyfin, which negotiates DirectPlay / DirectStream / Transcode; only that
last one is real work, and how often it happens depends on your library's formats and the browsers
people watch on.

Set `PLAYER_SERVER_FALLBACK=false` for a hard guarantee that **no playback can ever start a
transcode**. Nothing is then handed to Jellyfin: a file the browser cannot carry ends on a plain
playback error naming the reason, and the per-account "previous player" option — which selects the
same server-side player — is neither offered nor honoured. Reach for it if your Jellyfin server has
no hardware transcoding and no CPU to spare; leave it on otherwise, since it is what makes every
file playable. The « lighter version » the player switches to on a slow connection is such a transcode
(hardware-encoded when Jellyfin has it): it exists only when this player is enabled and the account's
Jellyfin policy allows video transcoding.

The playback log (`data/logs/player.log`) records every handover with its reason, so you can see
what your library actually needs before deciding. See [DOC-TECH.md](DOC-TECH.md).

### Chromecast and AirPlay

The player offers AirPlay on Apple devices and, on Chrome and Edge (computer or Android), a
Chromecast button marked *beta*. The page becomes a remote control; the television fetches a stream
Jellyfin prepares, through a signed address valid six hours for that one title. When the page goes
quiet (phone locked, tab closed), the server keeps the resume point from what the television
fetches.

```env
CHROMECAST_FOR_EVERYONE=true   # the default; false shows the button to administrators only
CAST_RECEIVER_APP_ID=          # empty: Google's Default Media Receiver, nothing to register
```

What it needs from the deployment: the address the app is reached at must be reachable **from the
television**, and the reverse proxy must forward `X-Forwarded-Proto` / `X-Forwarded-Host` and leave
the app's `Content-Security-Policy` and CORS answers alone ([step 10](#10-put-it-behind-a-reverse-proxy)).
Casting goes through Jellyfin's own negotiation, so it can cost Jellyfin a transcode; with
`PLAYER_SERVER_FALLBACK=false` the Chromecast button is not offered.

### Generated subtitles

When a title has a full text subtitle in one language and the viewer wants another, the player can
have it translated by an online AI while the film plays, starting from where the viewer is. Set it
up in **Management → Settings → Server settings → Generated subtitles**, or in `.env`:

```env
SUBTITLE_GEN_PROVIDER=anthropic   # anthropic | openai | google
SUBTITLE_GEN_API_KEY=…            # the provider's API key
SUBTITLE_GEN_MODEL=               # empty: the provider's default model
SUBTITLE_GEN_BUDGET_USD=5         # monthly ceiling, all accounts together
SUBTITLE_GEN_PRICE_INPUT=         # USD per million tokens; empty: the app's price table
SUBTITLE_GEN_PRICE_OUTPUT=
SUBTITLE_GEN_ENABLED=true         # false turns it off while keeping the key
```

- **Without a key the feature does not exist**: no button, no route announces it. The key stays on
  the server — never sent to a browser, never written to a log.
- **Cost.** The provider bills per token. With the default model, a feature film costs on the order
  of a few cents. Every request's tokens are counted at the model's price; the monthly budget
  pauses running jobs and refuses new ones once reached. A model the price table does not know
  needs both prices filled in, or the feature does not start. Spending and jobs are shown on the
  same settings page.
- **Limits.** Each account may start 50 generations a day; joining, resuming or redoing a job does
  not count.
- **Where the files go.** The finished subtitle is kept in `data/subtitles/`, then handed to
  Jellyfin through its subtitle upload API (`POST /Videos/{id}/Subtitles`, with the Jellyfin API
  key), which writes it next to the video as an ordinary external subtitle that every Jellyfin
  client sees. **Jellyfin needs write access to its media folders for that.** If the upload keeps
  failing, the app serves its own copy from `data/subtitles/` instead. A name already taken by
  another subtitle is never overwritten.
- **Source.** Only text subtitles (SRT, ASS, WebVTT…) already in the file or next to it; image-based
  subtitles (PGS, VobSub) cannot be translated, and nothing is transcribed from the audio.
- Each job is logged in `data/logs/subtitle-gen.log` (never the key, never the text).

### The Clara Galle gallery

```env
CLARA_GALLERY_ENABLED=true
```

An enriched page for one actress, off by default. Mount the photos read-only at
`/app/gallery/clara` (the commented line in the compose template): JPG/PNG/WebP files, a
`clarabanner.jpg` used as the page banner, and optionally a `favicon.jpeg`. While it is off, every
`/api/gallery/clara` address answers `404`.

Enabling it makes two addresses public, with no login — a slideshow meant for sharing,
`/api/gallery/clara/random`, and the photos it shows, `/api/gallery/clara/<file>`. The list of all
files still needs a session. The slideshow writes absolute links (link previews require them),
built from the `X-Forwarded-Proto` and `X-Forwarded-Host` headers (falling back to `Host`): your
reverse proxy must forward them, or the links carry the wrong scheme or host.

### Media statistics

Keep the read-only media mount from step 6 and make sure `MEDIA_ROOT` matches the container-side
path. If sizes read as zero, it is almost always the uid: see [File permissions](#file-permissions).

---

## 13. Updating

```bash
cd ~/cine-app
docker compose pull
docker compose up -d
```

Database migrations run at startup and are idempotent; there is no separate step. Your `.env`,
your data and your image cache are untouched. Open tabs pick up the new version by themselves the
next time nothing is playing.

**After an update, diff the templates** to see whether anything new appeared:

```bash
curl -so .env.example.new https://raw.githubusercontent.com/LK59/cine-app/main/.env.example
diff .env.example .env.example.new
```

**Rolling back** means pinning the previous SHA tag:

```yaml
image: ghcr.io/lk59/cine-app:<previous-sha>
```

```bash
docker compose up -d
```

**Reclaiming space** after several updates: `docker image prune`.

### Building the image yourself

Only if you run modified sources. Clone the repository, replace `image:` in your compose file with:

```yaml
    build:
      context: .
      dockerfile: Dockerfile
      args:
        BUILD_REF: ${BUILD_REF:-}
```

then build and start:

```bash
BUILD_REF=$(tools/build-ref.sh) docker compose build && docker compose up -d && docker builder prune -f --max-used-space 15GB
```

`BUILD_REF` names the build — the short commit, with `-dirty` when tracked files differ — in the
settings page and on every log line; without it the build names itself with a timestamp. The build
runs the test suite first and stops on a failure. The dependency install is cached between builds:
an internal `manifest` stage resets the version in `package.json` / `package-lock.json` before
`npm install`, so a version bump alone does not reinstall everything. Each build still leaves a few
hundred megabytes of BuildKit cache that nothing else removes; the `prune` keeps it bounded.

### After changing `.env`

`.env` is read when the container starts (settings changed in the application apply at once):

```bash
docker compose up -d
```

Compose notices the environment changed and recreates the container. This is safe after any
configuration change.

---

## 14. Backups and restore

Everything that matters is in the `data` folder. Backing up the folder backs up the installation.

The app keeps its own rolling safety net on top of that: once a day it dumps `data/cine.db` into
`data/backups/cine-YYYY-MM-DD.db` using SQLite's online backup API — no downtime, no locking —
keeping the last 7 days. The copy leaves out the caches the app rebuilds on its own (searches,
cast lists), and a restart on a day that already has its backup does not make another one. That
protects against a corrupted or truncated database file. **It does
not protect against losing the disk**, since it sits on the same one. Copy the folder somewhere
else for that:

```bash
docker compose stop
tar czf cine-app-$(date +%F).tar.gz data .env docker-compose.yml
docker compose start
```

`data/image-cache` can be excluded — it rebuilds itself, at the cost of some re-encoding. Keep
`data/config/secrets.json`: without it every session ends and notification subscriptions stop
working. `data/subtitles/` holds the generated subtitles.

To restore: put `data` and `.env` back in place, check the ownership (`sudo chown -R 1001:1001
data`), and `docker compose up -d`.

---

## 15. Troubleshooting

**Read the right log.** `docker logs` dies with the container, which is recreated on every deploy
— an error someone hit yesterday evening may already be gone. The app writes its own, inside the
volume, one JSON object per line, rotated at 5 MB with a bounded number of archives (all of them
together stay under about 1.5 GB). The *Activity* page of the management area reads them too.

```bash
docker exec cine-app tail -n 50 /app/data/logs/server.log   # server errors (and browsers'), with stack traces
docker exec cine-app tail -n 50 /app/data/logs/player.log   # what each viewer's player reported
```

The others: `auth.log` (sign-ins, refusals, sign-outs), `startup.log` (each opening of the
cinema), `notifications.log` (every push sent, and its outcome), `subtitle-gen.log` (generated
subtitles), `bench.log` / `bench-player.log` (the device test bench).

| Symptom | Where to look |
|---|---|
| Container exits immediately | `docker compose logs cine-app`. Usually `SESSION_SECRET`, or `data` ownership (step 7). |
| Login fails for every user | `JELLYFIN_URL` must be reachable **from the container** — test it with the `docker exec` snippet in step 9. The local admin account bypasses Jellyfin entirely and tells you which half is broken. |
| A page says a service is missing | That service has no URL/key in `.env`. The page names the exact variables to add. |
| A service shows as unreachable on `/status` | The URL, not the key: a name that only resolves on your LAN, or a service that is down. |
| Library is empty | Radarr/Sonarr keys, and Jellyfin having actually scanned the library. |
| Posters are slow the first time | Expected — they are being optimised and cached. Make sure the image-cache mount is present so it happens once, not on every deploy. |
| Ratings missing | `OMDB_API_KEY` for card badges, `MDBLIST_API_KEY` for detail pages; check the free-tier daily limit. |
| Recommendations empty | `TMDB_API_KEY` set, the logged-in Jellyfin user has watch history, and the session is a Jellyfin one (not the local admin). |
| Push notifications never arrive | All three `VAPID_*` set, HTTPS, permission granted in the browser *and* the OS. On iOS, install to the Home Screen first. |
| Client-side navigation fails but reloads work | The nginx header buffer — step 10. |
| Disk statistics read zero | The media mount, and the uid that has to read it — [File permissions](#file-permissions). |
| Everyone signed out at once | `SESSION_SECRET` changed, or `data/config/secrets.json` was lost. Sessions are signed with it. |
| `unhealthy` in `docker compose ps` | The server does not answer `/api/ping` or cannot read its database: `server.log` and `docker compose logs`. |
| Chromecast finds the television but nothing plays | The television cannot reach the app's address, or the proxy drops `X-Forwarded-*`, replaces the CSP or answers `OPTIONS` — step 10. `player.log` has the Cast error code. |
| *Generate subtitles* is not offered | No `SUBTITLE_GEN_API_KEY`, `SUBTITLE_GEN_ENABLED=false`, or the title has no full text subtitle to start from. |
| Generated subtitles never appear in Jellyfin | Jellyfin cannot write next to the video (read-only media folder): the app keeps serving its own copy. `subtitle-gen.log` says why. |

**Asking the container itself.** It has every service URL and key in its environment, which makes
it the right place to test a hypothesis:

```bash
docker exec cine-app node -e \
  "fetch(process.env.RADARR_URL + '/api/v3/system/status?apikey=' + process.env.RADARR_API_KEY)
     .then(r => r.json()).then(j => console.log(j.version))"
```

---

## 16. Uninstalling

```bash
cd ~/cine-app
docker compose down
docker image rm ghcr.io/lk59/cine-app:latest
```

`down` removes the container and the network Compose created; it does not touch `data`, and it
never touches your media. Delete the folder to remove the last of it.

Nothing was written outside this folder: no host packages, no system services, no changes to
Radarr, Sonarr or Jellyfin beyond the Jellyfin API key you created, which you can revoke from its
dashboard.

---

## Related documentation

- **[README.md](README.md)** — what the two interfaces do, feature by feature.
- **[QUICKSTART.md](QUICKSTART.md)** — the minimal deployment with the first-launch assistant.
- **[DOC-TECH.md](DOC-TECH.md)** — the in-browser player: the native path and the server-side
  player behind it, the remuxer, audio delivery, generated subtitles and diagnostics.
