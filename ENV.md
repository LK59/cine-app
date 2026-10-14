# Configuration variables

Every variable CineApp reads, what it does, its default, and where else it can be set.

**You do not need a `.env` file.** A new installation is configured in the browser: the setup
assistant at first launch, then **Management → Configuration**. The variables below are for two
other cases:

- **a fallback** — a value the app should start with, or that you want to keep outside the
  database;
- **infrastructure as code** — the whole configuration in files you version and deploy.

Pass them through `environment:` in `docker-compose.yml`, or through an `.env` file named by
`env_file:` (see `docker-compose.advanced.yml`). `.env.example` lists them all, commented out.

## Which value wins

For a setting that can be changed in the app, the order is:

1. **the value set in the app** (stored in the database, in the data volume);
2. **otherwise the environment** (`environment:` or `.env`);
3. **otherwise the default** listed below.

A value found in the environment fills its field in the app, marked *From .env*. Changing it in the
app replaces it — the field then says *Set here* — and **Back to the .env value** removes the app's
value so the environment applies again.

A setting changed in the app applies at once, without a restart, unless its field says *Takes
effect the next time the container starts*. A change to the environment applies when the container
is recreated: `docker compose up -d`.

Leave out (or comment out) a variable you do not use. An empty line such as `PLAYER_ENABLED=` is an
empty value, not the default.

## The three kinds of variables

| Kind | Where it is set | Variables |
|---|---|---|
| **Settable in the app** | Management → Configuration, or the environment | Service addresses and keys, playback, generated subtitles, defaults for accounts, poster preparation, notification contact |
| **Deployment only** | The compose file or `.env`. Management → Configuration → Deployment shows the line to add | `TZ`, the media paths, poster sizes and languages, an administrator account fixed by `.env` |
| **Never in the app** | The compose file or `.env` only, or generated | `SESSION_SECRET`, `TRUSTED_PROXIES`, `COOKIE_SECURE`, `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` |

The last row is kept out of the app on purpose: these values decide how the container is reached
and who is believed, and a wrong one set from the interface could lock everyone out, the settings
page included.

---

## Services

Addresses are resolved **from inside the container**. On a shared Docker network, use container
names (`http://jellyfin:8096`); otherwise the server's LAN address (`http://192.168.1.10:8096`).
`localhost` means the container itself. A service without a key is simply not used.

Set in the app: **Management → Configuration → Connections**, each with a **Test connection**
button. Only Jellyfin and TMDB are required; the setup assistant also offers Radarr and Sonarr,
which are optional — without them, the cinema shows everything Jellyfin has, and the management
features that depend on them (downloads, requests, missing episodes) are simply absent.

| Variable | Default | Role |
|---|---|---|
| `JELLYFIN_URL` | `http://jellyfin:8096` | Jellyfin's address. **Required.** Accounts, playback, resume points. |
| `JELLYFIN_API_KEY` | — | Jellyfin → Administration → API Keys → **+**. **Required.** |
| `JELLYFIN_PUBLIC_URL` | — | The address people use for Jellyfin, for the *Open in Jellyfin* links. Example: `https://jellyfin.example.com`. |
| `TMDB_API_KEY` | — | Free key from themoviedb.org → Settings → API. **Required**: posters, synopses, cast, suggestions. |
| `RADARR_URL` | `http://radarr:7878` | Radarr's address. Optional: movie management (additions, downloads, quality). |
| `RADARR_API_KEY` | — | Radarr → Settings → General → API Key. |
| `RADARR_QUALITY_PROFILE` | first profile Radarr lists | Quality profile given to films added from the app (its numeric ID). Easier to pick from the list in the app. |
| `SONARR_URL` | `http://sonarr:8989` | Sonarr's address. Optional: series management (additions, downloads, missing episodes). |
| `SONARR_API_KEY` | — | Sonarr → Settings → General → API Key. |
| `SONARR_QUALITY_PROFILE` | first profile Sonarr lists | Same as above, for series. |
| `JELLYSEERR_URL` | `http://jellyseerr:5055` | Requests. Without a key, the request buttons do not appear. |
| `JELLYSEERR_API_KEY` | — | Jellyseerr → Settings → General → API Key. |
| `QBITTORRENT_URL` | — | Download progress, e.g. `http://qbittorrent:8080`. When qBittorrent shares a VPN container's network, use that container's address. Without an address and a password, qBittorrent is never contacted. |
| `QBITTORRENT_USERNAME` | `admin` | qBittorrent web interface user. |
| `QBITTORRENT_PASSWORD` | — | qBittorrent web interface password. |
| `BAZARR_URL` | `http://bazarr:6767` | Subtitle search and management in Management. |
| `BAZARR_API_KEY` | — | Bazarr → Settings → General → API Key. |
| `JACKETT_URL` | `http://jackett:9117` | Indexer status in Management. |
| `JACKETT_API_KEY` | — | At the top of Jackett's page. |
| `OMDB_API_KEY` | — | IMDb ratings on cards. Free key at omdbapi.com (1,000 requests a day). |
| `MDBLIST_API_KEY` | — | IMDb, Rotten Tomatoes, Metacritic, Letterboxd and Trakt ratings on title pages. Free key at mdblist.com. |

