# The native player — technical reference

Reference documentation for the playback engine that reads library files **without asking the
server for anything**: no transcoding, no stream negotiation, no HLS. The browser fetches the
`.mkv` over HTTP byte ranges and everything else happens in the tab.

Source: `src/lib/webcodecs/`, plus the routes and hooks listed in the [file map](#file-map).

It still opens a **Jellyfin session**, for the one thing the server has to know: what is being
watched and how far — see [Playback reporting](#playback-reporting).

## Contents

- [Scope and context](#scope-and-context)
- [Path selection](#path-selection)
- [The remux pipeline](#the-remux-pipeline)
  - [`byteSource` — HTTP range reads](#bytesource--http-range-reads)
  - [`ebml` / `matroska` — header and index](#ebml--matroska--header-and-index)
  - [`decodeOrder` — reconstructing decode times](#decodeorder--reconstructing-decode-times)
  - [`mp4Muxer` — writing the container](#mp4muxer--writing-the-container)
  - [`remuxer` — segmentation and delivery](#remuxer--segmentation-and-delivery)
  - [MSE delivery](#mse-delivery)
- [Audio](#audio)
- [Subtitles](#subtitles)
- [Track selection and account preferences](#track-selection-and-account-preferences)
- [Playback reporting](#playback-reporting)
- [User-facing messages](#user-facing-messages)
- [Diagnostics](#diagnostics)
- [Verification harness](#verification-harness)
- [Known limitations](#known-limitations)
- [File map](#file-map)

---

## Scope and context

The Cinema interface is the application: `/` serves it, management lives at `/gestion`. The two
addresses the player used to have — `/cinema`, then `/player` — answer a permanent redirect to `/`.

**Two players coexist.** The server-side one (Jellyfin/HLS) remains, and takes over when this one
declines: a file it cannot remux, a browser that refuses the codec, or an account that asked for
the legacy player in its settings. `PlayerHost` owns that switch, and `fallToStable` hands over
rather than closing.

The design goal is the cost model. A server transcode is expensive, starts slowly and degrades the
image; here the file leaves the disk as it is. That is why in-app playback (`PLAYER_ENABLED`) is on
by default: the ordinary path costs the server nothing beyond serving bytes.

**The safety net is optional.** `PLAYER_SERVER_FALLBACK=false` removes the server-side player from
the install: `PlayerHost` then mounts this one unconditionally, the per-account legacy option is
neither offered nor honoured (enforced in `/api/jellyfin/direct/[itemId]`, not only hidden), and
`fallToStable` stops handing over — it writes the reason to the log as an `error` and puts it on
screen. Giving up then means a plain playback error rather than a transcode. While the flag's
answer is still in flight it counts as "there is one": the only caller that can give up that early
is the path selector's refusal, and being wrong in that direction plays the film through the
server instead of showing an error, never the reverse.

---

## Path selection

`pathSelector.ts` classifies the file and **always states its reasoning**. There is no silent
downgrade — a player that drops a level without saying so looks like a player that works.

| Path | Mechanism | When |
|---|---|---|
| **1. Remux → native `<video>`** | Matroska repackaged into fragmented MP4 in the browser, fed to a real `<video>` through MediaSource | The normal path |
| **2. WebCodecs → canvas** | Software decode frame by frame, canvas render, hand-held audio clock, HDR→SDR conversion in a shader | The browser refuses a codec in MediaSource but can decode it another way |
| **3. Direct play** | The file is handed to the browser untouched | The file is already MP4 |
| **4. Explicit refusal** | Named codec, stop | None of the three can carry it |

**Path 1 is nearly free.** Matroska samples are already exactly what MP4 wants — length-prefixed
HEVC/AVC access units, AC-3/AAC frames as they are. Only the packaging differs. No pixel and no
audio sample passes through JavaScript: the browser decodes in hardware, composes the image itself,
drives its own audio clock, and **displays HDR natively**. Building one group of pictures takes
15–56 ms, against ~2 500 ms to download it.

**Path 3 is detected on the file's own bytes** (`ftyp`), never on what the server calls it:
Jellyfin names a container after the ffmpeg demuxer that reads it, so an ordinary MP4 comes back
as `mov,mp4,m4a,3gp,3g2,mj2`.

**Path 4** in practice covers the library's `.avi` files, in MPEG-4 ASP and MP3, which no browser
decodes.

---

## The remux pipeline

```
byteSource ──▶ ebml/matroska ──▶ sampleReader ──▶ remuxer ──▶ mseSource ──▶ <video>
 HTTP ranges     header, tracks,    raw samples,    fragmented    MediaSource
                 index              decode order    MP4
```

### `byteSource` — HTTP range reads

Range reads in **1 MiB chunks**, cached (48 chunks, ~48 MiB). Elements known to be small (Tracks,
Cues) are read in one request and addressed in memory by absolute offset, because parsing a
container field by field otherwise means one read per field — 129 000 of them for a film with
15 000 index points.

**Request shape dominates latency, not work.** Measured on a phone: 4.45 s to first frame, 2.6 s of
which is reading the first group of pictures, for 15–56 ms of remuxing. Four consequences, all of
them structural:

- **Six-chunk readahead**, never one. One chunk is a relay rather than a pipeline: every megabyte
  paid for its own round trip before its first byte. It is never speculative — the fill loop wants
  30 s of lead, about 20 MB.
- **Chunks of one read are requested together**, so a read straddling four chunks costs one round
  trip rather than four.
- **Both ends of the file are requested at open**, in parallel: the header at the start, the index
  wherever the Cues were written (the very end, for a streaming-oriented file). The parse result is
  **cached under the file name**, so reopening the same file — or rebuilding after the platform
  dropped the source — does not pay for it again.
- **`warm(offset)` on seek.** The index knows which cluster a seek lands in several milliseconds
  before the parser asks for its first byte. Without warming, every seek began with a single
  request on an idle link; on a dense 4K file, 4 MB must arrive before the first frame, for ~12 ms
  of remux work. Index back-off benefits from the same mechanism, since it targets a colder region
  still.

Retries: 4 attempts, with 60 s of patience while the network is offline.

### `ebml` / `matroska` — header and index

Header, tracks and index only. **Clusters are never walked**: on a 40 GB file that would mean
reading the whole thing, when the index already says where each keyframe lives.

**An index point carries one set of positions per indexed track.** Taking the first one yields the
place where *audio* can resume, almost never a keyframe — so the track's own position must be
selected explicitly.

A file with no Cues can be played but not seeked, and says so.

### `decodeOrder` — reconstructing decode times

HEVC and AVC **reorder**: a B-frame is decoded after the frames it references but shown between
them. Matroska stores only *presentation* time; MP4 requires both.

The reconstruction rests on one property: samples are stored in decode order, and **the set of
decode times of a group equals the set of its presentation times, sorted**. Sorting a group's
presentation times and dealing them out in decode order therefore recovers the timeline exactly,
for any reorder depth, without knowing anything about the codec.

**This holds only for a group closed by keyframes**, where reordering cannot cross. `I P B b b`
with presentations `0 4 2 1 3` yields `0 1 2 3 4`; the first three alone sort to `0 2 4` and shift
the P-frame by one frame. Fragment splitting therefore happens **after** this computation, never
before.

### `mp4Muxer` — writing the container

`ftyp`/`moov` for the initialization segment, `moof`+`mdat` per fragment. Two encoding rules that
are easy to get wrong and silent when wrong:

- A `trun` stores **no decode time beyond the first** — the rest are the sum of the durations. The
  duration written is therefore **the gap to the next decode time**, not the frame duration.
  Identical at constant frame rate, invisible until a 23.976 fps file.
- The bottom-right corner of the unity matrix is fixed-point **2.30**, not 16.16: 1.0 is
  `0x40000000`.

Timescale is 1 000 000 (microseconds).

### `remuxer` — segmentation and delivery

Reads samples, computes the timeline per group, splits into fragments, produces segments and
subtitles.

| Unit | Rule |
|---|---|
| **Segment** | Cut on a random access point, at least 2 s after the previous one |
| **Fragment** | Bounded at **1.2 MB / 60 samples** (CMAF chunks) |
| **Subtitles** | Lines of **every** text track collected in one pass |

**Media is delivered as it is read, not when the group is complete.** A frame read later can only
displace a frame already held within the **reorder depth** — a handful of frames; beyond that,
what precedes is settled. The depth is measured on the stream's first group and reused for all
subsequent ones, including after every seek; before there is enough to measure, a generous estimate
(64 frames) stands in. In practice a seek delivers 2.1 MB and then ~1 MB per 2.4 s of media,
instead of 6.5 MB in one block.

Collecting **all** text tracks in a single pass costs nothing — they cross the reader anyway — and
makes a language change a filter rather than a re-read.

#### Random access points are verified, not trusted

Matroska marks a block as a keyframe when it references no other block. An encoder can emit an
intra frame that satisfies this while **frames decoded after it reference frames from before**. On
a real file, 14 of 193 announced keyframes are `TRAIL_R` rather than access points. Starting there
produces a decode that cannot complete: ffmpeg reports `Could not find ref with POC -35` and
continues without those frames; Safari answers `media failed to decode` and closes the
MediaSource.

The remuxer therefore reads the first slice NAL unit (skipping the prefix SEI) and accepts only
`BLA`, `IDR` or `CRA` — `isRandomAccessPoint` in `codecConfig.ts`. When the point it finds is past
the target, it **backs up in the index** (12 s at a time, 3 times at most) rather than landing
late. Cost: one seek in eighty on the affected file re-reads a few seconds of frames nobody sees.

### MSE delivery

Four modules, split along the nature of the evidence each one holds:

| File | Subject |
|---|---|
| `mseSupport.ts` | What the browser **accepts** — asked, never assumed |
| `bufferQueue.ts` | **One operation at a time** per buffer |
| `playbackGuard.ts` | **The element's clock**: pause, resume, landing, picture hold |
| `mseSource.ts` | **The bytes**: buffers, filling, seeks, recovery |

The guard never speaks of bytes; it decides *when* the playhead should move, and the source remains
the only thing that moves media. The source hands it a narrow view of itself (`GuardHost`): four
reads and two verbs.

**Buffering.**

- MediaSource allows only one operation at a time per buffer; everything goes through
  `BufferQueue`. Unserialised call sites produce a fatal `InvalidStateError`.
- The fill loop targets **30 s of lead**, with an **8 s floor** fetched unconditionally. Obeying
  `ManagedMediaSource.streaming` without that floor leaves the buffer empty forever once the system
  says stop.
- When the browser refuses an append because the buffer is full, what is **behind** the playhead is
  evicted. At the very start of a film there is nothing behind it, so the **target drops** instead
  (75 % of what actually fits, floor 8 s) rather than dropping segments silently.

**Positioning.** The guard owns every decision about where the playhead sits:

- **Opening away from zero**: the remuxer is sent to the right place immediately, but the head
  **waits for media to arrive underneath it**. A `currentTime` set while only the init segments have
  been appended is a request WebKit accepts and never honours. A seek *during* playback has never
  had this defect — the media and the decoder already exist. A requested seek cancels the deferred
  open rather than adding to it.
- **Landing**: a seek that produces media past its target places the head **on that media** rather
  than on emptiness — as a media element does. **Opening a film is one of these**: a file with
  B-frames presents its first frame 210 ms after zero, so starting at 0 s starts on nothing.
- **Landing inside the media, not on its edge.** Sitting exactly at a range's first instant leaves
  the seek unresolved on iOS: the element declares itself playing, the head is on media, and the
  clock never moves. One frame inside is imperceptible and unambiguous.
- **Resumed start**: a pause arriving *before the first frame* of a requested playback is the
  element giving up, not the viewer pausing. When media finally arrives, the head is placed on it
  and playback re-requested, twice at most. A viewer's pause is respected.
- **Pause/resume**: the position is re-asserted **at the moment of the pause**, which flushes the
  audio queue while nothing is visible — iOS otherwise holds ~0.5 s of audio ahead of the hardware
  and dumps it on resume. Once only; re-asserting every 80 ms produces a skipping record.

**Recovery.**

- **Watchdog (250 ms)**: a head with nothing under it and nothing arriving is repositioned. An
  empty buffer is not a lost player — the element's ranges are the **intersection** of both
  buffers, so emptying audio empties them all.
- **Frozen clock (1.5 s)**: playing, head on media, seconds of lead, and the clock not moving. The
  inverse shape of every other stall, handled the same way — re-request the position, slightly
  further on. Three nudges of 0.08 s at most.
- **Source loss**: iOS reclaims media resources in the background and closes the MediaSource. This
  is a pipeline to rebuild at the current position, not a failure to report — up to three times.
- **The canvas path rebuilds too**, with the same machinery and budget, but only for a failure that
  occurs **after** the picture started moving. A file the device cannot decode fails before
  starting; retrying it is three spinners for the same answer.
- **The rebuild budget decays.** Three source losses an hour apart are not the failure the limit
  exists to stop: past three minutes without incident the counter resets. Otherwise a two-hour film
  exhausts its budget by accident and yields to the stable player mid-session.
- **Reactive picture hold**: Safari plays video **silently** when the audio buffer is empty at the
  head; Chrome stalls correctly. The picture is therefore held only if it actually advances without
  sound.

---

## Audio

`audioTranscode.ts`, with the decision made in `remuxer.ts`.

### Delivery

| Case | Treatment |
|---|---|
| The browser accepts the codec in MediaSource | **Copied as-is**, bit-exact |
| It refuses, but the track can be decoded | **Decoded and re-encoded** |
| Neither | Explicit refusal |

Software decoders: `@mediabunny/dts` and `@mediabunny/ac3` (libavcodec in WASM, ~1.5 MB and
~1.1 MB, lazily loaded).

### The replacement codec is chosen, not assumed

Both halves must hold: the browser must be able to **produce** the codec *and* **take it back** in
MediaSource. AAC first, Opus second.

- **Firefox does not encode AAC at all**, but encodes Opus in stereo *and* 5.1 and accepts it in
  MediaSource. Without the Opus fallback it loses the native path — and since it does not decode
  10-bit HEVC in WebCodecs either, it loses playback altogether.
- **iOS does not accept Opus** in MediaSource, but encodes AAC in 5.1.

### Channel order is codec-dependent

Three conventions meet here:

| | 5.1 layout |
|---|---|
| What the decoder returns (WAVE order) | `L R C LFE Ls Rs` |
| What **AAC** expects | `C L R Ls Rs LFE` |
| What **Opus** expects (Vorbis order) | `L C R Ls Rs LFE` |

Interleaved without permutation, planes keep their index and change meaning: centre — dialogue —
arrives at the index AAC reads as right. Folded to stereo by the browser, that is voices on the
right and music on the left.

`toCodecChannelOrder` permutes according to the **destination codec**. Three rules:

- **After the fold, never before** — `fold` reasons in decoder order.
- **Stereo and mono are untouched**, L and R being at the same index everywhere.
- **What cannot be described is not permuted** — quadraphonic, 5.0, an unknown codec. An unknown
  order left alone is a bet; an invented one is a mistake.

Verified by ear on AC-3, E-AC3, DTS and DTS-HD MA, in 5.1 and 7.1.

> Expected side effect: once the LFE is correctly labelled, the standard stereo fold **excludes**
> it. Before the fix it was taken for a surround channel and mixed in, so the sound is quieter
> afterwards. That is the correct behaviour, not a regression.

### One codec per file

**Mid-buffer codec transitions do not exist here.** If a file's tracks cannot all be delivered
as-is, **they are all re-encoded** — decided at open, and frozen for the life of the MediaSource.

All three ways of changing a live buffer's codec were tested on device:

| Approach | Measured result |
|---|---|
| `changeType` | Safari accepts, then `media failed to decode`, sometimes 6 s later. Closes the MediaSource. |
| Rebuild the MediaSource | Detaches the element; Safari does not come back. |
| `removeSourceBuffer` + `addSourceBuffer` | The API works, the result is inert: segments accepted, ranges growing, head advancing, **no sound**. The first seek closes the source. |

The third one's code is kept behind `TRUST_BUFFER_REBUILD = false` (`pathSelector.ts`) — one line to
flip the day a browser keeps its word.

**Accepted cost**: on a mixed-codec file, an AC-3 track that could have passed through intact is
re-encoded. It buys a language change that cannot break playback.

> `decoderConfig.description` is *specified* as the bare AudioSpecificConfig, and Chrome returns it
> that way — **Safari returns the whole `esds` contents**. Wrapping it a second time yields
> `mp4a.40.0` (the first five bits read are the `0x03` tag byte) and closes the MediaSource. The
> descriptor tree is therefore unwrapped, and what actually came out is read rather than what was
> asked for.

---

## Subtitles

**Internal text tracks** are collected in one pass by the remuxer (see above) and filtered by
language at display time. `subtitleMarkup.ts` strips markup, for internal tracks and external files
alike.

**ASS/SSA are rendered without their styling**: dialogue only — formatting, positioning and embedded
fonts are discarded. A deliberate trade: offering them plain beats denying subtitles to 218 files
because of their formatting.

**Bitmap subtitles** (PGS, VobSub) are not rendered, and are not offered in the menu rather than
appearing there inert. The affected files all have a `.srt` alongside, which is what gets offered.

### External `.srt` files

Nothing in a Matroska file names the `.srt` files in its folder; the server, which sees the folder,
is the only one that knows they exist. Measured on this library (672 films): 272 carry at least one
external text subtitle, and 95 have no text subtitle in the container at all — 88 of those are
covered by a file alongside.

- `/api/jellyfin/direct/[itemId]` lists them (`IsExternal`, text codecs only).
- They are numbered **negatively** (`-1 - index`), so they can never be confused with a track read
  from the file.
- They are fetched **when selected**, as WebVTT — Jellyfin converts, whatever the on-disk format.
- They are held **above the pipelines**, like the chosen language, so they survive a rebuild after a
  network cut.
- Lookup is **binary and non-destructive**, unlike the engine's queue: seeking backwards finds its
  line again instead of showing nothing until the next one.

Two details of real server responses the parser must handle: a **BOM** before the `WEBVTT` header,
and **position settings** at the end of a cue timing line (`region:subtitle line:90%`) which are not
part of the text.

---

## Track selection and account preferences

Jellyfin stores, per account, an audio language, a subtitle language and a mode (`Default`,
`Always`, `OnlyForced`, `Smart`, `None`). Honouring them is **not** a string comparison:

- The container writes `fre`, the account writes `fra` — the bibliographic and terminological
  halves of ISO 639-2. **Twenty languages** have this double spelling.
- Track names are free text: `FR VFF : AC3 5.1`, `VFQ`, `French (France)`, `Espagnol [VO]`.

Rules:

- Languages are normalised to a comparable form before matching.
- **The code wins over the name**; the name is read only in the absence of a code (3 audio tracks
  out of 1425 here).
- A track is **never** selected on the grounds that it is the only one left. Without the requested
  language, nothing is touched.
- **Audio descriptions and commentaries are excluded** — `French (France) AD` is a real track in
  this library.
- `VO` does not mean English. It means the track is not dubbed, which says nothing about its
  language, as `Espagnol [VO]` shows.

**The viewer's choice always wins over the account's**, including after a rebuild.

**Where preferences come from**: `/api/jellyfin/playback-state/[itemId]`, re-read at every open —
not from the file description, which is memoised to reopen a film instantly. That is correct for a
file that never changes and wrong for preferences that do.

The read is a bare `fetch` rather than a cached key, because it gates the effect that builds the
whole pipeline: it must change **exactly once**, from "not yet known" to "known". A cached key would
yield the memoised value and then the fresh one — two changes, therefore a film restarting
mid-flight. It carries an 8 s guard delay, so an unanswered request cannot leave a spinner running
forever.

---

## Playback reporting

Nothing about the file goes through Jellyfin, but progress does — otherwise resume points would stop
being correct for this player alone.

- **Start is announced** (`/api/jellyfin/playback/playing`). The stable player does not need it:
  negotiating its stream says as much. This one negotiates nothing, and without the announcement it
  reported progress for a session the server had never heard of.
- **A heartbeat every ten seconds**, at the position the player itself provides — never
  `video.currentTime`, which drops to zero during a track reload and would overwrite the resume
  point with 0.
- **The end is reported** on unmount, on `beforeunload` **and on `pagehide`** — iOS never sends the
  first. Going to the background records a **progress** report, not a stop: putting an app away is
  not closing a film.
- **Pause is reported honestly.** A film paused for an hour is not an hour of viewing.
- **Each player reports under its own name.** Jellyfin names a client from each request's
  authorization header, so one account can show which of the two is running: `CineApp` for the one
  that hands the file to Jellyfin, `CineEngine By CineApp` for the one that reads it here. The name
  comes from the browser, so it is **compared against those two**, never forwarded as-is.

Intro skipping and next-episode come from the **Intro Skipper** plugin
(`/Episode/{id}/Timestamps`), served to both players and working on all three paths; on the canvas
path the control bar seeks through the façade's `currentTime`.

---

## User-facing messages

The rule: **the banner is for the viewer, the log is for us.** A message belongs on screen only if
it describes something the viewer *sees* or can *act on*. Anything that repaired itself goes to the
trace. Every message clears after **6 seconds** — they all describe a moment, not a state.

Shown:

| Message | Raised when |
|---|---|
| `No sound: …` | Nothing can decode the audio track, or the audio output could not be created |
| `No decoder available for audio X` | Switch to a track nothing can decode |
| `Software audio decoding interrupted: …` | The WASM DTS/AC-3 decoder stopped mid-stream |
| `HDR conversion unavailable, picture shown without it (…)` | Canvas path, the conversion shader could not be created |
| `This audio track could not be opened: …` | Track change refused; **the previous one keeps playing** |
| `External subtitles unavailable.` | The requested `.srt` did not come back from the server |
| `This file has no seek index: seeking is not possible.` | Matroska without Cues |
| `Part of this file could not be decoded: playback resumes just after.` | Second source loss at the same place — a piece of film was skipped |

Sent to the trace instead, because the viewer saw nothing and has nothing to do: refused segment
retried, refused seek retried, recovery abandoned after N attempts (the remuxer's index back-off
routinely reaches the position just afterwards), pipeline rebuilt, sound restored by the software
decoder.

---

## Diagnostics

There is no console on a phone, which is the constraint the whole diagnostic surface is designed
around.

- **`trace.ts`** — a timestamped account of opening a file: stream opened, header and tracks, path
  chosen and paths refused, decoder and encoder, MediaSource, init segments, first segments and what
  the buffer did with them, every seek **and who asked for it**, every recovery **and what it saw**,
  element failure and source closure at the instant they happen.

  The log is **sliding**, not truncated: the first 120 steps are kept for good — opening is what
  explains how the film was playing — and the last 280 follow the present, with a line between them
  saying how many were dropped. Truncating means a long film stops recording, so the interesting
  failure is the one guaranteed to be missing.

- **`ExperimentalPlayerReport.tsx`** — the trace, the pipeline state, the device's measured
  capabilities and the file as the server sees it, as one copyable block. On the error screen, under
  the spinner after 20 s, and in the technical panel. **The stream URL is excluded**: it carries a
  token.

- **`capabilities.ts`** — what the device accepts, *asked* rather than assumed: DTS in MediaSource,
  AAC and Opus encoding at 2 and 6 channels, AAC/Opus in MediaSource, `AudioData`.

> `video.error` (code and message) and `MediaSource.readyState` carry the reason for a failure. A
> `SourceBuffer`'s `error` event carries nothing.

### The playback log

Falling back to the stable player is **automatic and silent** — right for the viewer, wrong for
whoever maintains the server: on an eighteen-account instance, a path that fails quietly fails
unwitnessed.

`data/logs/player.log`, one JSON object per line:

| Event | Written when |
|---|---|
| `start` | A path was chosen — which, why, in how many ms, at what second |
| `fallback` | The stable player takes over, with the reason and the abandoned path |
| `network` | The network dropped mid-playback, with the position |
| `rebuild` | Source lost and rebuilt, with the attempt number and whether a passage was skipped |
| `error` | An error shown to the viewer |

Each line carries the time, **the account taken from the session** (never from the request body:
the one field that says who this is must not be the one anybody can invent), the file, its
container, video codec, resolution, bit depth and range, plus the browser.

Three guardrails, since a browser decides what gets written: fields are **bounded** (24 at most,
500 characters each, nothing nested), the file **rotates** at 5 MB keeping one generation, and a
failed write **never brings down a playback**.

```bash
tail -f data/logs/player.log | jq .
jq -c 'select(.kind == "fallback")' data/logs/player.log   # fallbacks only
jq -r '.kind' data/logs/player.log | sort | uniq -c        # the distribution
```

---

## Verification harness

`bench.spec.ts` at the repository root — excluded from `npm test`, run deliberately:

```bash
docker run --rm -v "$PWD":/app -v /tmp/bench:/bench -v /mnt/media/video:/media:ro -w /app \
  -e BENCH_FILE="/media/tv/…/file.mkv" -e BENCH_FROM=1951 -e BENCH_COUNT=6 \
  -e BENCH_OUT=/bench/out -e BENCH_EXPECT_START=1943.3 \
  node:24-alpine sh -c "npx vitest run bench.spec.ts"
```

Then, on a machine with ffmpeg: decode `<out>.video.mp4` requiring zero errors, and compare **the
sequence of gaps between presentation timestamps** against ffprobe's reading of the source.

**Gaps, not timestamps.** A term-by-term comparison absorbs the presentation offset (5 frames at
40 ms = the 200 ms of delay) and proudly reports "constant offset: 0 ms" while measuring nothing.

`raps.spec.ts` measures the proportion of false keyframes in a file and what refusing them costs.

Synthetic tests pass on files real ones fail; this harness exists because that gap is where the
original defects lived.

---

## Known limitations

| Limitation | Detail |
|---|---|
| **No adaptive quality** | The file is read as it is — for a local network |
| **TrueHD is not supported and will not be** | No browser decodes it, and nothing in this ecosystem does either. Of 2000 audited files, 35 carry TrueHD and 33 of those carry a Dolby or DTS track alongside, which is the one that plays. 3 files out of 2000 have no track this player can deliver |
| **False keyframes cost one seek in eighty** | On the affected file only; a few seconds of frames nobody sees are re-read |
| **ASS/SSA without styling** | Dialogue only — see [Subtitles](#subtitles) |
| **Bitmap subtitles not rendered** | PGS and VobSub, covered by external `.srt` in every affected file here |
| **A pathological file is the normal case** | Six-audio-track files mixing FLAC / AC-3 / DTS / TrueHD at 1, 6 and 8 channels, 24-bit FLAC, mono defaults, Dolby Vision 4K. Test player changes against a file like that before believing them |

---

## File map

Everything is in `src/lib/webcodecs/` unless stated otherwise.

### The remux path

| File | Role |
|---|---|
| `byteSource.ts` | HTTP range reads, cache, in-memory windows |
| `ebml.ts`, `matroskaIds.ts` | The EBML format, headers and identifiers |
| `matroska.ts` | Header, tracks, index; cluster lookup by time |
| `sampleReader.ts` | Raw samples, in decode order |
| `decodeOrder.ts` | Decode-time and duration reconstruction |
| `mp4Boxes.ts`, `mp4Muxer.ts`, `mp4SampleEntries.ts` | Writing the fMP4 |
| `codecConfig.ts` | Codec strings, and what a keyframe actually is |
| `remuxer.ts` | The core: segments, fragments, subtitles, audio tracks |
| `remuxPlayback.ts` | Assembly: a file in, a playing `<video>` out |

### Delivery to the element

| File | Role |
|---|---|
| `mseSupport.ts` | What the browser accepts, and the buffer-replacement probe |
| `bufferQueue.ts` | One operation at a time per buffer |
| `playbackGuard.ts` | The element's clock: pause, resume, landing, picture hold |
| `mseSource.ts` | MediaSource, buffers, filling, seeks, recovery |
| `pathSelector.ts` | Which path, and why |

### Audio, subtitles, capabilities

| File | Role |
|---|---|
| `audioTranscode.ts`, `softwareAudio.ts` | Audio decoding and re-encoding |
| `externalSubtitles.ts` | The `.srt` files alongside: fetching, lookup by time |
| `subtitleMarkup.ts` | Markup stripping, for internal tracks **and** files |
| `capabilities.ts` | What the device accepts, measured |

### The canvas path

| File | Role |
|---|---|
| `engine.ts`, `renderer.ts`, `audioOutput.ts`, `hdrMath.ts`, `mediaFacade.ts` | WebCodecs → canvas |

### Server side and reporting

| File | Role |
|---|---|
| `src/app/api/jellyfin/playback-state/[itemId]` | Position and preferences: what changes between two playbacks |
| `src/lib/usePlaybackSession.ts` | What the server learns: start, heartbeat, end |
| `src/lib/playbackClients.ts` | The two names the app plays under |
| `src/lib/playerLog.ts` | The playback log: writing, bounds, rotation |
| `src/lib/reportPlayback.ts` | What the browser sends to it |
| `trace.ts` | The timestamped account |
