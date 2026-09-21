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

The suite writes into a throwaway `DATA_DIR` (`vitest.config.ts`): the gate mounts the whole
repository, `data/` included, and tests calling `logError` used to append Vitest mock errors to
the production `server.log`. A test fails if that isolation disappears.

`set -e` and no pipes: `npm test | grep` swallows the exit code, and a red test has been pushed
that way before. Read the gate's exit status before committing.

Tests default to the `node` environment; a component test opts into jsdom with a
`// @vitest-environment jsdom` docblock on its first line. `clearMocks` is pinned to `false` in
`vitest.config.ts` — that is Vitest 4's default, kept deliberately when moving to 5 so that no
test quietly changed meaning; flipping it is a decision to take by reading the tests it affects.

**Two benches sit beside the suite, both skipped unless given a file.** `bench.spec.ts` checks
what the remuxer *produces* (bytes, to be decoded by ffmpeg and compared against ffprobe);
`cout.spec.ts` measures what it *costs* — reads, bytes and milliseconds for the header, the open,
the first segment and a seek. The second answers "why is it slow" without guessing: it established
that launching is bound by bytes, not by CPU, and its header carries the numbers measured on this
library.

**Diagnose against the running container rather than reasoning in the dark.**
`docker exec cine-app node -e '...'` has every service URL and API key in its environment, and
`data/logs/player.log` holds what each viewer's player reported about itself — path taken,
fallbacks, browser, file. Several bugs this repository has fixed were found there and nowhere else.
`player.log` records `start`, `fallback`, `network`, `rebuild`, `error`, `stop` **and `audio`** —
the last one added on 2026-09-20 because a track change was the one costly gesture leaving no
trace, and the `rebuild` lines that look like it are network recoveries. It carries the elapsed
time, both tracks described, whether the sound was copied or re-encoded, and `applied` — a track
the browser refuses leaves the previous one playing, and without that field a refusal reads as
slowness.
`data/logs/server.log` is its counterpart for the server's own errors, with the stack the console
line omits: `docker logs` dies with the container, which is recreated on every deploy — several a
day — so an error a viewer hit in the evening was gone before anyone went looking. Since
2026-09-21 it also receives the **browser's** errors (`scope: "client"`, sent by
`reportClientError` from every error screen, every `ErrorBoundary`, `window.onerror` and unhandled
rejections; signed-in accounts only). Before that, a crash on a phone left nothing anywhere, and
the boundary around the root player made a film vanish without a word. The same day `stop` began
to be sent — declared from the start, emitted by nothing: 444 `start` and not one `stop`, so a
film watched to the end and one abandoned after thirty seconds read the same. Both files are one
JSON object per line, rotated at 5 MB (`src/lib/logFile.ts`), and read with `tail`/`jq`.

## Architecture

**`src/proxy.ts` is the single gate.** Next 16's "Proxy" (formerly middleware), always on the Node
runtime — so it can call `verifySessionFull`, whose SQLite revocation check is impossible under
Edge. It owns the public-path list (shared with the client through `src/lib/publicPaths.ts`), the
guest write whitelist, `308` redirects for addresses that moved (`/player`, `/cinema` → `/`),
sliding session refresh, and the `x-session-expired: 1` header. **It is that header's only
emitter**: a bare 401 may come from an upstream service whose key is wrong, and only this header
means the viewer's own session is gone.

It also owns `ACTIFS_PUBLICS`, **the files served without a session** — the manifest, the service
worker, the offline page, the icons, and `/splash/`. These are what a browser or an operating
system fetches on its own, outside any page, with no reason to present a cookie. Forgetting one
does not look like a bug: `/splash/*` was missing for a day and every launch image answered `307`
to `/login`, so iOS silently fell back to its own background and nothing appeared in any log.
**A redirect is not a failure — it leaves no trace.** When something served over HTTP behaves
oddly, ask what the URL actually returns before reading any more code. The list is written twice,
because Next demands a literal string for its `matcher`; a test compares the two.

