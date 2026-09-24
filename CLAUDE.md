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
| Cinema | `/` — route group `(player)` | Every Jellyfin account |
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

**Six benches sit beside the suite, all skipped unless given a file or a library root.**
`truehd-bench.spec.ts`
decodes a real TrueHD track through the player's whole chain and prints each channel's level, to
compare with `ffmpeg astats` — the only proof of that decoder, since no synthetic TrueHD can be
made. `bench.spec.ts` checks
what the remuxer *produces* (bytes, to be decoded by ffmpeg and compared against ffprobe);
`cout.spec.ts` measures what it *costs* — reads, bytes and milliseconds for the header, the open,
the first segment and a seek. The second answers "why is it slow" without guessing: it established
that launching is bound by bytes, not by CPU, and its header carries the numbers measured on this
library. The other three survey rather than prove: `audit.spec.ts` asks every file in a
library the player's questions, `subs.spec.ts` lists its subtitle codecs, and `raps.spec.ts`
measures what a seek costs in one file.

**Diagnose against the running container rather than reasoning in the dark.**
`docker exec cine-app node -e '...'` has every service URL and API key in its environment, and
`data/logs/player.log` holds what each viewer's player reported about itself — path taken,
fallbacks, browser, file. Several bugs this repository has fixed were found there and nowhere else.
`player.log` records `start`, `fallback`, `network`, `rebuild`, `error`, `stop`, `seek`, `stall`
(a playing clock stuck for 5 s, with buffers, recoveries and the last 20 s of trace) **and `audio`** —
the last one added on 2026-09-20 because a track change was the one costly gesture leaving no
trace, and the `rebuild` lines that look like it are network recoveries. It carries the elapsed
time, both tracks described, whether the sound was copied or re-encoded, and `applied` — a track
the browser refuses leaves the previous one playing, and without that field a refusal reads as
slowness.
The server player writes there too since 2026-09-23 (`player: "serveur"`, `src/lib/serverPlayerLog.ts`):
its `start`, a refused negotiation or a missing first picture as `error`, and **`cast`** once a
television has actually taken the route. It used to write nothing, so a handover to it read as the
end of the session, and a television stuck loading was indistinguishable from one playing — an
AirPlay stall was diagnosed from the reverse proxy's access log instead. Since 2026-09-24 its lines
also carry a `session` id and the `agent`: without them they were rebuilt "the old way", each
`retry` a separate session with no device — a clean witness that exonerated failing titles in the
activity page's file-or-device diagnosis. A handover to it *to cast* is logged as `fallback` with
`cast: true`, and is not counted as a failure.
`data/logs/server.log` is its counterpart for the server's own errors, with the stack the console
line omits: `docker logs` dies with the container, which is recreated on every deploy — several a
day — so an error a viewer hit in the evening was gone before anyone went looking. Since
2026-09-21 it also receives the **browser's** errors (`scope: "client"`, sent by
`reportClientError` from every error screen, every `ErrorBoundary`, `window.onerror` and unhandled
rejections; signed-in accounts only). Before that, a crash on a phone left nothing anywhere, and
the boundary around the root player made a film vanish without a word. The same day `stop` began
to be sent — declared from the start, emitted by nothing: 444 `start` and not one `stop`, so a
film watched to the end and one abandoned after thirty seconds read the same. Since 2026-09-23
every native-player line carries a `session` id (a rebuild rewrites `start`, so lines are joined
by that, never by account and time), and `stop` is the session's summary: `watched`, `waits` /
`waitedMs` / `longestWaitMs` (stops of 250 ms or more mid-playback — `stall` only fires at 5 s),
`seeks` / `seekWaitMs`, `audioSwitches`, `backgrounds` / `backgroundMs` / `backgroundRebuilds` (a
return from the background that finds the source closed also writes a `rebuild` line with `hiddenMs`),
and since 2026-09-24 `evictions` / `evictionsAhead` (ranges ManagedMediaSource dropped on its own,
heard through `bufferedchange` — the player's own removals are not counted; one ahead of the head
is read again at once). A `seek` line carries `ranges`, the
element's buffered ranges when the viewer asked, and its trace the two buffers separately. A page iOS kills in the background never gets to send
it, so the summary is kept in `localStorage` while the session lives (`src/lib/unsentStop.ts`)
and sent on the next launch as `why: "lost"` with `lateByMs`; the weekly reading keeps the last
line per `session`. Both files are one
JSON object per line, rotated at 5 MB (`src/lib/logFile.ts`) — `player.log` keeping five archives
(`.1` newest … `.5`), `server.log` three — and read with `tail`/`jq`; `logGenerations` lists a log
and its archives oldest first for any reader.
`data/logs/auth.log` (since 2026-09-24) records sign-ins, refusals, sign-outs, closed sessions and
refused tokens, with device and address; `data/logs/notifications.log` records every push sent,
with what happened to it per account (delivered, failed, subscription removed, turned off). Both are
written by `src/lib/eventLogs.ts` and read by the activity panel like the others.
**Reports** (« Signaler un problème », `src/lib/reports.ts`) freeze a snapshot of the author's logs
when sent (`src/lib/reportLogs.ts`) — the logs rotate, the ticket must stay readable. Their paths
come from one tree, `src/lib/reportTaxonomy.ts`, read by both the wizard and the route; screenshots
live in `data/reports/<id>/`, the original kept beside a WebP made by `sharp`.
`data/logs/bench.log` holds the device test bench's results — one line per film, failures with the
player's trace — started by an administrator from the cinema's Account panel (DOC-TECH "Device test
bench"). **The player lines a bench causes do not go to `player.log`**: any line carrying `bench`
is written to `data/logs/bench-player.log` (same format, same cleaning, two archives). A full
bench used to rotate the previous day's viewers out of `player.log`, and the bench plan — which
picks its films from that log — counted the bench's own stalls as a viewer's.

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
One local path — remux → native `<video>` — and the server player when it cannot carry a file.
Every file goes through it, MP4 included: `mediaFile.ts` reads Matroska or MP4 into the same
description, and a good container does not mean everything in it plays natively (there used to be
a "direct play" path for MP4 — silent E-AC3 on Chrome, no track menus, no embedded subtitles).
`PlayerHost` chooses between the native player and the legacy server-transcoding one;
`fallToStable` hands over rather than closing — unless `PLAYER_SERVER_FALLBACK=false`, where there
is no server-side player to hand to and the same call surfaces a clean playback error instead.

**A refusal is a named error, and the server player is its answer.** `tryRemux` returns the
opened remuxer or a string saying why it cannot carry the file; `choosePlaybackPath` throws it as
`Aucun chemin de lecture disponible pour ce fichier. remux : …`, and the host hands the file over
(`fallToStable`) — except a network failure, rethrown as such, which gets the "connection lost"
screen instead. There was a second local path, a WebCodecs → canvas player, tried before the
server; it was removed on 2026-09-24 (`docs/lecteur-canvas.md`, tag `lecteur-canvas-final-2026-09-24`)
after ten sessions in three weeks, all tests, each ending in the same fallback a second later. It
also forced every refusal to say whether it meant "not by this path" or "not by this player" —
twice the log showed the canvas opened only to fail on something already known (Dolby Vision
without a base layer, MP2). That distinction is gone with it. Keep the refusal strings exact —
they are what the activity page's file-or-device diagnosis groups by — and keep the **same
predicate** that refuses at runtime: `playableAudio` means "cannot cross MediaSource", and
`audioDecoderExists` only names the MP2 case more precisely in the log.

**TrueHD is decoded by FFmpeg's own decoder, compiled to WebAssembly and committed**
(`src/lib/webcodecs/truehd/truehd-wasm.mjs`, 466 KB). `tools/truehd-wasm/build.sh` rebuilds it
reproducibly — pinned FFmpeg, checked SHA-256, pinned emscripten — and exists so nobody has to take
the file on trust. It runs on the main thread, a quarter-second batch at a time with a real yield
to the browser between batches — and in Node, where `truehd-bench.spec.ts` compares it with ffmpeg
channel by channel. Four things it cost to learn: FFmpeg's `mlp_parser` loses sync when started
mid-stream — no sound after every seek — so each Matroska block goes to the decoder whole;
FFmpeg's TrueHD *encoder* (6.1 to 8.1) writes streams its own decoder rejects, so there is no
synthetic fixture and the proof is the bench; emscripten's Node variant imports `module`, which
breaks Next's browser build, so the module is built for web and worker only (Node runs it anyway);
and **Turbopack does not compile `new Worker(new URL("./x.worker.ts", import.meta.url))`** — it
copied the TypeScript source into `static/media` as-is, a worker that would never have started.
The gate and the build both pass on that; only reading what the build emitted shows it. Once TrueHD
became playable, per-file audio unification made the Dolby track of 19 mixed films re-encoded too —
which is what per-track delivery (below) undoes.

**Track names are written once, in `src/lib/trackLabel.ts`** — by both players, and by the
`<track>` elements the browser and the Apple TV display in their own pickers. The form is fixed:
*language — [remarkable codec] — channels*, and *language — type* for subtitles. What it leaves
out is as deliberate as what it keeps: ordinary codecs are silent (AAC, Dolby Digital, Dolby
Digital+ are 949 of 1 097 tracks here — naming them lengthened the label until it was cut on
screen and departed nothing); channel counts are only named where unambiguous (1.0, 2.0, 5.1,
7.1 — 99.7 % of the library measured); regional variants join the language (`VFQ` → "Français
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

**A `AudioData` is in the standard channel order — Chrome's encoder converts, Apple's does not.**
Apple's AAC encoder (AudioToolbox) is handed a channel *count* and no layout — by WebKit, and by
Chrome on macOS too — so on an Apple system (Safari, every iOS browser, Chrome on a Mac:
`appleAudioToolbox()`) the planes must already be in AAC order — centre first, LFE last
(`APPLE_AAC_ORDER`) — and nothing above six channels is sent (a 7.1 is folded to 5.1; AAC has no
true back-surround 7.1). Both halves were learned by ear: "Titanic" on an iPhone (07/09) and
Braveheart's TrueHD 7.1 on an iPhone (21/09) had the voices on the right; a Chrome viewer (19/09)
had them on one side once the permutation was applied everywhere. The 19/09 fix measured our
*decoder* and concluded about the encoders — do not settle this again without an ear on each
browser. Firefox's Opus encoder converts too (measured 21/09 with tagged tones decoded by ffmpeg);
the Vorbis permutation it was given put the centre on the right. DOC-TECH "Channel order" has the
table, what is still unmeasured, and the method. L R C LFE
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
- **A Matroska block is not always a picture.** *Dirty Dancing* (2026-09-21) slips, before three
  of its CRA keyframes, a block holding VPS/SPS/PPS and a Dolby Vision RPU and **no slice** —
  timed as a picture, at the instant of a real one — and the picture just before it is the only
  one with no RPU: the muxer cut the access unit in the wrong place. Handed to Safari as a
  sample, it closed the MediaSource at each of those keyframes; a rebuild *starting* on the
  keyframe never saw the block, so each one played until the next. `strayUnits` puts the units
  back (RPU and other suffix units onto the picture before, parameter sets onto the one after),
  in the remuxer. Three fixes shipped before it chased what the block
  *caused* — duplicate instants, a "wrong" header, a mid-stream init segment — and were reverted
  once the cause was found; Safari reads HEVC parameter sets in-band perfectly well (the film
  played its first 2.5 s on a header that disagreed with its pictures). When a fix does not hold,
  the diagnosis was incomplete: list the NAL units of every block around the failure, and check
  each picture has exactly one of everything it should.
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

- **The reverse proxy.** It is shared with other sites on the same host. The dev stack exists
  on its own port precisely so it never has to be touched.
- **Media files.** `/mnt/media/video` is mounted read-only and belongs to Radarr/Sonarr. Anything
  writing there goes through them.
- **The WebKit reload in `changeAudio`** (`PlayerHost.tsx`). WebKit cannot open a second HLS session
  in one page; every other angle was tested and ruled out, and a full reload is the only thing that
  works. Its guard, on the other hand, was wrong for years — see `isWebKitEngine`.
- **Every audio track change rebuilds the player** (`RemuxPlayback.requestAudioTrack`,
  `ExperimentalPlayerHost`). No live buffer ever changes track: every attempt at surviving a codec
  change in one turned out to be a guess about someone else's decoder (Safari took a buffer swap
  and played no sound), and the same-format change "in the buffer" — removed on 2026-09-22 — was
  slower than a rebuild on every engine and left a lasting A/V offset on WebKit. The only refusal
  is a file with no index past its first second (`noIndexAudio`). Delivery stays behind `perTrack`:
  each track in its best form (default), or `perTrack: false` for per-file unification — an
  option passed to `Remuxer.open` (`RemuxOptions`, with the HDR light cap), never a module
  setting, so two live pipelines cannot read each other's. See DOC-TECH "Audio delivery".
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
