# Features

A tour of everything Laterna does, screen by screen. For installing it, see
[QUICKSTART.md](../QUICKSTART.md) and [DEPLOYMENT.md](../DEPLOYMENT.md); for every setting,
[ENV.md](../ENV.md).

## The two interfaces

| | Address | Who it is for |
|---|---|---|
| **[Cinema](#the-cinema-interface)** | `/` | Everyone. Rows of posters, a full-bleed hero, search, personal lists, requests, and in-browser playback. This is the front door. |
| **[Management](#the-management-interface)** | `/gestion` | The administrator. *Infrastructure* — downloads, service status, storage, Radarr, Sonarr, calendar, statistics, imports — and *Configuration* — service connections, playback, generated subtitles, new accounts. |

Both run from the same container, the same session and the same set of API routes. There are only
ever **two roles**: `admin` and `user`. A `user` can browse, play, keep lists and request titles;
every write to the underlying services is refused server-side in `src/proxy.ts`, whatever the
interface happens to show. The management screens are reachable from Cinema through
**Account → Open management**, which only an administrator sees; Management leads back with
**Back to Cinema**, at the top of its navigation. These are the only two ways across.

`/player` and `/cinema` are the addresses Cinema had before it became the root; both answer `308`
to `/`, so old links, open tabs and already-installed home-screen shortcuts keep working.

## Contents

- [The Cinema interface](#the-cinema-interface)
- [The Management interface](#the-management-interface)
- [Optional services](#optional-services)
- [Smart features](#smart-features)

---

## The Cinema interface

`/` — the screen every account lands on. It is built around one idea: a library is not a file
manager. Nothing here names a service, a container or a download client; a title is a poster, and
everything you can do with it hangs off that poster.

<!-- CAPTURE : cinema-home-desktop.png
     THE hero shot of the project — put the most representative one here.
     Cinema home, desktop, 1920×1080, a full-bleed backdrop at the top with its title logo, and
     the first two rows of posters visible underneath. Pick a title whose artwork is striking and
     whose backdrop is dark enough for the gradient to read.
     Then uncomment:
<img src="screenshots/cinema-home-desktop.png" width="100%">
-->

### Getting around

Four entries, and that is a ceiling rather than an accident: past four, a navigation rail stops
being a landmark and becomes a list you have to read. Everything else — sheets, episodes, people —
opens from the content itself.

| | | |
|---|---|---|
| **Home** | The rows | Pressing it again from anywhere closes what covers it and comes back |
| **Search** | One field for the library, TMDB and people | Pressing it while already there is the intent to type |
| **My list** | To watch · Requests · Watched | |
| **Account** | Language, playback preferences, notifications, devices | |
| *Management* | `/gestion` | Administrators only, from **Account → Open management**; leaves Cinema rather than opening a panel |

On desktop it is a vertical rail on the left, collapsed to icons and expanding on hover. On a
phone it is a bottom bar with the same four entries. One list describes both, so they cannot
drift apart.

On a large screen, Search, My list, the full grids and Account open full screen rather than as
floating windows, with their content in a centred column sized for what it holds; a poster grid
uses the whole width.

**Every screen is in the address.** Which sheet is open, which tab, which panel — all of it lives
in the URL hash, so the browser's Back button and the phone's edge-swipe step back through the
screens instead of leaving Cinema entirely, and a sheet stays drawn underneath the one above it.
A film's page can be shared, bookmarked and reopened.

<!-- CAPTURE : cinema-rail-expanded.png
     The left rail hovered so the labels are visible, over a blurred home screen.
     Crop to the left third of the screen, portrait-ish.
     Then uncomment:
<img src="screenshots/cinema-rail-expanded.png" height="320">
-->

### The home screen

A **Movies / Series** toggle switches the whole screen; each tab is composed the same way, top to
bottom:

| Row | What it is |
|---|---|
| **Spotlight** | A full-bleed banner rotating through the latest additions, with the TMDB title logo when there is one. On desktop it carries **Play** and **More info** and a row of dashes to move between titles, all reachable with the arrow keys; moving over a card turns it into a preview of that card, and a « Spotlight » pill brings the rotation back. On a phone it is a carousel of whole posters with their neighbours peeking at the edges, looping from the last to the first; touching the poster opens its page. |
| **Continue watching** | Films in progress and the next episode of each series, the most recently played first, with the time left. A series whose first episode was never started is left out. |
| **My list** | What you saved. With fewer than two titles it moves further down, just above the genres. |
| **Top 10 of the day** | A daily ranked selection from the library — a genre, a decade, a pairing — by the IMDb rating the app already caches. |
| **Recently added** | What Radarr and Sonarr actually landed, with a **New** badge for the last 30 days, and a *see all*. |
| **One row per genre** | Alphabetical, each with a *see all* that opens the genre as a full grid. |
| **Recommended for you / Trending** | TMDB rows of titles that are **not** in the library — a card here opens a request, not a player. |

A row with nothing in it hides itself rather than showing an empty shelf.

A **Browse all** button (top right) opens the whole library as one grid — sortable, and filtered by
genre, decade and duration, with genres that only differ by language (« Horror », « Horreur »)
grouped under one name. One layout choice is a server setting with a per-account override in
*Account → Interface*: a banner that shows what you are watching first, completed by the latest
additions (off by default, `HOME_CONTINUE_HERO`).

<!-- CAPTURE : cinema-rows.png
     Mid-scroll on the home screen: three or four complete rows stacked, including the Top 10
     with its ranked numerals and a "New" badge visible on a recently-added card.
     Desktop, full width.
     Then uncomment:
<img src="screenshots/cinema-rows.png" width="100%">
-->

### A title's page

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

A sheet opens complete. The tagline, the trailer button, a series' episode length and season count,
the cast shown in the desktop banner and the play button of a series never started all travel with
the catalogue the device already keeps, instead of arriving a moment after the rest. Whatever the
server then says for your account — the episode you are actually up to, a position — replaces it
as soon as it arrives, and a press made before that waits for the answer rather than starting the
wrong episode. On desktop the synopsis takes up to five lines when the page has room above the
logo.

<!-- CAPTURE : cinema-movie-sheet.png
     A film's sheet open over the home screen, showing the backdrop, the logo, the action row
     and the beginning of the cast carousel.
     Desktop, full width. Prefer a title with a good logo and a real cast list.
     Then uncomment:
<img src="screenshots/cinema-movie-sheet.png" width="100%">
-->

<!-- CAPTURE : cinema-series-episodes.png
     A series' episode browser: the season selector, episode thumbnails, a part-watched episode
     with its progress bar, and the "up next" marker.
     Desktop, full width.
     Then uncomment:
<img src="screenshots/cinema-series-episodes.png" width="100%">
-->

### Search

One field, and it does not ask you to pick a category first: it searches the library, TMDB and
people at once, and separates the answers afterwards. A title already here plays; a title that is
not can be requested from the same result card. Recent searches are kept and can be cleared.

Natural-language queries work — `film de guerre de Christopher Nolan`, `série avec Pedro Pascal`,
`comédie avec Ryan Gosling`.

<!-- CAPTURE : cinema-search.png
     The search panel with a query typed, showing the All / Movies / Series / People filters and
     a mix of results: something available, something not in the library yet.
     Desktop, full width.
     Then uncomment:
<img src="screenshots/cinema-search.png" width="100%">
-->

### My list

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
<img src="screenshots/cinema-mylist.png" width="100%">
-->

### Account

Interface language (French, English, Spanish, German), preferred audio and subtitle languages,
subtitle display mode, notifications, password, the home layout and guided scrolling (*Interface*),
and the list of signed-in devices with a one-press sign-out for the others. Changing the password
signs the other devices out of Jellyfin, and the form says so before you confirm.

The playback preferences are **Jellyfin's own**, not a local copy: setting a preferred audio
language here applies in the Jellyfin apps too.

### Playing something

Playback happens in the page, over the rows, and can be shrunk into a **draggable mini-player**
that keeps playing while you browse. The player carries resume, audio and subtitle track
selection with size and manual offset, chapters, playback speed, trickplay scrubbing previews,
skip-intro and automatic next-episode advance, AirPlay and Chromecast, and
[downloads for offline viewing](#downloads-for-offline-viewing).

In-app playback is **on by default** (`PLAYER_ENABLED`), because of how it now works:

- **The native player** is the ordinary path. It asks the server for nothing beyond the file
  itself: the browser fetches the file (MKV or MP4) by byte ranges, repackages it into fragmented MP4 in the
  tab, and hands it to a real `<video>` — hardware decoding, native HDR, no transcoding at all: a
  4K Dolby Vision HEVC film with E-AC3 Atmos plays on an iPhone with nothing running on the
  server. Audio the device cannot play — TrueHD (FFmpeg's own decoder, compiled to
  WebAssembly), DTS, FLAC — is decoded in the browser and re-encoded. Each audio track is delivered
  in its best form, and switching to a track of another format rebuilds the player at the same
  position.
- **The server-side player** is the safety net underneath. A file the native player cannot carry is
  handed to Jellyfin, which negotiates DirectPlay / DirectStream / Transcode the way its own web
  client does; a "Playback info" panel says which of the three is running, why, and at what
  bitrate. This is the only case where a playback can cost your server CPU, which is why it can be
  turned off entirely (`PLAYER_SERVER_FALLBACK=false`) — a file the browser cannot play then ends
  on a plain error naming the reason, and nothing ever starts a transcode.
- **Slow connections** adapt on their own (setting *Quality: Automatic*, the default): when the
  measured link cannot carry the file — no picture after 10–20 s at opening, or repeated stalls
  caused by the network during playback — a lighter transcode (HEVC, or H.264 where HEVC is not
  supported; 720p up to 2.5 Mbit/s, 1080p above, SDR) is prepared on the server in the background
  and the player switches to it at the same position. The viewer only sees « Slow connection… »
  and a short notice. A dropped connection is never treated as a slow one, and *Quality: Original*
  turns the whole thing off. It needs the server-side player and Jellyfin's permission to transcode.
- **Black bars baked into the file** are measured once per file on the server, from the trickplay
  thumbnails Jellyfin already has, and the picture is enlarged to the nearest edge of the screen —
  black is cropped, never picture. It needs trickplay images; `PLAYER_AUTO_FRAME=false` turns it off.
- **Generated subtitles** (optional, off without an API key): when a title has a full text subtitle
  in one language, a viewer can ask for another; an online AI (Anthropic, OpenAI or Google, chosen
  by the administrator) translates it while the film plays, starting where the viewer is. The
  finished file is handed to Jellyfin, so every client sees it afterwards. A monthly budget and a
  daily limit per account bound the cost — see
  [DEPLOYMENT.md](../DEPLOYMENT.md#5-settings-in-the-app).

**[Full technical documentation → DOC-TECH.md](../DOC-TECH.md)** — the two paths, how the remuxer
reconstructs decode times, how random access points are verified, how audio is delivered or
re-encoded, what the server is still told, and the file map. For a non-technical presentation
of the player, in French: [PRESENTATION-LECTEUR.md](../PRESENTATION-LECTEUR.md).

<!-- CAPTURE : cinema-player.png
     The player with its controls visible: timeline with chapter marks, the track menus open or
     closed, the title and episode name.
     Desktop, full width. A trickplay preview hovering over the timeline would be the best frame
     to catch.
     Then uncomment:
<img src="screenshots/cinema-player.png" width="100%">
-->

<!-- CAPTURE : cinema-playback-info.png
     The "Playback info" panel open during playback: the path taken, the file's video and audio
     details, and what the device accepts.
     Crop to the panel.
     Then uncomment:
<img src="screenshots/cinema-playback-info.png" height="360">
-->

### Downloads for offline viewing

A film, an episode or a whole season can be downloaded from its page to watch without a
network, or on a link too weak for streaming. Laterna does not copy the original file: Jellyfin
prepares a lighter version through its transcoding API — *Standard* (720p, about 2 Mbit/s) or
*High* (1080p, about 4 Mbit/s), with the one audio track chosen at download — and the device keeps
it in the browser's private storage, together with its text subtitles, scrubbing previews, artwork
and intro/credits markers. A download can be played while it is still arriving. A series can fetch
the next episode on its own and drop the ones already watched.

A downloads page (the round button beside the home rows) lists what is on the device and how much
room it takes. Without a network, the app opens on `/hors-ligne`, which plays those files with
nothing asked of the server; positions reach Jellyfin when the network comes back. The app must
stay in the foreground while a download arrives. Open to every account by default; off for an
installation with `OFFLINE_DOWNLOADS`, administrators only with `OFFLINE_DOWNLOADS_FOR_EVERYONE=false` — see
[telechargement-hors-ligne.md](telechargement-hors-ligne.md) (in French).

### Books (optional)

Off by default. With `BOOKS_ENABLED` turned on (Configuration → Books, or `.env`), the home
screen's Movies / Series switch gains a third category, « Books »: the EPUB files of Jellyfin's book
libraries, grouped by series in volume order, with a « Continue reading » row, a full grid
(`/livres`), a sheet per book and an in-app reader — pages or continuous scroll, a choice of page-turn animation, text size, font,
line spacing, margins, justification, light / sepia / dark / black themes and dimming, kept per
account and per kind of device (phone, tablet, computer): the first settings an account chooses apply
everywhere, and a kind of device keeps its own once they are changed on it; the device keeps a copy to
open at once and offline. Each account sees the books its Jellyfin account may see, minus its blocked tags; reading
positions are kept by Laterna, and a finished book is marked played in Jellyfin. Share links never
reach books. Book content is untrusted: it is sanitized, shown in frames that cannot run scripts, and
under a page-specific Content Security Policy — see [DECISIONS.md](../DECISIONS.md) §127 and [`tools/livres-securite/`](../tools/livres-securite/).
Turned off, every books address answers 404 and nothing of it loads. Each account can also hide books
for itself (Account → Interface, « Show books »), on all its devices. Books also appear in the app's
search. Series, authors and covers missing from Jellyfin are read from the EPUB itself in the background;
large libraries (thousands of files) are indexed once on the server for every account (each account
only sees the Jellyfin libraries and tags it may see) and sent to devices a page at a time. The reader
also has bookmarks (kept per account), search inside the book, and offline reading: « Download » keeps
a book on the device, readable without a connection from the downloads page. In a browser (not the installed app, which has no downloads manager to find it in), a book's sheet also offers the original file, named « Title - Author.epub », for an e-reader. Optionally (off by default,
`BOOKS_GOOGLE_ENRICH` with a `GOOGLE_BOOKS_API_KEY`, set in `.env` or in Configuration), Google Books
fills in what Jellyfin and the EPUB lack — summary, cover, genres, year — never overwriting existing
data, within a daily request budget (900 requests, one every two seconds, counted on Google's day,
which starts at midnight Pacific time; stopped until then on a quota error). A match must agree on title and author and is never a study guide, an omnibus or
another volume; a summary is only taken in the book's own language (the EPUB's, else the library's
metadata language, else the instance's), so the rule works for any language. The key is sent in a
header, never in an address or a log.

The reader opens in a same-origin frame laid over the home screen, so closing a book returns at once to
where you were, without reloading anything; the global policy only gained `frame-src 'self'` for that
([DECISIONS.md](../DECISIONS.md) §128). A book is « started » once past its first page: one opened and closed on page one,
or below 1 %, stays unread and out of « Continue reading », which a book's sheet can also remove it from.
Layout: « One page » always shows one; « Auto » shows two once two comfortable columns fit side by side;
« Two pages » shows two on any landscape screen; portrait always shows one. A device that keeps a
downloaded book, even with no film, offers its downloads when it starts without a connection.

Each account has a reading list, separate from its films and series: « Add to my reading list » on a
book's sheet, a « My reading list » row on the books home, and a « To read » tab in My list (only where
books are shown for that account); like a watched film in « To watch », a finished book stays in it until removed. Reading sessions (time with
the page visible, progress, pages turned, device, read offline or not) are written one per line to
`data/logs/lectures.log`, with a line when a book is first finished or removed from « Continue
reading »; the administrator reads them under Activity → Reading — per account, books in progress and
finished, reading time and sessions over seven and thirty days ([DECISIONS.md](../DECISIONS.md) §129).

### Keyboard and remote

The home screen is fully drivable with the arrow keys: focus moves across and between rows, the
hero follows what you land on, Enter opens, Escape or Backspace goes back. A legend in the
top-right corner says so. It is meant for a keyboard, and it happens to make the app usable from a
TV remote for the same reason.

### On a phone

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
<img src="screenshots/cinema-mobile-home.png" height="320"> <img src="screenshots/cinema-mobile-sheet.png" height="320"> <img src="screenshots/cinema-mobile-search.png" height="320">
-->

---

## The Management interface

`/gestion` — the administrator's second interface over the same services, reached from Cinema
through **Account → Open management**. Everything a Radarr, Sonarr, Bazarr, Jackett, qBittorrent,
Jellyfin and Jellyseerr install would otherwise be seven browser tabs. It wears Cinema's design —
black, liquid glass, the same cards and pills — and its navigation has two parts:

- **Infrastructure** — what is running: the overview, Movies, Series, Downloads, Calendar,
  Statistics, Imports, then each service's own page and the health checks.
- **Configuration** — how the install is set: service connections, playback, generated subtitles,
  defaults for new accounts, the local administrator, and last, what can only be changed in the
  compose file (media paths, time zone, trusted proxy, secure cookie), with the line to copy.

Its top entry is **Back to Cinema**. Personal preferences — language, notifications, sessions —
are not here: they are in Cinema's *Account*, for the administrator as for everyone, and a discreet
link under Configuration says so.

<!-- CAPTURE : gestion-home-1.png + gestion-home-mobile.png
     The management overview, desktop and phone: downloads in progress, service status, storage and
     the activity summary. Then uncomment:
<img src="screenshots/gestion-home-1.png" height="210"> <img src="screenshots/gestion-home-mobile.png" height="210">
-->

### Overview

An administrator's dashboard, not a second catalogue — the posters, *Continue watching* and *My
list* are Cinema's:

- **Downloads in progress** — progress, speed and ETA, with a link to the full qBittorrent view
- **Service status** — one line per service, its version and figures, or its error
- **Storage** — movies / series / seeds / other on the media disk
- **Cinema activity** — active accounts, sessions playing now, reports waiting for an answer and
  the week's errors, opening Cinema's *Activity* panel
- **Latest imports** — what Radarr and Sonarr grabbed and imported, and recent requests

### Library and media management

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
<img src="screenshots/gestion-movie-1.png" height="210"> <img src="screenshots/gestion-movie-2.png" height="210"> <img src="screenshots/gestion-movie-mobile.png" height="210">
-->

- **Natural language search** — `film de guerre de Christopher Nolan`, `série avec Pedro Pascal`,
  `film comédie avec Ryan Gosling`

<!-- CAPTURE : gestion-search-1.png + gestion-search-2.png + gestion-search-3.png + gestion-search-mobile.png
     Four shots of the global search, one per kind of query, so the point lands:
       1. a plain title
       2. a natural-language query naming a director
       3. a natural-language query naming an actor
       4. the same search on a phone
     Keep the typed query legible in each — it is the subject of the shot.
     Then uncomment:
<img src="screenshots/gestion-search-1.png" height="160"> <img src="screenshots/gestion-search-2.png" height="160"> <img src="screenshots/gestion-search-3.png" height="160"> <img src="screenshots/gestion-search-mobile.png" height="160">
-->

- **Release search modal** — browse and grab releases from Radarr/Sonarr inside the app
- **Add to library (series)** — admin-only, adds a series to Sonarr directly; per-season
  interactive search and a one-click automatic search live on the series' own detail page
- **Remove from Radarr/Sonarr** — with an in-app confirmation, also clearing the matching
  Jellyseerr record so the title can be requested again cleanly
- **Cleanup** (*Infrastructure → Cleanup*) — every film and series in Radarr/Sonarr crossed with
  the Jellyseerr requests, what each account has watched in Jellyfin and the player sessions, ranked
  by a score that shows each of its parts; accounts are rated on what they request and what they
  watch. A title opens on its requests, plays, sessions and the reasons for its score. Removal goes
  through a preview — files, torrents found by inode (cross-seeds included), space expected — then
  a confirmation: qBittorrent with its files, Radarr/Sonarr with theirs, Jellyseerr, a Jellyfin
  refresh, and the space measured on the disk. The server refuses a plan that changed since the
  preview, and keeps a torrent that also serves another title.

Lists, discovery and recommendations are Cinema's: Management has no watchlist of its own.

### Requests and downloads

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

### Calendar, imports and stats

- Media release calendar from upcoming Radarr/Sonarr entries, and **Imports** — what Radarr and
  Sonarr grabbed and imported, day by day (named apart from Cinema's *Activity* panel)
- Top actors and directors ranked by number of titles in the library
- Library and person statistics across movies and series
- Storage breakdown (movies / series / seeds / other) and a disk saturation forecast

<!-- CAPTURE : gestion-stats-mobile.png
     The statistics page on a phone: top actors or directors ranked, or the storage breakdown.
     Whichever of the two reads best at that width.
     Then uncomment:
<img src="screenshots/gestion-stats-mobile.png" height="320">
-->

### Ratings

- **MDBList** — IMDb, Rotten Tomatoes, Metacritic, Letterboxd and Trakt on detail pages, from a
  single API call
- **OMDb** — IMDb badges on the Radarr/Sonarr grids and detail pages, cached
  24 h server-side; movies read Radarr's own rating data directly, with no extra call
- **Sort by IMDb rating** on the library pages
- TMDB vote average on Discover and Recommendations cards

### Everything else

- Service health dashboard

<!-- CAPTURE : gestion-health.png
     The service health page, full width, desktop. Ideally with a mix of states — everything
     green is less informative than one service reporting its own error.
     Redact any hostname or port you would rather not publish.
     Then uncomment:
<img src="screenshots/gestion-health.png" width="100%">
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
<img src="screenshots/gestion-person.png" height="260"> <img src="screenshots/gestion-person-mobile.png" height="260">
<img src="screenshots/gestion-person-search-1.png" width="49%"> <img src="screenshots/gestion-person-search-2.png" width="49%">
-->

- **Stream Deck plugin** — what is playing right now, on the keys of a Stream Deck (see below)
- Installable PWA, Web Push including iOS Safari / Apple Web Push
- Four interface languages — French, English, Spanish, German, the video player included
- Mobile-first navigation with haptic feedback (Android/Chromium only)

<!-- CAPTURE : gestion-mobile-nav.png
     The mobile navigation drawer open over a page, showing the full list of sections.
     Phone, portrait.
     Then uncomment:
<img src="screenshots/gestion-mobile-nav.png" height="320">
-->

### Stream Deck

A plugin for the Elgato Stream Deck app (7.6 or later, Windows or macOS) follows what is playing,
read-only. The package is [`streamdeck-plugin/release/fr.laterna.streamdeck.streamDeckPlugin`](../streamdeck-plugin/release/fr.laterna.streamdeck.streamDeckPlugin):
a double-click installs it.

- **Plays** — one key with the number of plays in progress: grey when nobody watches, white
  otherwise, orange when one of them is in trouble right now (a recent wait, error or rebuild —
  playing through the server is a path like any other, never trouble). Pressing it opens the plays
  page.
- **The plays page** — a profile delivered with the plugin, laid out for a Stream Deck Neo: one
  play per key (poster, who, what, progress), the last key to go back, and the Infobar summing up.
  Pressing a play spreads it over the eight keys: title, who and on what device, position, path
  (device, server, TV or another Jellyfin app) and picture, bitrate, incidents, audio and subtitles.

It does not use a session. Create a token per device in *Management → Configuration →
Administration → Stream Deck* (shown once, revocable), then paste the address and the token into
the settings of any Laterna key. The token opens only `/api/streamdeck` — the plays in progress and
the posters of what is playing — and nothing else. Building the plugin: [streamdeck-plugin/README.md](../streamdeck-plugin/README.md).

---

## Optional services

Only **Jellyfin** and **TMDB** are needed. Without Radarr and Sonarr, Cinema shows everything
Jellyfin has ("Jellyfin only" titles); with them it also gets management — additions, downloads,
requests, missing episodes, the library check. **Jellyseerr** adds requests from Cinema,
**qBittorrent** download progress, **Bazarr** subtitle search, **Jackett** indexers. An integration
that is not configured is treated as a configuration, not as a failure — it is never queried:

- `/api/config/public` reports which services are connected — booleans only, never an address or a
  key — and only to a signed-in session: to anyone else, the list would say what runs behind the
  site.
- A page whose service is missing shows what is missing and where to connect it (*Configuration →
  Connections*, or the variables for `.env`), instead of a network error; the calendar and the
  statistics keep what does not depend on it and say what is missing.
- The sidebar dims those entries rather than hiding them, so a page someone is looking for can
  still be found and explain itself.
- In Cinema, requests disappear when Jellyseerr is absent, and playback falls back to the
  server-side player when the browser cannot handle a file.

A service that is configured but **down** is a different thing and reads differently: `/status` and
the health cards say so, with the error the service itself returned. Signed out, `/status` only
answers the question of someone who cannot get in — can one sign in, can one watch — without
naming the services behind; signed in, it shows every capability.

---

## Smart features

All optional and off by default; each is described in full, with its cost and its limits, in
[ENV.md](../ENV.md) and in [DEPLOYMENT.md](../DEPLOYMENT.md#5-settings-in-the-app)
(*Configuration → Smart features*).

- **Actors on screen (X-Ray)** — a companion service, `laterna-xray`, recognises the credited cast
  scene by scene and who is speaking. It runs on your own server and calls no online AI service.
  In the player, an « On screen » row (opened from a round button beside the title) names who is in
  the scene, and each name opens a person panel.
  Installation: [DEPLOYMENT.md](../DEPLOYMENT.md#optional-actors-on-screen-laterna-xray) and
  [xray/README.md](../xray/README.md).
- **AI features** — one provider (Anthropic, OpenAI or Google), one key and one monthly ceiling
  shared by all of them: generated subtitles (above), search by description, « Previously » on a
  series in progress, questions about a title or an actor, and « So far » in an actor's panel.
  Questions, « Previously » and « So far » use only what the account has already watched, never
  beyond. Share links never get any AI feature.
