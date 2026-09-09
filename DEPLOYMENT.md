# Deploying Cine App

Step-by-step installation of Cine App on your own server, from the pre-built image published on
GitHub Container Registry.

**You do not need to clone this repository, and you do not need Node, npm or a build toolchain on
your server.** The published image already contains the built application. All you need is Docker,
a folder, and two configuration files.

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
| **Writes to** | one volume: `/app/data` (SQLite database, logs, backups, image cache) |
| **Reads** | your media folder, read-only and optional — used for disk statistics only |
| **Containers** | one. There is no separate database, cache or worker container to run |

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

Pick a folder that will hold the configuration and the persistent data. It is the only state of
this installation.

```bash
mkdir -p ~/cine-app && cd ~/cine-app

curl -O https://raw.githubusercontent.com/LK59/cine-app/main/.env.example
curl -O https://raw.githubusercontent.com/LK59/cine-app/main/docker-compose.example.yml

cp .env.example .env
cp docker-compose.example.yml docker-compose.yml
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

You also need one secret of your own. Generate it now:

```bash
openssl rand -base64 48
```

That string goes into `SESSION_SECRET`. It signs and encrypts sessions; **the server refuses to
start if it is left at its default value**, deliberately — a forged admin session is not something
to warn about in a log nobody reads. Changing it later signs everyone out, which is harmless but
worth knowing.

---

## 5. Fill in `.env`

```bash
nano .env
```

`.env.example` is annotated section by section; the tables below are the summary. Anything you
leave empty simply disables the feature that needed it.

### Required

| Variable | Value |
|---|---|
| `SESSION_SECRET` | The random string you just generated. The app will not start without it. |
| `APP_ADMIN_USER` / `APP_ADMIN_PASSWORD` | Local admin account, independent from Jellyfin. Your way in during setup and the day Jellyfin is down. Change the password. |
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
| `JELLYSEERR_URL` / `JELLYSEERR_API_KEY` | Requests. Without it, the request buttons disappear from the interface. |
| `QBITTORRENT_URL` / `QBITTORRENT_USERNAME` / `QBITTORRENT_PASSWORD` | Live torrent monitoring in the management interface. |
| `BAZARR_URL` / `BAZARR_API_KEY` | Subtitle management. |
| `JACKETT_URL` / `JACKETT_API_KEY` | Indexer status. |
| `OMDB_API_KEY` | IMDb rating badges on cards. |
| `MDBLIST_API_KEY` | IMDb / Rotten Tomatoes / Metacritic / Letterboxd / Trakt on detail pages. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push notifications — see [step 12](#12-optional-features). |
| `PLAYER_ENABLED` | In-app playback. Default `true` — see [step 12](#12-optional-features). |
| `PLAYER_SERVER_FALLBACK` | Whether a file the browser cannot play is handed to Jellyfin. Default `true`; `false` guarantees no playback can start a transcode. |
| `GUEST_USER` / `GUEST_PASSWORD` | A read-only shared account. Leaving `GUEST_PASSWORD` empty disables it entirely. |
| `CLARA_GALLERY_ENABLED` | An optional enriched person page. Needs a photo folder mounted; off by default. |

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

The template is `docker-compose.example.yml`, reproduced here with what each block is for. Four
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
| `./data:/app/data` | **Yes** | SQLite database, lists, push subscriptions, logs, daily backups. Lose it and you lose every list and every setting. |
| `./data/image-cache:/app/.next/cache/images` | **Strongly recommended** | Optimised posters, backdrops and logos. Without it, every redeploy starts from an empty cache and the server re-encodes the whole library again. |
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

Skipping this step is the single most common failed first start: the app cannot create its
database and exits.

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

A healthy start prints the Next.js banner and `Ready in …`. Then `Ctrl-C` to stop following — the
container keeps running.

| What you see instead | What it means |
|---|---|
| `SESSION_SECRET must be set` and an immediate exit | Step 4 was skipped. This is intentional. |
| `SQLITE_CANTOPEN` / `EACCES` on `/app/data` | Step 7 was skipped, or the ownership does not match `user:`. |
| `network media_net declared as external, but could not be found` | The network name in the compose file does not match `docker network ls`. |
| The container restarts in a loop | `docker compose logs --tail=50 cine-app` has the reason; the loop itself is `restart: unless-stopped` doing its job. |

---

## 9. Verify the installation

**Is it running?**

```bash
docker compose ps
```

**Can it reach your services?** Open `http://<server>:3000/status` — this page is deliberately
public, no login required, precisely so it can be read when logging in is what fails. Each service
answers for itself: connected, not configured, or unreachable with the error it returned.

