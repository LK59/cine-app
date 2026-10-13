# Quick start

From an empty folder to a working cinema in about ten minutes. This page is enough on its own;
[DEPLOYMENT.md](DEPLOYMENT.md) has the details behind each step, and [ENV.md](ENV.md) every variable.

## What you need

- A Linux host with **Docker Engine and the Compose plugin**: `docker compose version` answers.
- A running **Jellyfin**, with an API key (*Jellyfin → Dashboard → API Keys → +*). Every viewer
  signs in with their own Jellyfin account.
- A free **TMDB** API key (*themoviedb.org → Settings → API*), for posters and synopses.
- **Radarr and/or Sonarr**, with their API key (*Settings → General → API Key*). At least one.

No repository to clone, no Node, no `.env` file: secrets are generated on first launch and every
setting is made in the browser.

## 1. The compose file

Create an empty folder and save this as `docker-compose.yml` inside it. It is
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

Or download it:

```bash
mkdir cine-app && cd cine-app
curl -o docker-compose.yml https://raw.githubusercontent.com/LK59/cine-app/main/docker-compose.example.yml
```

As it stands, it works: port 3000 on the host, a named volume, UTC. What you may change before the
first start:

- **Port or proxy network.** Keep `ports` to open `http://<server>:3000` directly. If your reverse
  proxy runs in Docker, uncomment `networks:` (in both places) with the name `docker network ls`
  gives, and later delete `ports`: the proxy then reaches `http://cine-app:3000`.
- **Where the data lives.** The named volume `cine-data` needs nothing. To see the files in a
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
docker compose ps                    # STATUS reads "healthy" after about a minute
docker compose logs -f cine-app      # Ctrl-C stops following; the container keeps running
```

A good start prints a few `[démarrage]` lines (secrets generated, poster cache linked) and the
version. If the container stops, its last log line says why — most often a `./data` folder that
belongs to root (`sudo chown -R 1001:1001 data`, then `docker compose up -d` again). The other cases
are listed in [DEPLOYMENT.md, step 2](DEPLOYMENT.md#2-start-the-container).

> **Run the assistant (step 4) straight away.** Until its administrator account exists, anyone who
> reaches the port can create it. Keep the port on your local network until then.

## 3. Behind a reverse proxy

The app speaks plain HTTP. Installing it on a phone's home screen, notifications and several player
features need HTTPS, so in practice a reverse proxy sits in front. Point your hostname at
`cine-app:3000` (proxy on the same Docker network) or `<server-ip>:3000` (proxy outside Docker).

**Nginx Proxy Manager** — *Proxy Hosts → Add*: scheme `http`, host `cine-app`, port `3000`; *SSL*:
a certificate, *Force SSL*. In *Advanced*:

```nginx
large_client_header_buffers 4 32k;
client_max_body_size 110m;
```

**Caddy:**

```caddyfile
cine.example.com {
	request_body {
		max_size 110MB
	}
	reverse_proxy cine-app:3000
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

Open the address (`http://<server>:3000`, or your domain): every page leads to the assistant until
it is finished. Each screen saves when you press **Next**; you can leave and come back.

1. **Welcome** — the installation's language (French, English, Spanish, German).
2. **Account** — the local administrator: a username and a password of 8 characters or more. It
   opens Management even when Jellyfin is down, but it cannot play films.
3. **Jellyfin** — address and API key. Addresses are seen **from inside the container**:
   `localhost` is the container itself. Use the container name on a shared Docker network
   (`http://jellyfin:8096`), otherwise the server's LAN address.
4. **TMDB** — the API key.
5. **Library** — Radarr and/or Sonarr: address and API key.
6. **Extras** — all optional: Jellyseerr, qBittorrent, Bazarr, Jackett, OMDb and MDBList ratings,
   playback and default settings. Fill what you have.
7. **Deployment** — nothing to fill: the compose-file options, each with the line to copy.
8. **Finish** — then **Open management**, or **Sign in with Jellyfin** to reach the cinema.

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
- **Lost administrator password**: `docker exec -it cine-app node server-boot/reset-admin-password.mjs`.

**Update:**

```bash
docker compose pull && docker compose up -d
```

Migrations run at startup; open tabs move to the new version when nothing is playing. To pin a
version, replace `latest` with a commit tag (`ghcr.io/lk59/cine-app:<sha>`).

**Back up** the volume, container stopped (the image cache rebuilds itself):

```bash
docker compose stop
docker run --rm -v cine-app-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/cineapp-$(date +%F).tgz --exclude=./image-cache -C /data .
docker compose start
```

With a `./data` folder, archive that folder instead. Keep `config/secrets.json` in any copy: without
it everyone is signed out and notifications must be turned on again. Restoring is in
[DEPLOYMENT.md, step 6](DEPLOYMENT.md#6-updates-and-backups).

## Going further

- **[DEPLOYMENT.md](DEPLOYMENT.md)** — the full guide: each line of the compose file, the reverse
  proxy (Traefik included), every screen and setting, backups, troubleshooting, file permissions.
- **[ENV.md](ENV.md)** — every variable, its default, and which value wins.
