# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted front end for one household's media server. It presents a Netflix-shaped browsing
experience over a Radarr / Sonarr / Jellyfin / Jellyseerr / qBittorrent / Bazarr / Jackett stack,
plays films in the browser through its own remuxing player, and gives the administrator a second
interface for running the stack itself. Next.js 16 (App Router) + React 19, TypeScript, Tailwind 4,
SQLite. One container, deployed by `docker compose`, image published to GHCR.

| | Address | Audience |
|---|---|---|
| Cinema | `/` — route group `(player)` | Everyone (~19 Jellyfin accounts) |
| Management | `/gestion` — route group `(dashboard)` | Admin only |

There are exactly **two roles**, `admin` and `user`. Permissions are never enforced by the
interface: `src/proxy.ts` refuses every write a `user` should not make, whatever the screen shows.
Hiding the management button is presentation, not security.

## Commands

**There is no Node or npm on this host.** Everything runs through Docker.

```sh
# Iterate — hot reload against the working tree, on http://<server>:3001.
# Runs alongside production; does not rebuild the image.
docker compose -f docker-compose.dev.yml up

# The gate — identical to CI's verify job. Run it before every commit.
docker run --rm -v "$PWD":/app -w /app node:24-alpine sh -c \
  'set -e; npm run typecheck; npm run lint -- --max-warnings=0; npm test'

# One test file
docker run --rm -v "$PWD":/app -w /app node:24-alpine npx vitest run src/__tests__/<file>

# Deploy (the Dockerfile runs the tests before building)
docker compose build && docker compose up -d
```

`set -e` and no pipes: `npm test | grep` swallows the exit code, and a red test has been pushed
that way before. Read the gate's exit status before committing.

Tests default to the `node` environment; a component test opts into jsdom with a
`// @vitest-environment jsdom` docblock on its first line.

**Diagnose against the running container rather than reasoning in the dark.**
`docker exec cine-app node -e '...'` has every service URL and API key in its environment, and
`data/logs/player.log` holds what each viewer's player reported about itself — path taken,
fallbacks, browser, file. Several bugs this repository has fixed were found there and nowhere else.

## Architecture

**`src/proxy.ts` is the single gate.** Next 16's "Proxy" (formerly middleware), always on the Node
runtime — so it can call `verifySessionFull`, whose SQLite revocation check is impossible under
Edge. It owns the public-path list (shared with the client through `src/lib/publicPaths.ts`), the
guest write whitelist, `308` redirects for addresses that moved (`/player`, `/cinema` → `/`),
sliding session refresh, and the `x-session-expired: 1` header. **It is that header's only
emitter**: a bare 401 may come from an upstream service whose key is wrong, and only this header
means the viewer's own session is gone.

**API routes are thin** (~59 lines average). Logic lives in `src/lib`:

- `src/lib/clients/*` — one module per upstream service.
- `src/lib/server-cache.ts` — TTL-keyed caching in front of them. Prefer `cachedMovies` /
  `cachedSeries` over hitting a client directly from a route.
- `src/lib/db.ts` — SQLite through better-sqlite3, `migrate()` creating tables idempotently.
  **Every query is synchronous and holds the event loop.** Deletes over large tables are batched
  under a time budget for exactly that reason.

**One place per fact.** "Watched" and "favorite" are Jellyfin's (`useJellyfinItemState`); "to
watch" is local. A second copy always diverges — a film finished on the TV read as unwatched here
for weeks before that was fixed.

**Cinema navigation lives in the URL hash** (`src/lib/cinemaRoute.ts`): open sheet, tab, panels.
`cinemaClose` goes through `history.back()`, and each entry records what it covers, so a sheet
stays drawn under the one above it.

**The player** has its own reference: read `DOC-TECH.md` before touching `src/lib/webcodecs/`.
Three paths, chosen per file — remux → native `<video>` (normal), WebCodecs → canvas (fallback),
direct play. `PlayerHost` chooses between the native player and the legacy server-transcoding one;
`fallToStable` hands over rather than closing.

## Conventions

**Comments carry the why and the original symptom.** 17% of source lines are comments, and they are
how a decision's history survives. Match that density; a comment restating the code is worse than
none.

**Mobile and desktop are parallel trees that drift.** `CinemaClient.tsx` /
`mobile/CinemaMobileClient.tsx`, `CinemaMovieDetail` / `CinemaMobileDetail`. A fix on one side is
half a fix — and a guard present on one side and missing on the other has cost five failed attempts
at a single bug. Better than fixing both: give them one shared function so they cannot diverge again.

