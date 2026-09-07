# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**There is no Node or npm on this host.** Everything runs through Docker:

```sh
# The gate — identical to CI's verify job. Run it before every commit.
docker run --rm -v "$PWD":/app -w /app node:24-alpine sh -c \
  'set -e; npm run typecheck; npm run lint -- --max-warnings=0; npm test'

# One test file
docker run --rm -v "$PWD":/app -w /app node:24-alpine npx vitest run src/__tests__/<file>

# Deploy to the running server
docker compose build && docker compose up -d
```

`set -e` and no pipes: `npm test | grep` swallows the exit code, and a red test has been pushed
that way before. Read the gate's exit status before committing.

Tests default to the `node` environment. A component test opts into jsdom with a
`// @vitest-environment jsdom` docblock on the first line, rather than paying jsdom's setup cost
across the whole suite.

Live diagnosis against the deployed container is often faster than reasoning:
`docker exec cine-app node -e '...'` has the service URLs and API keys in its environment, and
`data/logs/player.log` holds what every viewer's player reported about itself.

## Two interfaces, one container

| | Address | Audience |
|---|---|---|
| Cinema | `/` — route group `(player)` | Everyone |
| Management | `/gestion` — route group `(dashboard)` | Admin only |

There are exactly **two roles**, `admin` and `user`. Permissions are never enforced by the
interface: `src/proxy.ts` refuses every write a `user` should not make, whatever the screen
happens to show. Hiding the management button is presentation, not security.

## `src/proxy.ts` is the single gate

Next 16's "Proxy" (formerly middleware), always on the Node runtime — so it can call
`verifySessionFull`, whose better-sqlite3 revocation check is impossible under Edge. It owns:

- public paths (shared with the client through `src/lib/publicPaths.ts` — never re-derive that
  list, a guessed copy already cost a public page),
- the guest write whitelist,
- `308` redirects for addresses that moved (`/player`, `/cinema` → `/`),
- sliding session refresh (7 days, reissued past one day old, same `jti`),
- the `x-session-expired: 1` header. **It is the only emitter.** A bare 401 may come from an
  upstream service whose key is wrong; only this header means the viewer's own session is gone.

## Data flow

API routes are thin (~59 lines average). Logic lives in `src/lib`:

- `src/lib/clients/*` — one module per upstream service (Radarr, Sonarr, Jellyfin, Jellyseerr,
  qBittorrent, Bazarr, Jackett, TMDB, OMDb).
- `src/lib/server-cache.ts` — TTL-keyed caching in front of those clients. Reach for `cachedMovies`
  / `cachedSeries` rather than hitting a client directly from a route.
- `src/lib/db.ts` — SQLite through better-sqlite3, with `migrate()` creating tables idempotently.
  **Every query is synchronous and holds the event loop**, so nothing is served while a long one
  runs. Deletes over large tables are batched under a time budget for this reason.

Truth lives in one place per fact: "watched" and "favorite" are Jellyfin's (`useJellyfinItemState`),
"to watch" is local. A second copy always diverges.

## The player

`DOC-TECH.md` is the reference and is worth reading before touching anything under
`src/lib/webcodecs/`. The shape:

- **Three paths**, chosen per file: remux → native `<video>` (normal), WebCodecs → canvas
  (fallback), direct play. `PlayerHost` picks between the native player and the legacy
  server-transcoding one; `fallToStable` hands over rather than closing.
- **Capabilities are asked, never assumed.** `MediaSource.isTypeSupported`, real `SourceBuffer`
  probes, `AudioEncoder.isConfigSupported`. A hardcoded browser list is how this player would rot.
- But ask the question you actually mean: `canPlayType("application/vnd.apple.mpegurl")` answers
  "can you play HLS", not "are you WebKit". Use `isWebKitEngine` for engine defects, capability
  probes for capabilities.
- **Audio codec and channel layout are unified per file** when the browser cannot swap an audio
  buffer, so changing language never changes the buffer's format. `fold` reconciles every track to
  the chosen layout.
- Anything written into an MP4 box that a reader might compare against another box must come from
  the file, not a constant. Chrome rejects a whole init segment over a FLAC sample size that
  disagrees with STREAMINFO; Safari does not check. The forgiving browser is not the specification.

## Cinema navigation

State lives in the URL hash (`src/lib/cinemaRoute.ts`): open sheet, tab, panels. `cinemaClose`
goes through `history.back()`, and each entry records what it covers so a sheet can stay drawn
underneath the one above it. Consequences worth knowing:

- A TMDB/person sheet **covers** the library stack; it does not replace it. Keep the stack
  rendered and inert.
- A sheet is never behind itself — a discover push keeps the current `film` in the address.
- Both sheets and panels animate out through `useDelayedClose`, which holds the address for the
  animation's length. Anything that closes by changing the route directly cuts its own animation.

## SWR conventions

`SWRProvider` pauses every query while a film fills the screen (`isPaused: isWatchingFullScreen`).
Two consequences that have both caused outages:

- Queries the player needs **in order to exist** must carry `playerBootstrapOptions`, or the film
  taking the screen prevents learning how to play it.
- A paused query is dropped, not deferred — SWR never replays it. `PlaybackProvider` re-asks for
  every key left with neither data nor error when the screen is given back.

Only `/api/jellyfin/resume` and `/api/cinema/next-up` revalidate on focus (`liveFeedOptions`); the
rest of the catalogue is deliberately frozen and cheap.

## Conventions

**Comments carry the why and the original symptom.** 17% of source lines are comments, and they
are how a decision's history survives. Match that density; a comment that restates the code is
worse than none.

**Mobile and desktop are parallel trees that drift.** `CinemaClient.tsx` and
`mobile/CinemaMobileClient.tsx`, `CinemaMovieDetail` and `CinemaMobileDetail`. A fix on one side is
half a fix. Better still, give the two the same shared function so they cannot diverge again.

**The React Compiler lint is enforced with zero warnings.** No `setState` in an effect body, no
writes to outer variables during render, no ref mutation during render. Existing
`eslint-disable-next-line` comments mark deliberate exceptions — each one is explained.

**i18n covers `fr`, `en`, `es`, `de`.** A key must exist in all four. Displayed strings never use
infrastructure vocabulary ("dashboard", "tableau de bord", "stack"); a test enforces this over the
dictionaries' values.

**A check that runs on someone else's error path must not become the error.** Detection that threw
replaced the server's real message on screen; reconciliation that threw made a live subscription
read as off. Both now sit in their own guard.

## Deployment

`docker compose` on this server, published to GHCR by `.github/workflows/docker.yml`. The
Dockerfile runs `npm test` before `npm run build`, so a manual `docker compose build` is gated even
when GitHub is not involved. `./data:/app/data` is the only writable volume; the media root is
mounted read-only and belongs to Radarr/Sonarr.
