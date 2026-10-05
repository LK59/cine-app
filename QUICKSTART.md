# Quick start — CineApp running in 5 minutes

All you need is Docker and the services you already run (Jellyfin, Radarr and/or Sonarr) plus a
free TMDB key. No `.env`, no cloning, no secret to invent.

| Minute | What happens |
|---|---|
| 0 – 1 | Download one file and start it |
| 1 – 2 | Pick the language, create the administrator account |
| 2 – 4 | Paste the Jellyfin, TMDB and Radarr/Sonarr addresses and keys — test each one |
| 4 – 5 | Skip or fill the extras, click **Finish** |

## 1. Start (1 minute)

```sh
mkdir cine-app && cd cine-app
curl -O https://raw.githubusercontent.com/LK59/cine-app/main/docker-compose.example.yml
docker compose -f docker-compose.example.yml up -d
```

Open `http://<server>:3000`. The first-launch assistant opens on its own.

The compose file is three lines of substance: the image, port 3000, and a named volume that holds
everything the app keeps (database, generated secrets, logs).

## 2. Have these at hand

| Service | Needed? | Where to find the key |
|---|---|---|
| **Jellyfin** | Required — it plays the films and knows the accounts | Jellyfin administration → API Keys → “+” |
| **TMDB** | Required — posters, synopses, cast, suggestions | themoviedb.org → Settings → API (free) |
| **Radarr** and/or **Sonarr** | At least one — your films and series | Settings → General → API Key |
| Jellyseerr | Optional — requests | Settings → General → API Key |
| qBittorrent | Optional — download progress | Its web-interface username and password |
| Bazarr | Optional — subtitles | Settings → General → API Key |
| Jackett | Optional — indexer status | Top of Jackett's page |
| OMDb, MDBList | Optional — IMDb / Rotten Tomatoes ratings | omdbapi.com, mdblist.com (free) |

**Addresses are seen from inside the container.** If CineApp shares a Docker network with your
services, use their container names (`http://jellyfin:8096`, `http://radarr:7878`). Otherwise use
the server's IP address (`http://192.168.1.10:8096`). `localhost` would mean the container itself.

## 3. The assistant (3–4 minutes)

1. **Hello, then language.** The interface language and the instance's default.
2. **Administrator account.** A local account for the management area — it works even when
   Jellyfin is down. Its password is stored hashed.
3. **Jellyfin**, 4. **TMDB**, 5. **Radarr / Sonarr** — paste, press **Test connection**, then
   **Next**. Each step is saved as you go.
6. **Extras** — fill what you have, skip the rest; they can be added any time later.
7. **Deployment options** — informational: the lines to add to the compose file for a time zone or
   a media folder, if you want them.
8. **Finish.** Until you click it, the assistant reopens on every visit; you can leave and come back.

Then sign in with a Jellyfin account to watch, or open **Management** with the administrator
account. Every setting stays editable in **Management → Settings → Service connections**.

## Already have a `.env`?

It keeps working. Every variable of `.env.example` is still read, and a value found in `.env` fills
its field in the interface. Changing a value in the interface overrides the `.env` one — the
interface says so — and **Back to the .env value** hands control back to the file. An installation
already configured through `.env` (Jellyfin, TMDB and Radarr or Sonarr set) skips the assistant;
`SETUP_COMPLETE=true` skips it explicitly.

## Secrets

The session secret and the push-notification keys are generated on first launch and kept in
`data/config/secrets.json` inside the volume. A value set in `.env` always wins.

## Optional additions

```yaml
services:
  cine-app:
    environment:
      - TZ=Europe/Paris                 # time zone for logs and schedules
      - MEDIA_ROOT=/mnt/media/video     # storage statistics in the management area
    volumes:
      - /path/to/media:/mnt/media/video:ro
    networks:
      - media_net                       # reach other containers by name

networks:
  media_net:
    external: true
```

Updating: `docker compose -f docker-compose.example.yml pull && docker compose -f docker-compose.example.yml up -d`.

Reverse proxy, HTTPS, resource limits and hardening: [DEPLOYMENT.md](DEPLOYMENT.md), with the
annotated `docker-compose.advanced.yml`.
