# Installing CineApp

One compose file, one container, then everything is set in the browser.

1. [Copy the compose file](#1-the-compose-file)
2. [Start the container](#2-start-the-container)
3. [Put it behind a reverse proxy](#3-put-it-behind-a-reverse-proxy)
4. [The setup assistant, screen by screen](#4-the-setup-assistant-screen-by-screen)
5. [Settings in the app](#5-settings-in-the-app)
6. [Updates and backups](#6-updates-and-backups)
7. [Troubleshooting](#7-troubleshooting)

[Appendix: the advanced deployment](#appendix-the-advanced-deployment) ·
[Uninstalling](#uninstalling) · Every variable: [ENV.md](ENV.md)

**What you need:** a Linux host with Docker Engine and the Compose plugin (`docker compose version`
answers), a running Jellyfin, Radarr and/or Sonarr, and a free [TMDB](https://www.themoviedb.org/settings/api)
API key. You do not clone this repository, install Node, or write an `.env` file.

| | |
|---|---|
| **Image** | `ghcr.io/lk59/cine-app:latest`, public. Also tagged by commit (`ghcr.io/lk59/cine-app:<sha>`) to pin or roll back |
| **Architecture** | `linux/amd64` |
| **Listens on** | port `3000` inside the container, plain HTTP |
| **Runs as** | uid `1001`, gid `1001`, not root |
| **Keeps its state in** | `/app/data`: SQLite database and its daily backups, settings, generated secrets, logs, image cache, generated subtitles, report screenshots |
| **Reads** | your media folder, read-only and optional, for storage statistics only |
| **Health check** | `GET /api/ping` answers when the server is up and can read its database |

CineApp is a front end. It downloads, transcodes and stores nothing itself: it talks to the
services you already run. Jellyfin (accounts and playback), TMDB (posters, synopses) and Radarr or
Sonarr (the library) are needed; everything else is optional, and a service left unconfigured is
simply not shown.

---

## 1. The compose file

Create an empty folder, save this as `docker-compose.yml` inside it. It is
[`docker-compose.example.yml`](docker-compose.example.yml), unchanged:

```yaml
# CineApp — the minimal deployment.
#
#   1. Save this file as docker-compose.yml in an empty folder.
#   2. docker compose up -d
#   3. Open http://<server>:3000 — the setup assistant asks for everything else.
#
# No .env is needed: secrets are generated on first launch, and every setting is made in the app.
# Each optional line below is commented, with what it is for. Guide: DEPLOYMENT.md. Variables: ENV.md.
services:
  cine-app:
    image: ghcr.io/lk59/cine-app:latest   # or a commit tag (ghcr.io/lk59/cine-app:<sha>) to pin a version
    container_name: cine-app              # the name the commands in the guide use
    restart: unless-stopped

    # Direct access: http://<server>:3000. Change the left number if 3000 is taken ("3005:3000").
    # Behind a reverse proxy on the same Docker network, delete these two lines (nothing published)
    # and point the proxy at http://cine-app:3000.
    ports:
      - "3000:3000"

    # The Docker network your reverse proxy (and ideally Jellyfin, Radarr…) is attached to, so they
    # reach each other by container name. Uncomment here and in `networks:` at the bottom.
    # networks:
    #   - proxy

    volumes:
      # Everything the app keeps: database, settings, generated secrets, logs. The only state.
      - cine-data:/app/data
      # Variant: a folder next to this file instead of a named volume (replace the line above).
      # Create it first, owned by the container's user: mkdir data && sudo chown 1001:1001 data
      # - ./data:/app/data

      # Optional, read-only: your media, for Management → Statistics and the storage card only.
      # Mount the root Radarr and Sonarr see at /mnt/media/video; movies/, tv/ and downloads/seeds/
      # inside it are found on their own (other layouts: MEDIA_ROOT and *_PATH in ENV.md).
      # - /path/to/media:/mnt/media/video:ro

    environment:
      - TZ=Etc/UTC                        # your time zone (e.g. Europe/Paris), for logs and schedules
      # Behind an HTTPS reverse proxy (DEPLOYMENT.md, step 3):
      # - COOKIE_SECURE=true              # session cookies over HTTPS only — never while testing over http://
      # - TRUSTED_PROXIES=nginx-proxy-manager   # the proxy's container name: the only one believed about visitors' addresses

    # Optional: a memory ceiling, so a leak restarts this container instead of starving the host.
    # mem_limit: 2g

    # "healthy" in `docker compose ps` once the server answers and can read its database.
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/api/ping"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s

volumes:
  cine-data:
    name: cine-app-data                   # a fixed name, used by the backup commands in the guide

# networks:
#   proxy:
#     external: true                      # an existing network (`docker network ls`); use its real name
```

Or download it: `curl -o docker-compose.yml https://raw.githubusercontent.com/LK59/cine-app/main/docker-compose.example.yml`.

**What to adjust, line by line:**

| Line | When to change it |
|---|---|
| `ports` | Keep it to open `http://<server>:3000` directly, for the first test or when your proxy runs outside Docker. Delete it when a proxy on the same Docker network reaches `cine-app:3000`: nothing is then published on the host. |
| `networks` | Uncomment it to join the network your reverse proxy uses. If Jellyfin, Radarr and Sonarr are on it too, CineApp reaches them by container name (`http://jellyfin:8096`). `docker network ls` lists the networks; replace `proxy` with the real name, in both places. |
| `cine-data` | The named volume is ready to use: Docker creates it with the right owner. The bind-mount variant keeps the data in a visible `./data` folder; create it first and give it to uid `1001`, or the container cannot write and stops at once. |
| media mount | Only for Management → Statistics and the storage card. Mount the root Radarr and Sonarr use, read-only, at `/mnt/media/video`. Folders that are not world-readable need `user: "1001:<your gid>"`, see the [appendix](#file-permissions). |
| `TZ` | Your [time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), for log timestamps and scheduled tasks. Times shown in the app follow each viewer's device. |
| `COOKIE_SECURE`, `TRUSTED_PROXIES` | Behind a reverse proxy, [step 3](#3-put-it-behind-a-reverse-proxy). |
| `mem_limit` | Optional ceiling. Normal use stays in the low hundreds of megabytes: transcoding is Jellyfin's, and the player repackages files in the browser. |

**Addresses are seen from inside the container.** When the assistant asks for Jellyfin's address,
`localhost` means the CineApp container itself. Use the container name on a shared Docker network,
otherwise the server's LAN address (`http://192.168.1.10:8096`). A public `https://` address works
too, at the cost of a round trip through the proxy for every call.

---

## 2. Start the container

```bash
docker compose up -d
docker compose logs -f cine-app      # Ctrl-C stops following; the container keeps running
```

A good start prints a few `[démarrage]` lines (secrets generated into `data/config/secrets.json`,
poster cache linked), the version, and `Ready`. About a minute later `docker compose ps` reads
`healthy`.

Open `http://<server>:3000`: every page leads to the setup assistant until it is finished.

> **Run the assistant straight away.** Until its administrator account exists, anyone who can reach
> the port can create it. Keep the port on your local network until that is done.

If the container stops at once, the last log line says why, in French, on purpose:

| Message | Meaning |
|---|---|
| `DATA_DIR (/app/data) ne peut pas être écrit (EACCES)…` | The data folder (bind-mount variant) belongs to root. `sudo chown -R 1001:1001 data`, then `docker compose up -d`. |
| `SESSION_SECRET est la valeur d'exemple publiée.` / `…fait N caractères — 16 au moins.` | A `SESSION_SECRET` was set to an example or too short a value. Remove it to have one generated, or see [ENV.md](ENV.md#never-in-the-app). |
| `APP_ADMIN_PASSWORD est la valeur d'exemple publiée.` | An `APP_ADMIN_PASSWORD` was left at `change-me`. Remove it or choose a real one. |
| `network … declared as external, but could not be found` | The network name in the compose file does not match `docker network ls`. |

---

## 3. Put it behind a reverse proxy

The app speaks plain HTTP. Installing it on a phone's home screen, push notifications and several
browser features the player uses require HTTPS, so in practice a reverse proxy terminates TLS in
front of it.

Whatever the proxy:

1. Forward your hostname to `cine-app:3000` (proxy on the same Docker network) or to
   `<server-ip>:3000` (proxy outside Docker, `ports` kept).
2. Add to the compose file, then `docker compose up -d`:
   ```yaml
       environment:
         - COOKIE_SECURE=true                  # served over HTTPS
         - TRUSTED_PROXIES=<proxy container>   # e.g. nginx-proxy-manager, caddy, traefik
   ```
   `COOKIE_SECURE=true` sends session cookies over HTTPS only: never set it while you still open
   the app over `http://`, or no sign-in works. `TRUSTED_PROXIES` names the only machine allowed to
   tell CineApp a visitor's address (`X-Forwarded-For`) — sign-in limits and logs depend on it. It
   takes a container name (resolved every five minutes), an address or an IPv4 network,
   comma-separated.
3. Once the proxy works, delete the `ports` lines if the proxy is on the Docker network.

What the proxy must leave alone: the `X-Forwarded-Proto` and `X-Forwarded-Host` headers must be
forwarded (casting to a television builds its addresses from them), the app's own
`Content-Security-Policy` must not be replaced, and `OPTIONS` requests must reach the app (a
Chromecast sends them). Download progress arrives as server-sent events on `/api/sse` and must not
be buffered; the app sends `X-Accel-Buffering: no`, which nginx honours. No WebSockets are used.

### Nginx Proxy Manager

*Hosts → Proxy Hosts → Add Proxy Host*: your domain, scheme `http`, forward hostname `cine-app`,
port `3000`. *SSL* tab: request a certificate, *Force SSL*, *HTTP/2*. *Advanced* tab:

```nginx
large_client_header_buffers 4 32k;
client_max_body_size 110m;
```

The first line matters: nginx answers an oversized header by closing the connection, and Next.js
navigation sends a header that grows with the page tree — the symptom is a page change that fails
while a reload of the same address works. The second bounds problem-report uploads (100 MB of
screenshots at most); nginx's default of 1 MB would refuse them. Then
`TRUSTED_PROXIES=nginx-proxy-manager` (or your container's name). Plain nginx takes the same two
lines in its `server` block.

### Caddy

```caddyfile
cine.example.com {
	request_body {
		max_size 110MB
	}
	reverse_proxy cine-app:3000
}
```

Caddy obtains the certificate, sets the `X-Forwarded-*` headers and does not buffer server-sent
events. Then `TRUSTED_PROXIES=caddy`.

### Traefik

Labels on the CineApp service, with Traefik on the same network:

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.cineapp.rule=Host(`cine.example.com`)
      - traefik.http.routers.cineapp.entrypoints=websecure
      - traefik.http.routers.cineapp.tls.certresolver=letsencrypt   # your resolver's name
      - traefik.http.services.cineapp.loadbalancer.server.port=3000
```

Traefik needs nothing else. Then `TRUSTED_PROXIES=traefik`.

---

## 4. The setup assistant, screen by screen

Each screen saves what it holds when you press **Next**. You can leave and come back: the
assistant reopens where you stopped, until you press **Finish**.

| Screen | What it asks |
|---|---|
| **Hello** | The language of the installation (French, English, Spanish, German). It becomes the language of the sign-in page and of every account that has not chosen one. Pick one, or press **Next** to keep the one shown. |
| **1 · Account** | The local administrator account: a username and a password of eight characters or more, stored hashed. It opens Management even when Jellyfin is down. If an account already exists (one from a previous visit, or one fixed in `.env`), the screen asks you to sign in with it instead. |
| **2 · Jellyfin** | Its address and API key (*Jellyfin → Dashboard → API Keys → +*), and optionally the public address used by the *Open in Jellyfin* links. Below, one playback choice: hand files the browser cannot play over to Jellyfin, which converts them — on by default. |
| **3 · TMDB** | The API key (*themoviedb.org → Settings → API*). |
| **4 · Library** | Radarr and/or Sonarr: address and API key (*Settings → General → API Key*). At least one. |
| **5 · Extras** | Optional, all of it: Jellyseerr (requests), qBittorrent (download progress), Bazarr, Jackett, OMDb and MDBList (ratings), the built-in player and black-bar framing, the default language, poster preparation, the notification contact. Fill what you have; the rest can wait. A service left empty is not configured: the app never contacts it. Chromecast, generated subtitles and what new accounts receive are set later, in **Management → Configuration**. |
| **6 · Deployment** | Nothing to fill: the options that live in the compose file (time zone, media folder, reverse proxy, HTTPS), each with the line to copy. |
| **7 · Finish** | Refused while Jellyfin, TMDB or Radarr/Sonarr is missing. Then **Open management**, or **Sign in with Jellyfin** to go to the cinema. |

**_Next_ tests the connection.** On the Jellyfin, TMDB and Library screens, and for every extra
you filled in, *Next* saves the screen and then runs the same test as the *Test connection* button.
When a test fails, the screen stays, says which service failed and why, and offers **Continue
anyway** — useful when a service is not started yet; you can fix it later in **Configuration →
Connections**. The answers:

| Answer | What to check |
|---|---|
| *Connected — …* (the server's name and version) | Nothing: it works. |
| *Refused: the key or password is wrong.* | The key. The address is right, since the service answered. |
| *Invalid address (http:// or https://).* | The address must start with `http://` or `https://`. |
| *Unreachable: check the address from inside the container.* | The address: `localhost`, a container on another Docker network, a stopped service. |
| *No answer within 6 seconds.* | A firewall, or an address that leads nowhere. |

<!-- CAPTURE : deploy-jellyfin-apikey.png
     Jellyfin Dashboard → API Keys, with a key named "cine-app" in the list.
     Crop to the panel; blur or redact the key value itself.
     Then uncomment:
<img src="docs/screenshots/deploy-jellyfin-apikey.png" width="70%">
-->

### After the assistant

<!-- CAPTURE : deploy-login.png
     The login page, at the URL a new install lands on.
     Desktop, full width, no credentials typed in.
     Then uncomment:
<img src="docs/screenshots/deploy-login.png" width="70%">
-->

**Everyone signs in with their Jellyfin account** — nothing to create or invite. Playback, resume
points, watched state and preferences belong to that Jellyfin identity. Jellyfin administrators are
administrators here; everyone else is a regular user.

**The local administrator account** has no Jellyfin identity, so it cannot play films; it opens on
Management. Use your own Jellyfin account to watch. Lost its password?

```bash
docker exec -it cine-app node server-boot/reset-admin-password.mjs
```

It asks for the new password twice, without showing it. With Jellyseerr configured, a Jellyfin
account it does not know yet is imported the first time it signs in or makes a request.

**Check the services** at `/status`, readable without signing in: signed out it says whether
signing in and watching work; signed in as an administrator, each service answers for itself.

<!-- CAPTURE : deploy-status-page.png
     The public /status page, right after a successful install: every configured service green,
     the unconfigured ones shown as such.
     Full width, desktop, dark theme. Redact any hostname you would rather not publish.
     Then uncomment:
<img src="docs/screenshots/deploy-status-page.png" width="100%">
-->

---

## 5. Settings in the app

Three places, each for one kind of setting.

### Management → Configuration — the installation

Administrators only (`/gestion`, or **Account → Open management** in the cinema). Changes apply
at once, without a restart, unless the field says otherwise.

| Page | What it holds |
|---|---|
| **Connections** | Address, key and *Test connection* for each service: Jellyfin, TMDB, Radarr and Sonarr (with the quality profile given to titles added from the app), Jellyseerr, qBittorrent, Bazarr, Jackett, ratings. The *Application* card: poster preparation (applies at the next start) and the notification contact. |
| **Playback** | The built-in player, handing unplayable files to Jellyfin, black-bar framing, who sees the Chromecast button, and the Chromecast receiver. |
| **Generated subtitles** | Provider, key, model and monthly budget for AI-translated subtitles, with the month's spending and the jobs. |
| **New accounts** | What an account gets until it chooses otherwise: language, home banner, Jellyfin tags blocked automatically on new accounts. And the welcome screen, offered again to everyone or removed. |
| **Administrator** | The local administrator's password, a search diagnostic, and the installed version. |
| **Deployment** | What only the compose file can set — time zone, media folders, reverse proxy, HTTPS, an administrator fixed by `.env` — with the line to copy. Recreate the container after adding one. It also says whether `TRUSTED_PROXIES` (with its value) and `COOKIE_SECURE` are set in the running container. |

Each field says where its value comes from: *Default value*, *From .env*, or *Set here*. The
order and every variable are in [ENV.md](ENV.md).

**Playback and what it costs.** The built-in player has the browser read the file over byte ranges
and play it natively, with no transcode: the server only serves bytes. The one case that costs
CPU is the safety net — a file the browser cannot play is handed to Jellyfin, which converts it if
it must; so is the lighter version offered on a slow connection, and casting. Turn *Hand files the
browser can't play over to Jellyfin* off for a hard guarantee that no playback starts a transcode:
those files then end on a playback error naming the reason. `data/logs/player.log` records every
handover with its reason. Technical details: [DOC-TECH.md](DOC-TECH.md).

**Chromecast and AirPlay.** AirPlay is offered on Apple devices; Chromecast on Chrome and Edge
(computer or Android), marked *beta*. The television fetches the stream itself, so the app's
address must be reachable from the television, and the proxy must follow the rules of
[step 3](#3-put-it-behind-a-reverse-proxy).

**Generated subtitles.** When a title has a full text subtitle in one language and a viewer wants
another, an online AI translates it while the film plays. Without a key the feature does not
exist. The provider bills per token — a few cents for a feature film with the default model; the
monthly budget (5 US dollars by default) pauses jobs once reached, and each account may start 50
a day. The finished file is kept in `data/subtitles/` and handed to Jellyfin, which writes it next
to the video so every Jellyfin client sees it; Jellyfin needs write access to its media folders
for that, otherwise CineApp serves its own copy. Image subtitles (PGS, VobSub) cannot be
translated, and nothing is transcribed from the audio.

**Notifications.** The push keys are generated on first launch; nothing to set. Each person turns
them on in **Account → Notifications**, on each device. On iPhone and iPad, add the app to the Home
Screen first, then turn them on from inside it.

### Account → Administration — CineApp and its users

In the cinema's Account panel, for administrators:

- **Account activity** — who is here, who is watching what, sessions, sign-ins, devices, reports,
  logs, and **What's New**: the release-notes window, written, translated, then published to
  everyone.
- **Maintenance** — a banner on every screen during work on the server, and a warning sent to
  playback in progress before a restart.
- **Lab** — the device test bench, which plays a list of films on the device in hand and records
  what happened, and miscellaneous display tests.
- **Open management** — the way to Management. Management leads back with **Back to Cinema**.

### Account — personal preferences

Every account, administrators included: app language, playback languages (audio, subtitles —
shared with the Jellyfin apps), password, signed-in devices, notifications, interface, and help
(What's New, the welcome screen, service status, storage on this device, reporting a problem).

---

## 6. Updates and backups

### Updating

```bash
docker compose pull
docker compose up -d
```

Database migrations run at startup. Open tabs reload themselves to the new version the next time
nothing is playing. `docker image prune` reclaims the old images.

**Pin or roll back** by replacing `latest` with a commit tag:
`image: ghcr.io/lk59/cine-app:<sha>`, then `docker compose up -d`.

### Backups

Everything is in the data volume. The app also copies its database every night into `backups/`
inside it, keeping seven days — a guard against a damaged database file, not against losing the
disk. Copy the volume elsewhere for that, with the container stopped so the copy is consistent
(the image cache rebuilds itself):

```bash
docker compose stop
docker run --rm -v cine-app-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/cineapp-$(date +%F).tgz --exclude=./image-cache -C /data .
docker compose start
```

Restore:

```bash
docker compose down
docker run --rm -v cine-app-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/cineapp-YYYY-MM-DD.tgz -C /data'
docker compose up -d
```

With the bind-mount variant, copy the `data` folder instead (`tar czf cineapp-$(date +%F).tgz
--exclude=data/image-cache data docker-compose.yml`), and after a restore check its owner:
`sudo chown -R 1001:1001 data`.

**Keep `data/config/secrets.json`.** It holds the session secret and the push keys: without it,
everyone is signed out and notifications must be turned on again on every device.

### Building the image yourself

Only for modified sources. Clone the repository and replace `image:` with:

```yaml
    build:
      context: .
      dockerfile: Dockerfile
      args:
        BUILD_REF: ${BUILD_REF:-}
```

then:

```bash
BUILD_REF=$(tools/build-ref.sh) docker compose build && docker compose up -d && docker builder prune -f --max-used-space 15GB
```

`BUILD_REF` names the build (the short commit, `-dirty` when tracked files differ) in the
Administrator page and on every log line. The build runs the test suite first and stops on a
failure. Each build leaves a few hundred megabytes of build cache; the `prune` keeps it bounded.

---

## 7. Troubleshooting

**Read the app's own logs.** `docker logs` is lost each time the container is recreated; the app
writes its own into the volume, one JSON object per line, rotated at 5 MB. Account → Administration
→ Account activity reads them too.

```bash
docker exec cine-app tail -n 50 /app/data/logs/server.log   # server and browser errors, with stack traces
docker exec cine-app tail -n 50 /app/data/logs/player.log   # what each viewer's player reported
```

The others: `auth.log` (sign-ins), `startup.log` (each opening of the cinema), `notifications.log`,
`subtitle-gen.log`, `bench.log` and `bench-player.log` (the test bench).

| Symptom | Where to look |
|---|---|
| The container stops at once | [Step 2](#2-start-the-container): the last log line names the cause. |
| Every page leads to `/setup` | The assistant is not finished: open it and press **Finish**. |
| No Jellyfin account can sign in | Jellyfin's address, seen from the container: *Test connection* in Management → Configuration → Connections, or the shell check below. The local administrator account does not depend on Jellyfin and tells which half is broken. |
| Sign-in works over `http://` but not behind the proxy, or the reverse | `COOKIE_SECURE`: `true` only when served over HTTPS. |
| A page change fails, a reload of the same page works | The nginx header buffer, [step 3](#nginx-proxy-manager). |
| A service reads *Offline* on `/status` | Its address or key: *Test connection* says which. |
| The library is empty | Radarr/Sonarr keys, and Jellyfin having scanned the library. |
| Posters appear slowly the first time | Expected: they are prepared once, then kept in the volume. |
| Storage statistics are empty | The media mount, and the uid that reads it — [file permissions](#file-permissions). |
| Push notifications never arrive | HTTPS, permission granted in the browser and the system; on iOS, installed to the Home Screen first. |
| Everyone was signed out at once | `data/config/secrets.json` was lost, or `SESSION_SECRET` changed. |
| `unhealthy` in `docker compose ps` | The server does not answer `/api/ping` or cannot read its database: `server.log` and `docker compose logs`. |
| Chromecast finds the television but nothing plays | The television cannot reach the app's address, or the proxy drops `X-Forwarded-*`, replaces the CSP or answers `OPTIONS` itself. `player.log` has the Cast error code. |
| *Generate subtitles* is not offered | No provider key, the feature turned off, or no full text subtitle in the title. |

**Test from inside the container** — the only point of view that counts for addresses:

```bash
docker exec cine-app wget -qO- http://jellyfin:8096/System/Info/Public
```

A JSON answer means the address is right; a timeout or `bad address` means a network problem, not
a key problem.

---

## Appendix: the advanced deployment

[`docker-compose.advanced.yml`](docker-compose.advanced.yml) is the same service with a shared
external network, a bind-mounted `./data`, a media folder, an `.env` file and hardening
(`mem_limit`, `no-new-privileges`, no capabilities, health check). It suits an installation
configured as code. Start from it with:

```bash
curl -O https://raw.githubusercontent.com/LK59/cine-app/main/docker-compose.advanced.yml
curl -O https://raw.githubusercontent.com/LK59/cine-app/main/.env.example
cp docker-compose.advanced.yml docker-compose.yml
cp .env.example .env
mkdir -p data && sudo chown -R 1001:1001 data
```

`.env` is optional even there: every line of `.env.example` is commented, and [ENV.md](ENV.md)
describes each one. An installation whose `.env` already sets Jellyfin, TMDB and Radarr or Sonarr
skips the assistant.

### File permissions

The container runs as uid `1001`. Media folders that are not world-readable (mode `770` owned by
your own user, typically) cannot be read by it, and the storage figures stay empty instead of
failing. Keep the container's uid and give it your group:

```yaml
    user: "1001:1000"     # 1000 = the output of `id -g` for the user who owns the media
```

With the bind-mount variant, match the data folder: `sudo chown -R 1001:1000 data`. The media mount
stays `:ro`: this grants reading, never writing.

### Network options

If your services do not share a Docker network, best first:

1. Create one (`docker network create media`) and attach CineApp, the proxy and the services to it.
2. Use LAN addresses for the services in the assistant, and no `networks:` block.
3. `network_mode: host` works, but gives up isolation and the `ports` mapping.

When qBittorrent shares a VPN container's network, its address is the VPN container's
(`http://gluetun:8080`).

---

## Uninstalling

```bash
docker compose down
docker volume rm cine-app-data        # deletes every setting, list and log
docker image rm ghcr.io/lk59/cine-app:latest
```

Nothing was written outside the volume and this folder, and nothing was changed in Radarr, Sonarr
or Jellyfin beyond the API key you created and the devices CineApp sign-ins register in Jellyfin —
both visible, and revocable, in Jellyfin's dashboard.

---

## Related documentation

- **[ENV.md](ENV.md)** — every variable, its default, and where else it is set.
- **[README.md](README.md)** — what the two interfaces do, feature by feature.
- **[DOC-TECH.md](DOC-TECH.md)** — the in-browser player: the native path and the server player
  behind it, the remuxer, audio delivery, generated subtitles and diagnostics.