<!-- CAPTURE : deploy-status-page.png
     The public /status page, right after a successful install: every configured service green,
     the unconfigured ones shown as such.
     Full width, desktop, dark theme. Redact any hostname you would rather not publish.
     Then uncomment:
<img src="docs/screenshots/deploy-status-page.png" width="100%">
-->

The same information, from the shell:

```bash
curl -s http://localhost:3000/api/status/public | head -c 400
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

Measured on this deployment, the limit is crossed somewhere between 8 KB and 10 KB, and normal
traffic is nowhere near it — this is a safety margin, not a hard requirement. **Traefik and Caddy
have far higher defaults and need nothing.**

While you are there: allow WebSocket upgrades if your proxy does not by default (NPM's
*Websockets Support* toggle). Server-sent events power the live status feeds.

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

**The local admin account** (`APP_ADMIN_USER` / `APP_ADMIN_PASSWORD`) exists for setup and for the
day Jellyfin is unreachable. It has no Jellyfin identity, so nothing depending on one works under
it — starting a film, chapters, scrub previews, playback preferences. It therefore lands on
`/gestion` rather than on Cinema, which is what it is for.

Nothing to create, invite or provision: every Jellyfin account on your server can already log in.

---

## 12. Optional features

Each of these is a variable in `.env` followed by `docker compose up -d`. Keys are read at runtime
— no rebuild, ever.

### Web Push notifications

Notifies a user when a title they requested becomes available. Works on installed PWAs, including
iOS Safari.

Generate a VAPID key pair once — they are just two secret strings, not tied to a machine:

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

**The one case that can cost CPU** is the safety net. A file neither the native path nor WebCodecs
can carry is handed to Jellyfin, which negotiates DirectPlay / DirectStream / Transcode; only that
last one is real work, and how often it happens depends on your library's formats and the browsers
people watch on.

Set `PLAYER_SERVER_FALLBACK=false` for a hard guarantee that **no playback can ever start a
transcode**. Nothing is then handed to Jellyfin: a file the browser cannot carry ends on a plain
playback error naming the reason, and the per-account "previous player" option — which selects the
same server-side player — is neither offered nor honoured. Reach for it if your Jellyfin server has
no hardware transcoding and no CPU to spare; leave it on otherwise, since it is what makes every
file playable.

The playback log (`data/logs/player.log`) records every handover with its reason, so you can see
what your library actually needs before deciding. See [DOC-TECH.md](DOC-TECH.md).

### Media statistics

Keep the read-only media mount from step 6 and make sure `MEDIA_ROOT` matches the container-side
path. If sizes read as zero, it is almost always the uid: see [File permissions](#file-permissions).

### Guest account

```env
GUEST_USER=guest
GUEST_PASSWORD=some-shared-password
```

Read-only across the whole app, with exactly one permitted action: requesting a title. Leave the
password empty to disable the account entirely — login then becomes impossible for it.

---

## 13. Updating

```bash
cd ~/cine-app
docker compose pull
docker compose up -d
```

Database migrations run at startup and are idempotent; there is no separate step. Your `.env`,
your data and your image cache are untouched.

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

### After changing `.env`

Configuration is read by the server process at startup:

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
keeping the last 7 days. That protects against a corrupted or truncated database file. **It does
not protect against losing the disk**, since it sits on the same one. Copy the folder somewhere
else for that:

```bash
docker compose stop
tar czf cine-app-$(date +%F).tar.gz data .env docker-compose.yml
docker compose start
```

`data/image-cache` can be excluded — it rebuilds itself, at the cost of some re-encoding.

To restore: put `data` and `.env` back in place, check the ownership (`sudo chown -R 1001:1001
data`), and `docker compose up -d`.

---

## 15. Troubleshooting

**Read the right log.** `docker logs` dies with the container, which is recreated on every deploy
— an error someone hit yesterday evening may already be gone. The app writes its own, inside the
volume, rotated at 5 MB, one JSON object per line:

```bash
docker exec cine-app tail -n 50 /app/data/logs/server.log   # server errors, with stack traces
docker exec cine-app tail -n 50 /app/data/logs/player.log   # what each viewer's player reported
```

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
| Everyone signed out at once | `SESSION_SECRET` changed. Sessions are signed with it. |

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
- **[DOC-TECH.md](DOC-TECH.md)** — the in-browser player: the three playback paths, the remuxer,
  audio delivery and diagnostics.