## Playback

Set in the app: **Management → Configuration → Playback**. Applied without a restart.

| Variable | Default | Role |
|---|---|---|
| `PLAYER_ENABLED` | `true` | Films play inside CineApp. The browser reads the file and plays it natively: the server only serves bytes. `false` removes in-app playback; the *Open in Jellyfin* links remain. |
| `PLAYER_SERVER_FALLBACK` | `true` | A file the browser cannot play is handed to Jellyfin, which converts it if it must. `false` guarantees no playback ever starts a transcode: such files show a playback error, and casting and the lighter version for slow connections are not offered. |
| `PLAYER_AUTO_FRAME` | `true` | Enlarges the picture over black bars baked into the file. Needs Jellyfin's trickplay images; without them the picture is shown as it is. |
| `CHROMECAST_FOR_EVERYONE` | `true` | `true`: every account sees the Chromecast button. `false`: administrators only. |
| `CAST_RECEIVER_APP_ID` | Google's Default Media Receiver | The receiver application a Chromecast opens: eight hexadecimal characters, from the Google Cast developer console. Any other value falls back to the default. |

## Generated subtitles

Translates an existing full text subtitle of a title into another language, during playback, with
an online AI. Without a key the feature does not appear anywhere. The key stays on the server.

Set in the app: **Management → Configuration → Generated subtitles**, which also shows the month's
spending and the jobs.

| Variable | Default | Role |
|---|---|---|
| `SUBTITLE_GEN_API_KEY` | — | The provider's API key. |
| `SUBTITLE_GEN_PROVIDER` | `anthropic` | `anthropic`, `openai` or `google`. |
| `SUBTITLE_GEN_MODEL` | the provider's default model | Model name. |
| `SUBTITLE_GEN_BUDGET_USD` | `5` | Monthly ceiling for all accounts together, in US dollars. Once reached, jobs pause until next month or a higher budget. |
| `SUBTITLE_GEN_PRICE_INPUT` | the app's price table | Price per million input tokens, in US dollars. Required for a model the table does not know. |
| `SUBTITLE_GEN_PRICE_OUTPUT` | the app's price table | Price per million output tokens. |
| `SUBTITLE_GEN_ENABLED` | `true` | `false` turns the feature off while keeping the key. |

## Dialogue search

Finds a film by a line spoken in it: the films' text subtitles are read from disk into a separate,
rebuildable index (`data/repliques.db`), and the cinema search shows a *Lines* section under the
titles. **Off by default.** It can only be turned on when the films folder is mounted and readable
inside the container — `MEDIA_ROOT` / `MOVIES_PATH` below, the same folder Radarr calls its root
folder for films; the page says why when it is greyed out.

Set in the app: **Management → Configuration → Dialogue search**, which also starts the initial
indexing, shows its progress, and rebuilds the index.

| Variable | Default | Role |
|---|---|---|
| `REPLIQUES_ENABLED` | `false` | Turns the feature on. Refused while the films folder is not readable. |
| `REPLIQUES_NIGHTLY` | `true` | Once a night, reads only new or changed films and removes those that are gone. Starts only after the initial indexing has finished. |
| `REPLIQUES_NIGHT_START` | `2` | Start of the night window, hour 0–23, in the container's time zone (`TZ`). |
| `REPLIQUES_NIGHT_END` | `6` | End of the night window. A window across midnight (22 → 6) works. |
| `REPLIQUES_LANGUAGES` | `fr,original` | Languages indexed, comma-separated two-letter codes; `original` is each film's original language (from Radarr). |

## Defaults for accounts

What an account gets until it chooses otherwise in **Account**. Set in the app: **Management →
Configuration → New accounts**.