**API routes are thin** (~59 lines average). Logic lives in `src/lib`:

- `src/lib/clients/*` — one module per upstream service. Jellyfin is authenticated through
  `src/lib/jellyfinAuth.ts` and nowhere else: `Authorization: MediaBrowser Token="…"`. The old
  `X-Emby-Token` header is refused by default from Jellyfin 12 onwards, and a test forbids it
  reappearing anywhere in `src/`.
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
`fallToStable` hands over rather than closing — unless `PLAYER_SERVER_FALLBACK=false`, where there
is no server-side player to hand to and the same call surfaces a clean playback error instead.

**A refusal that names the player, not the path, must stop the chain.** `tryRemux` returns either
a plain string — "not by this route, try the next" — or `{ reason, server: true }`, which means no
local path can carry this file at all and the server player is the answer. Two cases reach it:
Dolby Vision with no HDR10 base layer, and audio no decoder anywhere can produce (TrueHD, the only
such family here — `@mediabunny/truehd` does not exist). Both were found the same way: the log
showed the canvas path being opened, failing on something already known, and only then falling
back. Use the **same predicate** that refuses at runtime, never a neighbouring one —
`playableAudio` means "cannot cross MediaSource", which is true of an AAC in a browser that
cannot encode, and that shortcut would have handed working files to the server.

