# Cine App

Self-hosted PWA that turns a Radarr / Sonarr / Bazarr / Jackett / qBittorrent / Jellyfin /
Jellyseerr stack into **two interfaces on one container**: a Netflix-style front end everyone in
the household uses, and a management dashboard for whoever runs the box.

> ### 📦 [**Deployment guide → DEPLOYMENT.md**](DEPLOYMENT.md)
>
> Step-by-step installation from the published Docker image: prerequisites, API keys, `.env`,
> compose file, reverse proxy, first login, updates, backups and troubleshooting. No source
> checkout, no build toolchain — one container and two configuration files.

## The two interfaces

| | Address | Who it is for |
|---|---|---|
| **[Cinema](#the-cinema-interface)** | `/` | Everyone. Rows of posters, a full-bleed hero, search, personal lists, requests, and in-browser playback. This is the front door. |
| **[Management](#the-management-interface)** | `/gestion` | The administrator. Radarr, Sonarr, Bazarr, Jackett, qBittorrent, Jellyfin, Jellyseerr, statistics, settings — the whole stack. |

Both run from the same container, the same session and the same set of API routes. There are only
ever **two roles**: `admin` and `user`. A `user` can browse, play, keep lists and request titles;
every write to the underlying services is refused server-side in `src/proxy.ts`, whatever the
interface happens to show. The management screens are reachable from Cinema through the rail's
bottom entry, which only an administrator sees.

`/player` and `/cinema` are the addresses Cinema had before it became the root; both answer `308`
to `/`, so old links, open tabs and already-installed home-screen shortcuts keep working.

## Contents

- [The Cinema interface](#the-cinema-interface)
- [The Management interface](#the-management-interface)
- [Optional services](#optional-services)
- [Deployment](#deployment)
- [Authentication and roles](#authentication-and-roles)
- [Security](#security)
- [Development](#development)
- [Documentation map](#documentation-map)

---

# The Cinema interface

`/` — the screen every account lands on. It is built around one idea: a library is not a file
manager. Nothing here names a service, a container or a download client; a title is a poster, and
everything you can do with it hangs off that poster.

<!-- CAPTURE : cinema-home-desktop.png
     THE hero shot of the project — put the most representative one here.
     Cinema home, desktop, 1920×1080, a full-bleed backdrop at the top with its title logo, and
     the first two rows of posters visible underneath. Pick a title whose artwork is striking and
     whose backdrop is dark enough for the gradient to read.
     Then uncomment:
<img src="docs/screenshots/cinema-home-desktop.png" width="100%">
-->

## Getting around

Four entries, and that is a ceiling rather than an accident: past four, a navigation rail stops
being a landmark and becomes a list you have to read. Everything else — sheets, episodes, people —
opens from the content itself.

| | | |
|---|---|---|
| **Home** | The rows | Pressing it again from anywhere closes what covers it and comes back |
| **Search** | One field for the library, TMDB and people | Pressing it while already there is the intent to type |
| **My list** | To watch · Requests · Watched | |
| **Account** | Language, playback preferences, notifications, devices | |
| *Management* | `/gestion` | Administrators only; leaves Cinema rather than opening a panel |

On desktop it is a vertical rail on the left, collapsed to icons and expanding on hover. On a
phone it is a bottom bar with the same four entries. One list describes both, so they cannot
drift apart.

**Every screen is in the address.** Which sheet is open, which tab, which panel — all of it lives
in the URL hash, so the browser's Back button and the phone's edge-swipe step back through the
screens instead of leaving Cinema entirely, and a sheet stays drawn underneath the one above it.
A film's page can be shared, bookmarked and reopened.

<!-- CAPTURE : cinema-rail-expanded.png
     The left rail hovered so the labels are visible, over a blurred home screen.
     Crop to the left third of the screen, portrait-ish.
     Then uncomment:
<img src="docs/screenshots/cinema-rail-expanded.png" height="320">
-->

## The home screen

A **Movies / Series** toggle switches the whole screen; each tab is composed the same way, top to
bottom:

| Row | What it is |
|---|---|
| **Spotlight** | A full-bleed hero over a rotating carousel of picks, with the TMDB title logo when there is one, a muted backdrop trailer, and segmented progress bars to jump back to a previous pick. Moving focus over any card takes the hero over. |
| **Continue watching** | Jellyfin resume progress, per user, with the time left and the episode it stopped on. |
| **Top 10 in your library** | Ranked by the IMDb rating the app already caches — no extra integration. |
| **Recently added** | What Radarr and Sonarr actually landed, with a **New** badge for the last 30 days. |
| **My list** | What you saved, with a link through to the full list. |
| **One row per genre** | Alphabetical, each with a *see all* that opens the genre as a full grid. |
| **Recommended for you / Trending** | TMDB rows of titles that are **not** in the library — a card here opens a request, not a player. |
| **Browse everything** | The end of the rows: the whole library as one sortable, filterable grid. For someone who has scrolled past everything and found nothing. |

A row with nothing in it hides itself rather than showing an empty shelf.

<!-- CAPTURE : cinema-rows.png
     Mid-scroll on the home screen: three or four complete rows stacked, including the Top 10
     with its ranked numerals and a "New" badge visible on a recently-added card.
     Desktop, full width.
     Then uncomment:
<img src="docs/screenshots/cinema-rows.png" width="100%">
-->

## A title's page

Selecting a poster opens a sheet over the rows — it covers them, it does not replace them, and
closing it animates back to exactly the row you left.

- **Films** — backdrop, logo, synopsis, cast carousel, ratings, and the actions: play or resume,
  trailer, my list, mark watched, favourite. The play button knows the resume position before you
  press it, so it says *Resume* or *Start from the beginning* rather than guessing.
- **Series** — the same, plus a season and episode browser with per-episode progress, thumbnails,
  next-up, and what is still missing from a season.
- **A title not in the library** — reached from a Discover row or from search, identified by its
  TMDB id. Same layout, different verb: **Request**.
- **A person** — filmography, how much of it is here, photos. Opens from any cast carousel.

Sheets stack: a person opened from a film's cast sits above the film, and closing it puts the film
back rather than dropping you home.

<!-- CAPTURE : cinema-movie-sheet.png
     A film's sheet open over the home screen, showing the backdrop, the logo, the action row
     and the beginning of the cast carousel.
     Desktop, full width. Prefer a title with a good logo and a real cast list.
     Then uncomment:
<img src="docs/screenshots/cinema-movie-sheet.png" width="100%">
-->

<!-- CAPTURE : cinema-series-episodes.png
     A series' episode browser: the season selector, episode thumbnails, a part-watched episode
     with its progress bar, and the "up next" marker.
     Desktop, full width.
     Then uncomment:
<img src="docs/screenshots/cinema-series-episodes.png" width="100%">
-->

## Search

One field, and it does not ask you to pick a category first: it searches the library, TMDB and
people at once, and separates the answers afterwards. A title already here plays; a title that is
not can be requested from the same result card. Recent searches are kept and can be cleared.

Natural-language queries work — `film de guerre de Christopher Nolan`, `série avec Clara Galle`,
`comédie avec Ryan Gosling`.

<!-- CAPTURE : cinema-search.png
     The search panel with a query typed, showing the All / Movies / Series / People filters and
     a mix of results: something available, something not in the library yet.
     Desktop, full width.
     Then uncomment:
<img src="docs/screenshots/cinema-search.png" width="100%">
-->

## My list

Three segments, and each one is stored where its truth already lives rather than being copied:

| Segment | Where it comes from |
|---|---|
| **To watch** | This app's own SQLite — it is the only place that knows |
| **Requests** | The live view of your own Jellyseerr requests: not released yet, on the way, available, didn't work out. A badge counts the ones that have arrived since you last looked, and a request can be cancelled from here |
| **Watched** | Jellyfin's play state, filled in as you watch — correctable from a title's own page |

Searchable and sortable by date added, title or year. "Watched" is never a second copy of
something Jellyfin already knows: a film finished on the TV reads as watched here, immediately.

<!-- CAPTURE : cinema-mylist.png
     "My list" open on the Requests segment, showing several states at once (on the way,
     available, not released yet) and the "arrived" badge if you can stage one.
     Desktop, full width.
     Then uncomment:
<img src="docs/screenshots/cinema-mylist.png" width="100%">
-->

## Account

Interface language (French, English, Spanish, German), preferred audio and subtitle languages,
subtitle display mode, notifications, password, and the list of signed-in devices with a
one-press sign-out for the others.

The playback preferences are **Jellyfin's own**, not a local copy: setting a preferred audio
language here applies in the Jellyfin apps too.

## Playing something

Playback happens in the page, over the rows, and can be shrunk into a **draggable mini-player**
that keeps playing while you browse. The player carries resume, audio and subtitle track
selection with size and manual offset, chapters, playback speed, trickplay scrubbing previews,
skip-intro and automatic next-episode advance, AirPlay and Chromecast.

There are two playback paths, and the difference is what the server has to do:

- **The standard player** negotiates DirectPlay / DirectStream / Transcode the way Jellyfin's own
  web client does. A "Playback info" panel says which of the three is running, why, and at what
  bitrate. Off by default (`PLAYER_ENABLED`), because a transcode is real CPU on your server.
- **The native player** (opt-in) asks the server for nothing beyond the file itself. The browser
  fetches the `.mkv` by byte ranges, repackages it into fragmented MP4 in the tab, and hands it to
  a real `<video>` — hardware decoding, native HDR, no transcoding at all. On this library it
  plays 4K Dolby Vision HEVC with E-AC3 Atmos on an iPhone with nothing running on the server.
  Where the codecs make that impossible it decodes with WebCodecs onto a canvas instead.

**[Full technical documentation → DOC-TECH.md](DOC-TECH.md)** — the three paths, how the remuxer
reconstructs decode times, how random access points are verified, how audio is delivered or
re-encoded, what the server is still told, and the file map.

<!-- CAPTURE : cinema-player.png
     The player with its controls visible: timeline with chapter marks, the track menus open or
     closed, the title and episode name.
     Desktop, full width. A trickplay preview hovering over the timeline would be the best frame
     to catch.
     Then uncomment:
<img src="docs/screenshots/cinema-player.png" width="100%">
-->

<!-- CAPTURE : cinema-playback-info.png
     The "Playback info" panel open during playback: the path taken, the file's video and audio
     details, and what the device accepts.
     Crop to the panel.
     Then uncomment:
<img src="docs/screenshots/cinema-playback-info.png" height="360">
-->

## Keyboard and remote

The home screen is fully drivable with the arrow keys: focus moves across and between rows, the
hero follows what you land on, Enter opens, Escape or Backspace goes back. A legend in the
top-right corner says so. It is meant for a keyboard, and it happens to make the app usable from a
TV remote for the same reason.

## On a phone

Desktop and mobile are genuinely different products here, not one layout reflowed: a
focus-following hero and an arrow-key grid on one side, flick rows and inline hero actions on the
other. The phone gets a bottom bar instead of the rail, swipe-to-close action sheets, haptic
feedback (Android/Chromium — iOS Safari has never implemented the Web Vibration API, even in an
installed PWA), and installs to the Home Screen as a PWA with Web Push, Apple Web Push included.

<!-- CAPTURE : cinema-mobile-home.png + cinema-mobile-sheet.png + cinema-mobile-search.png
     Three phone screenshots, same device and theme, to sit side by side:
       1. the home screen with the hero and the first row, bottom bar visible
       2. a film's sheet with its inline actions
       3. the search panel with results
     Then uncomment:
<img src="docs/screenshots/cinema-mobile-home.png" height="320"> <img src="docs/screenshots/cinema-mobile-sheet.png" height="320"> <img src="docs/screenshots/cinema-mobile-search.png" height="320">
-->

---

# The Management interface

`/gestion` — the administrator's second interface over the same stack. Everything a Radarr,
Sonarr, Bazarr, Jackett, qBittorrent, Jellyfin and Jellyseerr install would otherwise be seven
browser tabs.

<!-- CAPTURE : gestion-home-1.png + gestion-home-2.png + gestion-home-mobile.png
     Three shots of the dashboard home, to sit side by side:
       1. the top of the page — the rotating hero with its title logo and progress segments
       2. further down — Continue watching and Recently added, with the IMDb badges visible
       3. the same page on a phone, sidebar closed
     Desktop shots at the same width so the two crop to the same height.
     Then uncomment:
<img src="docs/screenshots/gestion-home-1.png" height="210"> <img src="docs/screenshots/gestion-home-2.png" height="210"> <img src="docs/screenshots/gestion-home-mobile.png" height="210">
-->

## Dashboard home

- **Rotating hero banner** — the 10 newest additions across movies and series, TMDB title-logo art
  when available, auto-advancing every 8 s with a segmented progress bar to jump back
- **Continue watching** — Jellyfin resume progress with an IMDb rating badge
- **My list** — quick-glance row of watchlist items marked *À voir*; a title not yet in the library
  gets an inline *Demander*
- **Recently added** — separate movie and series rows, with a link to the full library page
- **TV-remote style keyboard navigation** — arrow keys across every row, Enter to open

## Library and media management

- **Radarr and Sonarr library views** — grid and list modes, filtering, quick search, sorting
  (including by IMDb rating), keyboard navigation
- **Movie and series detail pages** — poster, metadata, cast carousel, active downloads, file info,
  IMDb / RT / Metacritic ratings

<!-- CAPTURE : gestion-movie-1.png + gestion-movie-2.png + gestion-movie-mobile.png
     A movie detail page, three shots:
       1. the top — poster, metadata, ratings row (pick a title MDBList actually has notes for)
       2. further down — cast carousel and file info, ideally with a download in progress
       3. the same page on a phone
     Same title in all three.
     Then uncomment:
<img src="docs/screenshots/gestion-movie-1.png" height="210"> <img src="docs/screenshots/gestion-movie-2.png" height="210"> <img src="docs/screenshots/gestion-movie-mobile.png" height="210">
-->

- **Watchlist** — add any title from TMDB, classify with 5 statuses (À voir, Favoris, Vus, À
  demander, Abandonnés), personal notes, search and sort, IMDb rating badge on every card

<!-- CAPTURE : gestion-watchlist.png + gestion-watchlist-mobile.png
     The watchlist grid, desktop and phone. Frame a card mid-hover on the desktop shot so the
     overlay with the 5 status buttons is visible, and try to have both a "Dispo" (green) and an
     "Attente" (amber) badge in the same view.
     On the phone shot, the ActionSheet half-open is the more telling frame.
     Then uncomment:
<img src="docs/screenshots/gestion-watchlist.png" height="260"> <img src="docs/screenshots/gestion-watchlist-mobile.png" height="260">
-->

- **Natural language search** — `film de guerre de Christopher Nolan`, `série avec Clara Galle`,
  `film comédie avec Ryan Gosling`

<!-- CAPTURE : gestion-search-1.png + gestion-search-2.png + gestion-search-3.png + gestion-search-mobile.png
     Four shots of the global search, one per kind of query, so the point lands:
       1. a plain title
       2. a natural-language query naming a director
       3. a natural-language query naming an actor
       4. the same search on a phone
     Keep the typed query legible in each — it is the subject of the shot.
     Then uncomment:
<img src="docs/screenshots/gestion-search-1.png" height="160"> <img src="docs/screenshots/gestion-search-2.png" height="160"> <img src="docs/screenshots/gestion-search-3.png" height="160"> <img src="docs/screenshots/gestion-search-mobile.png" height="160">
-->

- **Discover** — trending movies and series with genre filters, TMDB search, a *Pour vous* tab
  based on Jellyfin play history
- **Recommendations** — personalised rows from recently watched Jellyfin history
- **Release search modal** — browse and grab releases from Radarr/Sonarr inside the app
- **Interactive search (movies)** — admin-only, on Watchlist, Discover and Recommendations cards:
  adds the movie and opens the release search in one step. The movie is added *unmonitored* until
  a release is actually picked, so an abandoned search does not leave Radarr endlessly re-searching
  an empty entry
- **Add to library (series)** — admin-only, adds a series to Sonarr directly; per-season
  interactive search and a one-click automatic search live on the series' own detail page
- **Remove from Radarr/Sonarr** — with an in-app confirmation, also clearing the matching
  Jellyseerr record so the title can be requested again cleanly

### One card design everywhere

All media grids (Watchlist, Discover, Recommendations) share the same card:

- Poster-only, `aspect-[2/3]`
- **Desktop** — hover overlay with the 5 status buttons, *Voir la fiche* / *Demander*, and the
  admin-only *Recherche interactive* (movies) / *Ajouter* (series)
- **Mobile** — tap for an ActionSheet with a real-time swipe-to-close gesture
- **IMDb rating badge** — bottom-left, via OMDb
- **Dispo** (green) — the file is actually downloaded · **Attente** (amber) — monitored but not
  yet available
- **Delete confirmation** — an in-app modal, never the browser's

## Requests and downloads

- **Jellyseerr request management** — requests are made and tracked with each logged-in user's own
  Jellyseerr account, auto-linked at login through the same Jellyfin credentials, not a shared
  admin key, so status and history are attributed to the right person
  - Movies — one-click request with confirmation
  - Series — pick specific seasons, based on their actual current status in Jellyseerr
    (already-requested and available seasons are shown as such and excluded); asking for more
    seasons later is a normal follow-up request, not a rejected duplicate
  - Admins see every pending request instance-wide; users see their own
- **qBittorrent monitoring** — live torrent list with section separators (En cours / Seed /
  Pausés), progress bars, speed indicators, start/stop/remove

## Calendar, timeline and stats

- Media release calendar from upcoming Radarr/Sonarr entries, and an activity timeline
- Top actors and directors ranked by number of titles in the library
- Library and person statistics across movies and series
- Storage breakdown (movies / series / seeds / other) and a disk saturation forecast

<!-- CAPTURE : gestion-stats-mobile.png
     The statistics page on a phone: top actors or directors ranked, or the storage breakdown.
     Whichever of the two reads best at that width.
     Then uncomment:
<img src="docs/screenshots/gestion-stats-mobile.png" height="320">
-->

## Ratings

- **MDBList** — IMDb, Rotten Tomatoes, Metacritic, Letterboxd and Trakt on detail pages, from a
  single API call
- **OMDb** — IMDb badges on Watchlist cards, the dashboard home and the Radarr/Sonarr grids, cached
  24 h server-side; movies read Radarr's own rating data directly, with no extra call
- **Sort by IMDb rating** on the library pages
- TMDB vote average on Discover and Recommendations cards

## Everything else

- Service health dashboard

<!-- CAPTURE : gestion-health.png
     The service health page, full width, desktop. Ideally with a mix of states — everything
     green is less informative than one service reporting its own error.
     Redact any hostname or port you would rather not publish.
     Then uncomment:
<img src="docs/screenshots/gestion-health.png" width="100%">
-->

- Bazarr subtitle management per episode, NFO viewer, trailer modal, collection (saga) modal
- Actor / person modal with filmography

<!-- CAPTURE : gestion-person.png + gestion-person-mobile.png + gestion-person-search-1.png + gestion-person-search-2.png
     The person modal, four shots:
       1. desktop — biography and filmography, with the "x of y available" count visible
       2. the same on a phone
       3. and 4. reaching a person from the search, then the filmography it opens
     Pick someone with a real filmography, several titles of which are in the library.
     Then uncomment:
<img src="docs/screenshots/gestion-person.png" height="260"> <img src="docs/screenshots/gestion-person-mobile.png" height="260">
<img src="docs/screenshots/gestion-person-search-1.png" width="49%"> <img src="docs/screenshots/gestion-person-search-2.png" width="49%">
-->

- Installable PWA, Web Push including iOS Safari / Apple Web Push
- Four interface languages — French, English, Spanish, German, the video player included
- Mobile-first navigation with haptic feedback (Android/Chromium only)

<!-- CAPTURE : gestion-mobile-nav.png
     The mobile navigation drawer open over a page, showing the full list of sections.
     Phone, portrait.
     Then uncomment:
<img src="docs/screenshots/gestion-mobile-nav.png" height="320">
-->

### Optional: the Clara Galle gallery page

An enriched page for one actress — full-screen photo gallery, detailed biography, external links.
Disabled by default; it needs `CLARA_GALLERY_ENABLED=true` and a photo folder mounted read-only,
containing JPG/PNG/WebP files and a `clarabanner.jpg` used as the page banner. See
[DEPLOYMENT.md](DEPLOYMENT.md#12-optional-features).

<!-- CAPTURE : clara-1.png … clara-4.png
     Four shots of the gallery page: the banner at the top, the biography, the photo grid, and
     one photo open full-screen. Two by two.
     Optional — this page only exists when the feature is enabled.
     Then uncomment:
<img src="docs/screenshots/clara-1.png" width="49%"> <img src="docs/screenshots/clara-2.png" width="49%">
<img src="docs/screenshots/clara-3.png" width="49%"> <img src="docs/screenshots/clara-4.png" width="49%">
-->

---

# Optional services

Only **Jellyfin** and **TMDB** are needed for Cinema to be worth opening; Radarr and Sonarr are
what fill it. Everything else is optional, and an integration that is not configured is treated as
a configuration, not as a failure:

- `/api/config/public` reports which services are connected — booleans only, never an address or a
  key, since that route is read without a session.
- A page whose service is missing shows what is missing and the exact variables to add to `.env`,
  instead of a network error.
- The sidebar dims those entries rather than hiding them, so a page someone is looking for can
  still be found and explain itself.
- In Cinema, requests disappear when Jellyseerr is absent, and playback falls back to the
  server-side player when the browser cannot handle a file.

A service that is configured but **down** is a different thing and reads differently: `/status` and
the health cards say so, with the error the service itself returned.

---

# Deployment

**→ [DEPLOYMENT.md](DEPLOYMENT.md) is the complete guide.** What follows is the shape of it.

You need Docker, an existing media stack, API keys for the services you want to connect, and
ideally a shared Docker network. You do **not** need to clone this repository or install Node:
the image published on GHCR contains the built app.

```bash
mkdir -p ~/cine-app && cd ~/cine-app
curl -O https://raw.githubusercontent.com/LK59/cine-app/main/.env.example
curl -O https://raw.githubusercontent.com/LK59/cine-app/main/docker-compose.example.yml
cp .env.example .env && cp docker-compose.example.yml docker-compose.yml
# edit both, then:
mkdir -p data/image-cache && sudo chown -R 1001:1001 data
docker compose pull && docker compose up -d
```

The app listens on port `3000` inside Docker; put a reverse proxy in front of it. Updating is
`docker compose pull && docker compose up -d` — migrations run at startup.

`docker-compose.yml` is intentionally git-ignored: keep your production compose local to your
server, and commit changes to `docker-compose.example.yml` when the public template should change.

The full guide covers the parts that are easy to get wrong: which URLs the *container* can resolve,
the uid that has to read your media, the nginx header buffer that closes connections instead of
answering, and what to check when a service reads as unreachable.

---

# Authentication and roles

Two ways in, and exactly two roles.

**Jellyfin accounts (the normal way).** Any existing Jellyfin user logs in with their Jellyfin
username and password. The session carries a Jellyfin identity, which is what per-user resume,
play history, watched state, playback preferences and recommendations are all built on. Jellyfin
administrators are administrators here; everyone else is a regular user.

**The local admin account** (`APP_ADMIN_USER` / `APP_ADMIN_PASSWORD`) is independent from Jellyfin
— for setup, and for the day Jellyfin is unreachable. It has no Jellyfin identity, so nothing
depending on one works under it, and it lands on `/gestion` rather than on Cinema.

**A guest account** can be enabled (`GUEST_USER` / `GUEST_PASSWORD`): read-only across the whole
app, with a single permitted write — requesting a title.

Permissions are never enforced by the interface. `src/proxy.ts` refuses every write a `user`
should not make, whatever the screen happens to show; hiding a button is presentation, not
security.

---

# Security

Never commit:

```text
.env
data/
*.db
*.db-wal
*.db-shm
```

All service API keys stay server-side and are never exposed to the browser.

## Sessions

A session is a signed token (HMAC-SHA256) in an `httpOnly` cookie, with a server-side row so it
can be revoked immediately rather than only on expiry. Three things are worth knowing:

- **The Jellyfin token and the Jellyseerr cookie travel inside it, encrypted** (AES-GCM, key
  derived from `SESSION_SECRET`). Signing is not hiding: without this, a stolen cookie handed over
  a working Jellyfin token rather than just a Cine App session.
- **Sessions slide.** The cookie is reissued past a day of age, keeping the same session id, so
  daily use never ends in a weekly sign-out.
- **Signing your other devices out affects Cine App only.** The Jellyfin sessions those logins
  opened are left alone — deliberately: nobody clicking that button expects to lose Jellyfin
  with it.

`SESSION_SECRET` must be set. Left at its default, the server refuses to start rather than logging
a line nobody reads.

---

# Development

Only relevant if you are modifying the code — deploying needs none of this.

**There is no Node or npm on the reference host.** Everything runs through Docker.

```sh
# Iterate — hot reload against the working tree, on http://<server>:3001.
# Runs alongside production; does not rebuild the image.
docker compose -f docker-compose.dev.yml up

# The gate — identical to CI's verify job. Run it before every commit.
docker run --rm -v "$PWD":/app -w /app node:24-alpine sh -c \
  'set -e; npm run typecheck; npm run lint -- --max-warnings=0; npm test'

# One test file
docker run --rm -v "$PWD":/app -w /app node:24-alpine npx vitest run src/__tests__/<file>
```

`set -e` and no pipes: `npm test | grep` swallows the exit code, and a red test has been pushed
that way before.

**Building from source** instead of pulling the image — replace the `image:` line in your compose
file with:

```yaml
build:
  context: .
  dockerfile: Dockerfile
```

then `docker compose up -d --build`. The build runs the test suite first: it fails loudly instead
of shipping a broken image.

**Why the dev stack exists.** `docker compose build` re-runs the full production build and writes
a new set of image layers every time — hundreds of megabytes per iteration, pure waste when a
single source file changed. The dev stack runs `next dev` against the bind-mounted working tree,
in its own container, on its own port, with its own build directory, so the two never overwrite
each other's output.

When a real build *is* needed, three things keep it cheap: `.dockerignore` excludes `data/` (633 MB
of runtime state that used to be copied into the build context and into a layer); `npm install`
and `next build` use BuildKit cache mounts, so npm's download cache and Next's compiler cache
survive between builds and are updated in place. Together, a rebuild after a source change
transfers 61 kB of context instead of 676 MB, in about 35 seconds instead of a minute and a half.
The build cache does accumulate — `docker builder prune` reclaims it.

One caveat: the development port is plain HTTP, and several browser APIs are restricted to secure
contexts. The native WebCodecs player refuses to start there and says so. Testing that specific
feature needs HTTPS — deploy it, or point a reverse-proxy host at port 3001.

## Debugging a running deployment

Diagnose against the container rather than reasoning in the dark. It has every service URL and API
key in its environment:

```sh
docker exec cine-app node -e '...'
docker exec cine-app tail -n 50 /app/data/logs/server.log   # server errors, with stack traces
docker exec cine-app tail -n 50 /app/data/logs/player.log   # what each viewer's player reported
```

Both are one JSON object per line, rotated at 5 MB, and live in the `data` volume — which matters,
because `docker logs` dies with the container, and the container is recreated on every deploy.

---

# Documentation map

| Document | What it covers |
|---|---|
| **README.md** *(this file)* | What the two interfaces are and what they do |
| **[DEPLOYMENT.md](DEPLOYMENT.md)** | Installing and running it, step by step, from the published image |
| **[DOC-TECH.md](DOC-TECH.md)** | The in-browser player: the three playback paths, the remuxer, audio, diagnostics |
| **[CLAUDE.md](CLAUDE.md)** | Architecture and conventions, for anyone working on the code |
| **`.env.example`** | Every configuration variable, annotated in place |
| **`docker-compose.example.yml`** | The deployment template, annotated in place |

## Screenshot conventions

Placeholders throughout this file are HTML comments naming the file to produce, what to frame, and
the `<img>` tag to uncomment once it exists. They live in `docs/screenshots/`.

For a consistent set: desktop shots at 1920×1080 in the dark theme, phone shots from one device,
and the same handful of titles across all of them so the library reads as one library.

The list of what is still missing is the placeholders themselves — there is no second list to keep
in sync:

```sh
grep -n 'CAPTURE :' README.md DEPLOYMENT.md
```