| Variable | Default | Role |
|---|---|---|
| `APP_LANGUAGE` | `en` | `fr`, `en`, `es` or `de`. The sign-in page and every account without a language of its own. The setup assistant's first screen sets it. |
| `HOME_CONTINUE_HERO` | `false` | The home banner shows what the account is watching first, completed by the latest additions. |
| `NEW_ACCOUNT_BLOCKED_TAGS` | — | Jellyfin tags blocked automatically on each account created after the first start, comma-separated. Existing accounts and administrators are never changed. Blocked tags hide titles in CineApp as in Jellyfin. |

## Application

Set in the app: **Management → Configuration → Connections**, card *Application*.

| Variable | Default | Role |
|---|---|---|
| `POSTER_PREWARM` | `true` | Prepares the catalogue's posters in the background, so they do not appear one by one the first time. **Read at startup**: a change applies at the next start. |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact sent with push notifications: a `mailto:` or an `https://` address you control. Apple refuses anything else. |

---

## Deployment only

Read when the container starts: not settable in the app. **Management → Configuration →
Deployment** shows each one with the line to copy. Recreate the container after a change.

| Variable | Default | Role |
|---|---|---|
| `TZ` | the container's (UTC) | Time zone for logs and scheduled tasks, e.g. `Europe/Paris`. Times shown in the app follow each viewer's device. |
| `MEDIA_ROOT` | `/mnt/media/video` | Where the media folder is mounted **inside the container**, read-only. Used by Management → Statistics, the storage card, and dialogue search. |
| `MOVIES_PATH` | `$MEDIA_ROOT/movies` | Films folder, inside the container — the container's view of Radarr's root folder for films. Only if your layout differs. Dialogue search reads each film at `MOVIES_PATH/<film folder>/<file>` as Radarr names them, never seeds or downloads. |
| `TV_PATH` | `$MEDIA_ROOT/tv` | Series folder. |
| `SEEDS_PATH` | `$MEDIA_ROOT/downloads/seeds` | Downloads kept for seeding. |
| `SEED_MOVIES_PATH` | `$SEEDS_PATH/movies` | Seeding films. |
| `SEED_TV_PATH` | `$SEEDS_PATH/tv` | Seeding series. |
| `CROSS_SEED_PATH` | `$SEEDS_PATH/cross-seed-links` | Cross-seed links. |
| `POSTER_PREWARM_WIDTHS` | `384,750` | Poster widths prepared in advance, in pixels. |
| `POSTER_PREWARM_LOCALES` | `fr` plus `APP_LANGUAGE` from the environment | Poster languages prepared in advance (a poster depends on the viewer's language). |
| `APP_ADMIN_USER` | `admin` | Administrator account fixed by the deployment. Only used with `APP_ADMIN_PASSWORD`. |
| `APP_ADMIN_PASSWORD` | — | Its password. When set, this account replaces the one created by the setup assistant. The old example value `change-me` stops the startup. |
| `SETUP_COMPLETE` | — | `true` skips the setup assistant. An installation whose environment already sets Jellyfin and TMDB skips it on its own. |

The local administrator account works even when Jellyfin is down, and opens Management. Most
installations use the one the assistant creates (its password is stored hashed and changed in
**Management → Configuration → Administrator**). Fixing it in `.env` is for deployments managed
as code.

## Never in the app

| Variable | Default | Role |
|---|---|---|
| `SESSION_SECRET` | generated on first launch | Signs and encrypts sessions. When empty, one is generated and kept in `data/config/secrets.json`. A value set here wins; it must be at least 16 characters and not a published example, or the server refuses to start. Changing it signs everyone out. Generate one with `openssl rand -hex 32`. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated on first launch | The push notification key pair, kept in `data/config/secrets.json`. Set both or neither. Changing them means every device turns notifications on again. |
| `COOKIE_SECURE` | `false` | `true` when the app is served over HTTPS: session cookies are then sent over HTTPS only. Never `true` while testing over `http://`, or no sign-in works. |
| `TRUSTED_PROXIES` | — | The reverse proxy allowed to give visitors' addresses (`X-Forwarded-For`): a container name (resolved every five minutes), an address or an IPv4 network, comma-separated. Sign-in limits and logs are keyed by address. Empty: the last `X-Forwarded-For` entry is used, which another container on the same network could forge. |

Keep `data/config/secrets.json` in your backups: without it every session ends and notifications
must be turned on again.

## Development only

| Variable | Default | Role |
|---|---|---|
| `DEV_BIND` | `127.0.0.1` | `docker-compose.dev.yml` only: the address the development port 3001 is published on. `0.0.0.0` opens it to the network — on a private LAN only. |

The image itself sets `PORT=3000`, `HOSTNAME=0.0.0.0` and `NODE_ENV=production`; there is no
reason to change them. The data folder is always `/app/data` inside the container.