**Track names are written once, in `src/lib/trackLabel.ts`** — by both players, and by the
`<track>` elements the browser and the Apple TV display in their own pickers. The form is fixed:
*language — [remarkable codec] — channels*, and *language — type* for subtitles. What it leaves
out is as deliberate as what it keeps: ordinary codecs are silent (AAC, Dolby Digital, Dolby
Digital+ are 949 of 1 097 tracks here — naming them lengthened the label until it was cut on
screen and departed nothing); channel counts are only named where unambiguous (1.0, 2.0, 5.1,
7.1 — 99.7 % of this library); regional variants join the language (`VFQ` → "Français
(Canadien)") rather than trailing in a bracket. A bracket appears **only** when two tracks would
read identically, and then it carries the raw title — *2001* has two English 5.1 E-AC3 tracks
that are two different masters. `Intl.DisplayNames` gives the language names in all four
languages, so there is no dictionary to keep.

**Which audio track is opened, in order: the language asked for (100), then what this path can
carry (20), then the most channels, then the file's own default flag, then file order.** The flag
used to be worth points *in the score* and so outranked channels, which opened *2001* on its
stereo track while the 5.1 sat next to it. And the track is chosen **before the pipeline is
built** — it used to be built on the file's default and switched a second later, which cost 429 ms
on a copied file, 1 784 ms on DTS and 7.9 s on the slowest device in the house. The opening choice
and the screen's own `chooseAudioTrack` must agree, or that switch simply comes back.

**A Matroska track with no `Language` element is English.** The spec says so, and many muxers rely
on it — *1917* declares `fre` on its French track and nothing on its English one. Reading that as
`null` made every such film unreachable for an account set to English, subtitles included; the
giveaway was that Jellyfin reported `eng` for the same track. When two readings of one file
disagree, that gap *is* the bug.

**A subtitle is forced when the flag says so — or when only its title does** (51 of 392 here).
Its type comes from flags and not from text: 459 of 855 tracks have no title at all.

## Conventions

**Comments carry the why and the original symptom.** 17% of source lines are comments, and they are
how a decision's history survives. Match that density; a comment restating the code is worse than
none.

**The same decision is made in several places, and they drift.** `CinemaClient.tsx` /
`mobile/CinemaMobileClient.tsx`, `CinemaMovieDetail` / `CinemaMobileDetail`. A fix on one side is
half a fix — and a guard present on one side and missing on the other has cost five failed attempts
at a single bug. Better than fixing both: give them one shared function so they cannot diverge again.
**`DECISIONS.md` is the register of these decisions** — for each: the rule, the one function that
carries it, its callers, its tests, and what differs *on purpose*. Look a decision up there before
touching it; add one there when you find it. `decisions-partagees.test.ts` fails if a copy comes
back.

Having two interfaces is not the debt — desktop and mobile are genuinely different products here
(focus-following hero and arrow-key grid on one side, flick rows and inline hero actions on the
other), and merging them would spoil both. The debt is duplicated *decisions*, and the axis is not
screen size: a resume fix landed in the movie sheet and its mobile twin, and missed
`CinemaSeriesDetail` — film versus series, not mobile versus desktop. Count the places that make
the decision, not the layouts.

**`resumeAt: 0` means "from the beginning"; omitting it means "ask the server".** They are not
interchangeable, and treating them as such cost two opposite bugs in one day. The old server-side
player only honoured a truthy value, so callers took the habit of leaving the field out to restart;
the native player reads `session.resumeAt ?? playbackState?.resumeSeconds`, where an absent field
names exactly the position you wanted to discard. Every caller that knows the position passes a
number — zero included. Absence is reserved for a caller that genuinely does not know yet
(`resumeKnown` on `PlayButton`), and it defers to the server rather than asserting a start.

**Ask the browser, never a list.** `MediaSource.isTypeSupported`, real `SourceBuffer` probes,
`AudioEncoder.isConfigSupported`. But ask the question you actually mean:
`canPlayType("application/vnd.apple.mpegurl")` answers "can you play HLS", not "are you WebKit" —
Chrome on Android says yes to the first and no to the second. `isWebKitEngine` is for engine
defects; probes are for capabilities.

**Anything written into an MP4 box that a reader may compare against another box must come from the
file, not a constant.** Chrome rejects a whole init segment over a FLAC sample size that disagrees
with STREAMINFO; Safari does not check. The forgiving browser is not the specification.

**A `AudioData` is in the standard channel order — the encoder converts, you do not.** L R C LFE
Ls Rs Lrs Rrs, whatever the destination codec orders its own bitstream by. Permuting into AAC's
order (centre first, LFE last) before `AudioEncoder` applies the mapping twice and sends the whole
dialogue into one ear; it was written from the format's specification, held for nine days, and was
caught only by a viewer on Chrome — everyone else here is on Safari, where E-AC3 is carried
untouched and none of this code runs. **And the channel count does not name the layout**: five
channels is a 5.0 in one file and a 4.1 in another, seven is a 6.1 whose fifth rank is a back
centre. The decoder gives the count and nothing else (mediabunny exposes no layout), so anything
outside 1/2/3/6/8 keeps its first three planes — L, R, C, the only ranks every layout agrees on —
and the rest is dropped rather than guessed.

The way both were settled is the point: decode the real file in Node with the same decoder the
browser uses, and compare its per-channel RMS against `ffmpeg -filter:a astats` on the same
seconds. They matched to two decimals, which said the decoder was never the problem. Reasoning
about someone else's channel order has now failed twice here; measuring took ten minutes.

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
  The rest of the catalogue is deliberately frozen — but **not because it is heavy**. Measured on
  2026-09-20 over 720 films: 623 KB raw, **118 KB gzipped**, of which the synopses alone are 76%
  of the compressed size (without them it is 28 KB, since URLs and repeated structure compress to
  nothing while prose does not). The number to quote is the compressed one; an earlier note said
  "1.4 MB" and that raw figure made the payload look like a bottleneck it is not. It is half the
  JavaScript bundle. The freeze is about not re-asking a question whose answer changes daily, not
  about bytes — and splitting the catalogue into a "first screen" payload would buy nothing.
- **Closing the player leaves four views stale, and it revalidates all four**
  (`refreshAfterPlayback`): the resume feed, next-up, the title's own progress, and — through a key
  filter, since a close only knows the *episode* id — every series episode list. It waits for two
  things first, and neither is optional: the stop report, or it re-reads the value it meant to
  replace; and the screen being free, because a paused SWR query is dropped, not deferred.
- **A TMDB or person sheet covers the library stack, it does not replace it** — keep the stack
  rendered and inert. And a sheet is never behind itself: a discover push keeps the current `film`
  in the address.
- **Sheets and panels leave through `useDelayedClose`**, which holds the address for the length of
  the animation. Anything closing by changing the route directly cuts its own animation short.
- **The HEVC header sent to the browser is the one the pictures justify.** *Dirty Dancing*
  (2026-09-21) declares one PPS in its Matroska `hvcC` and carries another, same id, in its first
  picture — the one every slice uses. ffmpeg reads parameter sets in-band and plays it; Safari,
  handed `hvc1`, reads them **only** from the header, decoded with the wrong PPS, lasted a few
  seconds, then "Media failed to decode" — three rebuilds, then the server player.
  `withTrueParameterSets` (`hvcc.ts`) rebuilds the header from the first picture's VPS/SPS/PPS
  when they disagree, for both paths; "En-tête vidéo" in the technical panel says when it did.
  The same file also stamps some pictures with another's instant; `PresentationDeduper`
  (`decodeOrder.ts`) moves them 1 ms past the one they hit, since MediaSource removes the buffered
  picture a new one covers. That was real but was **not** the cause — the first fix shipped
  targeted it, and the film still broke. When a fix does not hold, the diagnosis was incomplete.
- **A pathological file is the normal case here.** The library holds six-audio-track files mixing
  FLAC / AC-3 / DTS / TrueHD at 1, 6 and 8 channels, 24-bit FLAC, mono defaults, Dolby Vision 4K.
  Test player changes against `The Exorcist (1973)` before believing them.

## The sheet lifecycle

Six pieces, wired by hand into every sheet, and nothing but this section declares the contract
between them. Every UI bug found on 2026-09-16 lived in the wiring, never in a piece.

- `useExitDelay` (parent-driven) keeps a screen mounted through its exit; `useDelayedClose`
  (self-driven) delays the close callback instead. A sheet uses one or the other, never both for
  the same decision.
- `arrivedByBack()` is read **once, at mount**, and suppresses the entry animation on a Back.
- `useHideOnScroll` drives the phone's floating bar, and is disabled while a sheet covers it.
- `useSwipeToDismiss` is the drag-down gesture; its pointer handling belongs to
  `usePointerCapture` and nowhere else.
- `cinemaClose` is the only way out, and only one of its `history.back()` is ever in flight.

Four rules, each of which cost a real failure:

1. **A different title is a different sheet.** Give it a `key`. A reused instance freezes
   `arrivedByBack`, keeps the previous title's scroll and focus, and lets a close started before
   the swap land on the screen after it.
2. **A screen on its way out has no opinion.** No key handler, no pointer events. Two panels are
   mounted during a switch, and both listening to Escape stepped back twice on one key.
3. **A gesture never outlives its element.** Capture through `usePointerCapture`, which releases
   on unmount — a capture held by a detached node stops WebKit routing pointers to the page at
   all: everything painted, nothing responding.
4. **Closing is a request, not a fact.** The address changes a tick later, so nothing may assume
   it already has.

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
  the version history in that file's header says why each bump happened. Since v12 the app's code lives in
  per-build caches (`cine-static-<build>`, the build number rides on `/sw.js?v=`): the current
  generation and the previous one, an unchanged file carried over without a download — so a
  deploy no longer needs a bump, and the cache no longer grows. Images are left to the HTTP cache.
- **`SESSION_SECRET`.** Startup throws on the default value rather than warning — a forged admin
  session is not a log line.

## Deployment

`RUNBOOK.private.md` has the operator's checklist. Push to `main` triggers the GHCR publish, whose
first job is the same verify workflow. `./data:/app/data` is the only writable volume — SQLite,
the image cache, and the player log all live there. Never commit `.env`, `data/`, or `*.db*`.
