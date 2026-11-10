# Configuration variables

Every variable Laterna reads, what it does, its default, and where else it can be set.

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
| **Settable in the app** | Management → Configuration, or the environment | Service addresses and keys, playback, casting and offline, books, the AI provider and the smart features, defaults for accounts, poster preparation, notification contact |
| **Deployment only** | The compose file or `.env`. Management → Configuration → Deployment shows the line to add | `TZ`, the media paths, poster sizes and languages, an administrator account fixed by `.env` |
| **Never in the app** | The compose file or `.env` only, or generated | `SESSION_SECRET`, `TRUSTED_PROXIES`, `COOKIE_SECURE`, `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` |

The last row is kept out of the app on purpose: these values decide how the container is reached
and who is believed, and a wrong one set from the interface could lock everyone out, the settings
page included.

## Where each setting lives in the app

One place per feature: a setting appears on one page only, and a feature that needs something else
(an AI key, the actors-on-screen service) says so on its card, greyed out, with a link to what is
missing.

| Management → Configuration → | Variables |
|---|---|
| **Connections** | Every service's address and key (Jellyfin, TMDB, Radarr, Sonarr, Jellyseerr, qBittorrent, Bazarr, Jackett, OMDb, MDBList), the actors-on-screen service (`XRAY_URL`, `XRAY_API_KEY`), `POSTER_PREWARM`, `VAPID_SUBJECT` |
| **Playback** | `PLAYER_ENABLED`, `PLAYER_SERVER_FALLBACK` |
| **Casting and offline** | `CHROMECAST_FOR_EVERYONE`, `CAST_RECEIVER_APP_ID`, `OFFLINE_DOWNLOADS`, `OFFLINE_DOWNLOADS_FOR_EVERYONE`, `OFFLINE_SERVER_QUOTA_GB` |
| **Books** | `BOOKS_ENABLED`, `BOOKS_REQUESTS_ENABLED`, `BOOKS_GOOGLE_ENRICH`, `GOOGLE_BOOKS_API_KEY` |
| **Smart features → Artificial intelligence** | The shared AI provider (`SUBTITLE_GEN_PROVIDER`, `_API_KEY`, `_MODEL`, `_BUDGET_USD`, `_PRICE_INPUT`, `_PRICE_OUTPUT`), then each feature using it: `SUBTITLE_GEN_ENABLED`, `DESCRIBE_SEARCH_ENABLED`, `RECAP_ENABLED`, `ASK_ENABLED`, `ASK_PERSON_ENABLED`, `SOFAR_ENABLED` |
| **Smart features → Actors on screen** | `XRAY_ENABLED`, the library analysis and the quality of the names |
| **Smart features → Subtitle sync** | Nothing to set: measured on request (needs actors on screen) |
| **Smart features → Dialogue search** | `REPLIQUES_*` |
| **Smart features → Automatic reframing** | `PLAYER_AUTO_FRAME` |
| **New accounts** | `APP_LANGUAGE`, `HOME_CONTINUE_HERO`, `NEW_ACCOUNT_BLOCKED_TAGS` |
| **Deployment** | Shows the deployment-only variables below, with the line to add |

The variables keep their names whatever page shows them: the `SUBTITLE_GEN_*` keys date from when
generated subtitles were the only AI feature, and now configure the provider all of them share.
The AI page's old address, `/parametres/sous-titres`, redirects to `/parametres/ia`.

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

## Actors on screen

An optional companion service, `laterna-xray`, recognises the actors in the picture scene by scene,
and who is speaking (its installation, contract and measurements: `xray/README.md`). **Off by
default.** When on, each playback asks it to analyse the title being watched, from the current
position, then the next episode of a series; a background scheduler works through the rest of the
library in the background (Management → Configuration → Smart features → *Actors on screen*: progress, pause,
a priority list, the quality of the names per series). The cast of that episode or film and several
photos per person come from TMDB.

Viewers see an *On screen* row with the player's controls (in play and in pause): the people
recognised in the current scene, each opening a panel with the actor's TMDB facts, a short
biography and their other titles in the library. The AI features built on it (« So far », the
questions about a person) have their own settings, under *AI features* below. Share links see the
row and the panel without the library titles, and never any AI feature.

