# Quick start

From an empty folder to a working cinema in about ten minutes. This page is enough on its own;
[DEPLOYMENT.md](DEPLOYMENT.md) has the details behind each step, and [ENV.md](ENV.md) every variable.

## What you need

- A Linux host with **Docker Engine and the Compose plugin** (`docker compose version` answers):
  **x86-64 (amd64)**, or **ARM64** (Raspberry Pi 4/5, Ampere…) — *experimental*, see below. Actors on
  screen (`laterna-xray`) is x86-64 only.
- A running **Jellyfin**, with an API key (*Jellyfin → Dashboard → API Keys → +*). Every viewer
  signs in with their own Jellyfin account.
- A free **TMDB** API key (*themoviedb.org → Settings → API*), for posters and synopses.
- Optionally **Radarr and/or Sonarr**, with their API key (*Settings → General → API Key*). Without
  them the cinema shows everything Jellyfin has; with them you also get management — additions,
  downloads, requests, missing episodes. **Jellyseerr** adds requests from the cinema,
  **qBittorrent** download progress, **Bazarr** subtitle search.

No repository to clone, no Node, no `.env` file: secrets are generated on first launch and every
setting is made in the browser.

### ARM64 (experimental)

Releases (`:latest`, `:stable`, `:10.65.3`…) are published for **x86-64 and ARM64** under the same
names: Docker pulls the right one by itself. The ARM image is built on an ARM machine and started for
every release, but it has not yet run long on real ARM hardware — tell us how it goes in
[Discussions](https://github.com/LK59/laterna/discussions). `:edge` (the code of the day) is x86-64
only. On a Raspberry Pi, Laterna itself is light (each viewer's device decodes the film), but Jellyfin
beside it transcodes slowly. Actors on screen (`laterna-xray`) does not run on ARM.

## 1. The compose file

Create an empty folder and save this as `docker-compose.yml` inside it. It is
[`docker-compose.example.yml`](docker-compose.example.yml), unchanged:

```yaml
# Laterna — the minimal deployment.
#
#   1. Save this file as docker-compose.yml in an empty folder.
#   2. docker compose up -d
#   3. Open http://localhost:3000 on the server (or through an SSH tunnel) — the setup assistant
#      asks for everything else, starting with the one-time setup code printed in
#      `docker compose logs laterna`.
#
# No .env is needed: secrets are generated on first launch, and every setting is made in the app.
# Each optional line below is commented, with what it is for. Guide: DEPLOYMENT.md. Variables: ENV.md.
# Installed before 10.65.2? Keep your names (cine-app, cine-app-data): a renamed volume starts from an
# empty database. Only the image: line may change to ghcr.io/lk59/laterna:latest (same image).
services:
  laterna:
    image: ghcr.io/lk59/laterna:latest    # the latest release; :10.65.1 to pin one, :edge to follow main
    container_name: laterna               # the name the commands in the guide use
    restart: unless-stopped

    # Published on the server itself only (127.0.0.1): open http://localhost:3000 there, or from
    # another machine through an SSH tunnel (ssh -L 3000:localhost:3000 <server>). Change the first
    # 3000 if it is taken ("127.0.0.1:3005:3000").
    # To serve other machines, put a reverse proxy in front and set TRUSTED_PROXIES below: on the
    # same Docker network, delete these two lines and point the proxy at http://laterna:3000;
    # outside Docker, point it at 127.0.0.1:3000. Removing "127.0.0.1:" publishes the port on every
    # interface — your whole network, or the Internet if the host is exposed: only do it knowingly.
    ports:
      - "127.0.0.1:3000:3000"

    # The Docker network your reverse proxy (and ideally Jellyfin, Radarr…) is attached to, so they
    # reach each other by container name. Uncomment here and in `networks:` at the bottom.
    # networks:
    #   - proxy

    volumes:
      # Everything the app keeps: database, settings, generated secrets, logs. The only state.
      - laterna-data:/app/data
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
  laterna-data:
    name: laterna-data                    # a fixed name, used by the backup commands in the guide

# networks:
#   proxy:
#     external: true                      # an existing network (`docker network ls`); use its real name
```

Or download it:

```bash
mkdir laterna && cd laterna
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/LK59/laterna/main/docker-compose.example.yml
```

> **Installed before 10.65.2?** Your names are `cine-app` and `cine-app-data`: keep them — renaming
> the volume would start from an empty database. Only the `image:` line may change to
> `ghcr.io/lk59/laterna:latest` (same image). In the commands below, use `cine-app` where they say
> `laterna`.

As it stands, it works: port 3000 on the server's loopback only, a named volume, UTC. What you may
change before the first start:

- **Port or proxy network.** As shipped, `http://localhost:3000` answers on the server itself only;
  from your computer, open an SSH tunnel first (`ssh -L 3000:localhost:3000 <server>`) and browse
  `http://localhost:3000`. To serve other machines, put a reverse proxy in front (step 3). If it
  runs in Docker, uncomment `networks:` (in both places) with the name `docker network ls` gives,
  and later delete `ports`: the proxy then reaches `http://laterna:3000`. Publishing the port on
  every interface (`"3000:3000"`) works too, but then anyone who can reach the host can reach the
  app: do it only on a network you trust, and knowingly.
- **Where the data lives.** The named volume `laterna-data` needs nothing. To see the files in a
  `./data` folder instead, swap the two volume lines and create the folder for the container's user
  first: `mkdir data && sudo chown 1001:1001 data`. Without the `chown`, the container stops at once.
- **Media, read-only, optional.** Only for *Management → Statistics* and the storage card. Mount the
  root Radarr and Sonarr see, with `:ro`. Playback never reads from this mount.
- **`TZ`.** Your time zone (`Europe/Paris`, `America/New_York`…), for log times and scheduled tasks.
- **Behind an HTTPS proxy.** `COOKIE_SECURE=true` and `TRUSTED_PROXIES=<proxy container>`: see step 3.
  Leave both commented while you test over plain `http://`.

## 2. Start and check

```bash
docker compose up -d
docker compose ps                    # STATUS reads "healthy" within a minute
docker compose logs -f laterna       # Ctrl-C stops following; the container keeps running
```

A good start prints a few start-up lines (secrets generated, poster cache linked) and the
version. On a new installation it also prints the **one-time setup code** the assistant asks for
(in Portainer or Dockge: the container's log view, or `docker logs laterna 2>&1 | grep "setup code"`):

```bash
docker compose logs laterna | grep "setup code"
# [setup] One-time setup code: ABCD-EFGH-JKLM — enter it in the setup assistant to create the administrator account (valid until that account exists).
```

If the container stops, its last log line says why — most often a `./data` folder that
belongs to root (`sudo chown -R 1001:1001 data`, then `docker compose up -d` again). The other cases
are listed in [DEPLOYMENT.md, step 2](DEPLOYMENT.md#2-start-the-container).

> **Run the assistant (step 4) straight away.** Creating its administrator account needs the setup
> code from the container logs, so a visitor who merely reaches the port cannot take it. The code
> is printed at every start until that account exists, then it is gone.

## 3. Behind a reverse proxy

The app speaks plain HTTP. Installing it on a phone's home screen, notifications and several player
features need HTTPS, so in practice a reverse proxy sits in front. Point your hostname at
`laterna:3000` (proxy on the same Docker network) or `127.0.0.1:3000` (proxy installed on the host,
`ports` kept), and declare the proxy in `TRUSTED_PROXIES` (below): it is then the only one believed
about visitors' addresses.

**Nginx Proxy Manager** — *Proxy Hosts → Add*: scheme `http`, host `laterna`, port `3000`; *SSL*:
a certificate, *Force SSL*. In *Advanced*:

```nginx
large_client_header_buffers 4 32k;
client_max_body_size 110m;
```

**Caddy:**

```caddyfile
laterna.example.com {
	request_body {
		max_size 110MB
	}
	reverse_proxy laterna:3000
}
```

Traefik and what any proxy must leave alone are in
[DEPLOYMENT.md, step 3](DEPLOYMENT.md#3-put-it-behind-a-reverse-proxy). Then uncomment in the compose
file, and `docker compose up -d`:

```yaml
      - COOKIE_SECURE=true
      - TRUSTED_PROXIES=nginx-proxy-manager   # your proxy's container name: caddy, traefik…
```

## 4. The setup assistant

Open the address (`http://localhost:3000` through the tunnel, or your domain): every page leads to
the assistant until it is finished. It opens on a **Welcome** screen: choosing the installation's
language (French, English, Spanish, German) moves on at once. Then seven numbered screens, *Step 1
of 7* to *Step 7 of 7*; each saves when you press **Next**, and you can leave and come back.

1. **Account** — the local administrator: the one-time setup code shown in the container logs
   (`docker logs laterna`), then a username and a password of 8 characters or more. It opens
   Management even when Jellyfin is down, but it cannot play films.
2. **Jellyfin** — address and API key. Addresses are seen **from inside the container**:
   `localhost` is the Laterna container itself. Use the container name on a shared Docker network
   (`http://jellyfin:8096`), otherwise the server's LAN address. If Jellyfin runs in another compose
   project, attach both to the same external Docker network (a `networks:` block in each), or use the
   server's LAN address if Jellyfin publishes port 8096 on it.
3. **TMDB** — the API key.
4. **Library** — Radarr and/or Sonarr: address and API key. Optional: **Next** does not need them.
5. **Extras** — all optional: Jellyseerr, qBittorrent, Bazarr, Jackett, OMDb and MDBList ratings,
   playback and default settings. Fill what you have.
6. **Deployment** — nothing to fill: the compose-file options, each with the line to copy.
7. **Finish** — a summary of what will be available and what will not (with or without Radarr,
   Sonarr, Jellyseerr, qBittorrent, Bazarr), then **Open management**, or **Sign in with Jellyfin**
   to reach the cinema.

**Next tests each service** you filled in. If a test fails, the screen stays and says why
(*Refused: the key or password is wrong*, *Unreachable: check the address from inside the
container*, *No answer within 6 seconds*). Fix it and press **Next** again, or press **Continue
anyway** and fix it later in *Configuration → Connections*.

## 5. And after

- **Viewers** sign in with their Jellyfin account; nothing to create or invite. Jellyfin
  administrators are administrators here.
- **Installation settings**: *Management → Configuration* (Connections, Playback, Generated
  subtitles, New accounts, Administrator, Deployment). From the cinema: *Account → Administration →
  Open management*; Management leads back with *Back to Cinema*.
- **People and the server**: *Account → Administration* in the cinema — account activity and logs,
  maintenance, the Lab.
- **Service status**: `/status`, readable without signing in.
- **Lost administrator password**: `docker exec -it laterna node server-boot/reset-admin-password.mjs`.

**Update:**

```bash
docker compose pull && docker compose up -d
```

Migrations run at startup; open tabs move to the new version when nothing is playing. To pin a
version, replace `latest` with a release number (`ghcr.io/lk59/laterna:10.65.1`) — the list is on
[the releases page](https://github.com/LK59/laterna/releases).

**Back up** the volume, container stopped (the image cache and the previous build's files rebuild
themselves):

```bash
docker compose stop
docker run --rm -v laterna-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/laterna-$(date +%F).tgz --exclude=./image-cache --exclude=./static-previous -C /data .
docker compose start
```

Always copy the whole volume: `cine.db-wal` holds the most recent changes. The archive is created by
root: `sudo chown $USER laterna-*.tgz` if needed. With a `./data` folder, archive that folder instead. Keep `config/secrets.json` in any copy: without
it everyone is signed out and notifications must be turned on again. Restoring is in
[DEPLOYMENT.md, step 6](DEPLOYMENT.md#6-updates-and-backups).

## Bonus: actors on screen (X-Ray)

The optional companion service `laterna-xray` recognises the cast scene by scene and ties each voice
to a face. During playback, the **On screen** row shows who is in the scene; touching someone opens
their role, « So far » (what their character has done up to now, without spoilers) and their films in
your library. It all runs on your own server, with no online AI.

It needs an **x86-64** host (there is no ARM build: its recognition runs on Intel's OpenVINO), about
4 GB of memory, the media library read-only and Laterna's Docker network. An Intel iGPU is optional and
makes it about twice as fast. In a folder of its own:

```yaml
services:
  laterna-xray:
    image: ghcr.io/lk59/laterna-xray:latest
    container_name: laterna-xray
    restart: unless-stopped
    user: "1000:1000"                 # the owner of your media files
    environment:
      - XRAY_API_KEY=change-me        # openssl rand -hex 32 — the same key in Laterna
      - HOME=/data
    networks: [proxy]                 # Laterna's Docker network
    volumes:
      - /path/to/media:/media:ro   # read-only, at the same path as in Jellyfin
      - xray_data:/data
    mem_limit: 4g
    cpu_shares: 256                   # a Jellyfin transcode goes first
    # devices: ["/dev/dri:/dev/dri"]  # Intel iGPU, optional: twice as fast
    # group_add: ["993"]              # the group of /dev/dri: getent group render

volumes:
  xray_data:

networks:
  proxy:
    external: true
```

1. `docker compose up -d`, then `docker logs -f laterna-xray` until the models are reported ready — the
   first start downloads and checks them, a few minutes, once.
2. In Laterna, **Configuration → Connections → Actors on screen**: address `http://laterna-xray:8000`
   and the same key, then *Test connection*.
3. **Configuration → Smart features → Actors on screen**: open it to administrators first, then to
   everyone. The library is analysed in the background, at low priority; progress is on that page.

Hardware acceleration, models and licences, settings and troubleshooting:
[DEPLOYMENT.md](DEPLOYMENT.md#optional-actors-on-screen-laterna-xray) and [xray/README.md](xray/README.md).

## Going further

- **[DEPLOYMENT.md](DEPLOYMENT.md)** — the full guide: each line of the compose file, the reverse
  proxy (Traefik included), actors on screen (X-Ray), every screen and setting, backups, troubleshooting, file permissions.
- **[ENV.md](ENV.md)** — every variable, its default, and which value wins.