**Ask the browser, never a list.** `MediaSource.isTypeSupported`, real `SourceBuffer` probes,
`AudioEncoder.isConfigSupported`. But ask the question you actually mean:
`canPlayType("application/vnd.apple.mpegurl")` answers "can you play HLS", not "are you WebKit" —
Chrome on Android says yes to the first and no to the second. `isWebKitEngine` is for engine
defects; probes are for capabilities.

**Anything written into an MP4 box that a reader may compare against another box must come from the
file, not a constant.** Chrome rejects a whole init segment over a FLAC sample size that disagrees
with STREAMINFO; Safari does not check. The forgiving browser is not the specification.

**A check that runs on someone else's error path must not become the error.** Detection that threw
replaced the server's real message on screen; reconciliation that threw made a live subscription
read as off. Both now sit in their own guard.

**The React Compiler lint is enforced at zero warnings** — no `setState` in an effect body, no
writes to outer variables during render, no ref mutation during render. Existing
`eslint-disable-next-line` comments are deliberate and each is explained.

**i18n covers `fr`, `en`, `es`, `de`**; a key must exist in all four. Displayed strings never use
infrastructure vocabulary ("dashboard", "tableau de bord", "stack") — a test enforces this over the
dictionaries' values.

## Known pitfalls

- **SWR is paused while a film fills the screen** (`isPaused: isWatchingFullScreen`). Two
  consequences, each of which has caused an outage: a query the player needs *in order to exist*
  must carry `playerBootstrapOptions`, or the film taking the screen prevents learning how to play
  it; and a paused query is **dropped, not deferred** — SWR never replays it, so
  `PlaybackProvider` re-asks for every key left with neither data nor error when the screen comes
  back.
- **Only `/api/jellyfin/resume` and `/api/cinema/next-up` revalidate on focus** (`liveFeedOptions`).
  The rest of the catalogue is deliberately frozen; a 1.4 MB payload is not refetched on every wake.
- **A TMDB or person sheet covers the library stack, it does not replace it** — keep the stack
  rendered and inert. And a sheet is never behind itself: a discover push keeps the current `film`
  in the address.
- **Sheets and panels leave through `useDelayedClose`**, which holds the address for the length of
  the animation. Anything closing by changing the route directly cuts its own animation short.
- **A pathological file is the normal case here.** The library holds six-audio-track files mixing
  FLAC / AC-3 / DTS / TrueHD at 1, 6 and 8 channels, 24-bit FLAC, mono defaults, Dolby Vision 4K.
  Test player changes against `The Exorcist (1973)` before believing them.

## Do not change these without a reason

- **The reverse proxy.** It fronts about twenty other sites on this machine. The dev stack exists
  on its own port precisely so it never has to be touched.
- **Media files.** `/mnt/media/video` is mounted read-only and belongs to Radarr/Sonarr. Anything
  writing there goes through them.
- **`TRUST_BUFFER_REBUILD = false`** (`pathSelector.ts`). The probe is still run and recorded, and
  the answer is deliberately disbelieved: Safari accepts the buffer swap, accepts every segment,
  grows its ranges correctly — and plays no sound. Left switchable, not deleted.
- **The WebKit reload in `changeAudio`** (`PlayerHost.tsx`). WebKit cannot open a second HLS session
  in one page; every other angle was tested and ruled out, and a full reload is the only thing that
  works. Its guard, on the other hand, was wrong for years — see `isWebKitEngine`.
- **The per-file audio codec/channel unification** (`remuxer.ts`). It removes the mid-buffer
  transition rather than trying to survive it, after every attempt at surviving it turned out to be
  a guess about someone else's decoder.
- **`CACHE_NAME` in `public/sw.js`.** Bumping it evicts every cached asset for every installed PWA;
  the version history in that file's header says why each bump happened.
- **`SESSION_SECRET`.** Startup throws on the default value rather than warning — a forged admin
  session is not a log line.

## Deployment

`RUNBOOK.private.md` has the operator's checklist. Push to `main` triggers the GHCR publish, whose
first job is the same verify workflow. `./data:/app/data` is the only writable volume — SQLite,
the image cache, and the player log all live there. Never commit `.env`, `data/`, or `*.db*`.