Set in the app in two places, one per kind of setting: the service's address and key in
**Management → Configuration → Connections**, *Actors on screen* card, whose *Test the connection*
button shows the service's model, whether it is ready, and hardware decoding; who the feature is on
for (`XRAY_ENABLED`) in **Smart features → Actors on screen**, above the library analysis.

| Variable | Default | Role |
|---|---|---|
| `XRAY_ENABLED` | `off` | Who the analysis is on for: `off`, `admins` (analyses ordered only from administrators' playback, the player reads `off` for everyone else) or `tous` (everyone). `true` and `false` from before still read as `tous` and `off`. Without an address and a key, nothing is sent. Free: it runs on your own server, no AI provider is called. The person panel's TMDB facts (biography, the person's titles in the library) are part of it. Its questions and « So far » are separate settings (`ASK_PERSON_ENABLED`, `SOFAR_ENABLED`, below). Deployment guide: `xray/README.md`. |
| `XRAY_URL` | `http://laterna-xray:8000` | The service's address, from inside the container (same Docker network). |
| `XRAY_API_KEY` | — | The key the service was started with (its own `XRAY_API_KEY`), sent as `Authorization: Bearer`. |
| `SCENE_RESTART_ENABLED` | `off` | Who sees « Back to the start of the scene »: `off`, `admins` or `tous`. When a title is resumed after four hours or more, a button offers for eight seconds to go back to the start of the current scene — only where the analysis found a real scene start (an authored chapter, or both the colours and the people changing, not in the middle of a line of dialogue) 20 s to 3 min back. Also needs `XRAY_ENABLED`. Off, nothing is shown, but the decision is still made where the scenes are already read, and the session summary in the player log says what it would have offered (`sceneRestart`) — measure before turning it on. |
| `XRAY_LIBRARY_ROOTS` | `/media/movies,/media/tv` | `.env` only. The folders, as Jellyfin sees them, whose files may be analysed — comma-separated. Anything else (downloads, seeds, books, a neighbour such as `/media/movies-seeds`) is never ordered, even if Jellyfin lists it. Changing it re-checks the items skipped as outside. |
| `XRAY_SCAN_DURING_PLAYBACK` | `true` | `.env` only. Whether the library scan keeps feeding the analysis service while someone is watching. On by default: the analysis only competes with a server-side transcode, and the service already steps aside (it yields the integrated GPU, its orders are `low`, and the example compose gives its container fewer CPU shares than Jellyfin). `false` makes the scan wait for the end of every playback, except the priority list and a tier started by hand — for a server too small to do both. |

## Playback

Set in the app: **Management → Configuration → Playback**. Applied without a restart.

| Variable | Default | Role |
|---|---|---|
| `PLAYER_ENABLED` | `true` | Films play inside Laterna. The browser reads the file and plays it natively: the server only serves bytes. `false` removes in-app playback; the *Open in Jellyfin* links remain. |
| `PLAYER_SERVER_FALLBACK` | `true` | A file the browser cannot play is handed to Jellyfin, which converts it if it must. `false` guarantees no playback ever starts a transcode: such files show a playback error, and casting and the lighter version for slow connections are not offered. |

## Casting and offline

Set in the app: **Management → Configuration → Casting and offline**. Applied without a restart.

| Variable | Default | Role |
|---|---|---|
| `CHROMECAST_FOR_EVERYONE` | `true` | `true`: every account sees the Chromecast button. `false`: administrators only. |
| `CAST_RECEIVER_APP_ID` | Google's Default Media Receiver | The receiver application a Chromecast opens: eight hexadecimal characters, from the Google Cast developer console. Any other value falls back to the default. |
| `OFFLINE_DOWNLOADS` | `true` | Downloads for offline viewing (beta): Jellyfin prepares a lighter version that the device keeps. `false` removes the button and refuses any preparation. See [docs/telechargement-hors-ligne.md](docs/telechargement-hors-ligne.md). |
| `OFFLINE_DOWNLOADS_FOR_EVERYONE` | `true` | `true`: every account can download for offline viewing. `false`: administrators only. |
| `OFFLINE_SERVER_QUOTA_GB` | `50` | Room, in GB, the prepared copies may take in `data/offline/`. Past it, copies every device has fully fetched are deleted, oldest first; copies still being prepared or downloaded are never deleted, so the total can exceed it for a while. |

## Books

Optional, off by default: a grid of the EPUB files in Jellyfin's libraries and an in-app reader
(see the README). Turned off, every books route answers « not found » and no books code loads.

Set in the app: **Management → Configuration → Books**. The requests and Google Books cards say they
do nothing while books are off.

| Variable | Default | Role |
|---|---|---|
| `BOOKS_ENABLED` | `false` | Turns books on for the installation. |
| `BOOKS_REQUESTS_ENABLED` | `false` | « Request a book »: a request to the administrator, who adds the book by hand. No effect while `BOOKS_ENABLED` is off. |
| `BOOKS_GOOGLE_ENRICH` | `false` | Fills in what a book is missing from Google Books — summary, cover, genres, year —, never what Jellyfin or the EPUB already say. Needs `BOOKS_ENABLED` and a key. |
| `GOOGLE_BOOKS_API_KEY` | — | Google Books API key, sent in the `X-Goog-Api-Key` header. |

## Automatic reframing

Set in the app: **Management → Configuration → Smart features → Automatic reframing**.

| Variable | Default | Role |
|---|---|---|
| `PLAYER_AUTO_FRAME` | `true` | Enlarges the picture over black bars baked into the file. Needs the built-in player (`PLAYER_ENABLED`) and Jellyfin's trickplay images; without them the picture is shown as it is. |

## AI features

One online AI provider, one key and one monthly ceiling serve every paid feature: generated
subtitles (an existing full text subtitle translated into another language during playback),
search by description, « Previously », questions and « So far ». Without a key none of them appears
anywhere. The key stays on the server.

Set in the app: **Management → Configuration → Smart features → Artificial intelligence**: the
shared provider first (with the month's spending for all paid features and what each feature does
with each provider), then one card per feature with who it is on for, what it needs (an AI key; the
actors-on-screen service for the last two) and its state, the subtitle jobs under their card.

| Variable | Default | Role |
|---|---|---|
| `SUBTITLE_GEN_API_KEY` | — | The provider's API key. Since 09/11/2026 it serves every paid AI feature below, whichever the provider. |
| `SUBTITLE_GEN_PROVIDER` | `anthropic` | `anthropic`, `openai` or `google`. Every paid feature works with all three; the configuration page lists, per feature, what differs (streamed or whole answers, explicit or automatic caching, reasoning settings). Only Anthropic (Claude Haiku 5.5) has been measured on a test bench; with another provider the quality of the answers is the administrator's responsibility. |
| `SUBTITLE_GEN_MODEL` | the provider's default model | Model for generated subtitles (the page offers the priced models of the provider, or any other name). The other features always use the provider's fast model: `claude-haiku-5-5`, `gpt-6-luna`, `gemini-3.8-flash`. |
| `SUBTITLE_GEN_BUDGET_USD` | `5` | Monthly ceiling (calendar month, UTC) for **all paid AI features** together — generated subtitles, search by description, « Previously », questions, « So far » — and all accounts, in US dollars, computed from each call's actual tokens (input, cache writes, cache reads, output) at the model's price. Until 09/11/2026 it covered generated subtitles only. Once reached: subtitle jobs pause, search by description and « Previously » stop (texts already prepared stay readable), a question gets « the monthly limit has been reached », « So far » stays silent — until next month or a higher ceiling. A line goes to `docker logs` the first time it is crossed in a month. |
| `SUBTITLE_GEN_PRICE_INPUT` | the app's price table | Price per million input tokens, in US dollars. Required for a model the table does not know. |
| `SUBTITLE_GEN_PRICE_OUTPUT` | the app's price table | Price per million output tokens. |
| `SUBTITLE_GEN_ENABLED` | `true` | `false` turns the feature off while keeping the key. |
| `DESCRIBE_SEARCH_ENABLED` | `false` | Search by description: a sentence describing a film or series (« the film where a man relives the same day ») finds it, in the library or not. Uses the provider and key above. Each new sentence is one request, well under a tenth of a cent with Claude Haiku; counted in the monthly ceiling. |
| `RECAP_ENABLED` | `false` | « Previously »: on the page of a series in progress, a short recap of the latest events the account watched — from the official episode summaries and the subtitles of the last ten minutes watched, never beyond — prepared in the background for every account that uses the app, three hours after it stops watching the series (before that, the page keeps the synopsis). A single finished episode shows its official summary as is. Each account can turn it off (Account → Interface). Uses the provider and key above, about a tenth of a cent per text with Claude Haiku; counted in the monthly ceiling. |
| `ASK_ENABLED` | `off` | Who « Ask a question » about a **title** is on for: `off`, `admins` (administrators only — the route answers « off » to everyone else) or `tous` (every household account; share links never get any AI feature). The feature: a round button at the end of the player's *On screen* row (with the controls, in play or in pause), or on a film or series page; a short answer, streamed word by word, to a question about the title — built only from what the account has already watched (the synopsis and cast, the summaries of finished episodes, the subtitles up to the current position, named by speaker once the voice analysis of that file is complete), never beyond. An answer naming anything the sources do not contain is withheld. 60 questions an hour and 300 a day per account; one line per question in `recherche.log`, never its text. Not offered on Fire TV. Uses the provider and key above (streamed with Anthropic, shown all at once with OpenAI and Google); counted in the monthly ceiling. |
| `ASK_PERSON_ENABLED` | *(empty: same as `ASK_ENABLED`)* | Who the suggested questions in the panel of an « On screen » actor are on for: `off`, `admins`, `tous`. The panel has no free input: it offers at most two « How is X connected to Y? » with the other characters of the scene. Also needs `XRAY_ENABLED`. Left empty, it follows `ASK_ENABLED`, which used to cover them — an installation set before keeps exactly what it had. |
| `SOFAR_ENABLED` | *(empty: same as `ASK_ENABLED`)* | Who « So far » is on for — one or two sentences at the top of an actor's panel, starting with the character's name, on the latest thing that concerns them in what the account has watched: `off`, `admins`, `tous`. Written on demand when the panel opens (on a computer, also when the pointer rests 300 ms on the person), cut at the start of the current scene, then kept 30 days under a fingerprint of exactly what was sent — so two accounts at the same place read the same text, and a text already written costs nothing. 200 texts an hour per account. Also needs `XRAY_ENABLED`. Left empty, it follows `ASK_ENABLED`. |

## Dialogue search

Finds a film by a line spoken in it: the films' text subtitles are read from disk into a separate,
rebuildable index (`data/repliques.db`), and the cinema search shows a *Lines* section under the
titles. **Off by default.** It can only be turned on when the films folder is mounted and readable
inside the container — `MEDIA_ROOT` / `MOVIES_PATH` below, the same folder Radarr calls its root
folder for films; the page says why when it is greyed out.

Set in the app: **Management → Configuration → Smart features → Dialogue search**, which also starts the initial
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
| `NEW_ACCOUNT_BLOCKED_TAGS` | — | Jellyfin tags blocked automatically on each account created after the first start, comma-separated. Existing accounts and administrators are never changed. Blocked tags hide titles in Laterna as in Jellyfin. |

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
| `TRUSTED_PROXIES` | — | The reverse proxy allowed to give visitors' addresses (`X-Forwarded-For`): a container name (resolved every five minutes), an address or an IPv4 network, comma-separated. Sign-in limits and logs are keyed by address. Empty: the last `X-Forwarded-For` entry is believed only from a loopback or private connection (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local, `::1`, `fc00::/7`) — which another container on the same network could still forge; a client connecting from a public address is keyed by that address, whatever header it sends. |

Keep `data/config/secrets.json` in your backups: without it every session ends and notifications
must be turned on again.

## Development only

| Variable | Default | Role |
|---|---|---|
| `DEV_BIND` | `127.0.0.1` | `docker-compose.dev.yml` only: the address the development port 3001 is published on. `0.0.0.0` opens it to the network — on a private LAN only. |

The image itself sets `PORT=3000`, `HOSTNAME=0.0.0.0` and `NODE_ENV=production`; there is no
reason to change them. The data folder is always `/app/data` inside the container.
