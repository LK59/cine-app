# The native player — technical reference

Reference documentation for the playback engine that reads library files **without asking the
server for anything**: no transcoding, no stream negotiation, no HLS. The browser fetches the
file — Matroska or MP4 — over HTTP byte ranges and everything else happens in the tab.

Source: `src/lib/webcodecs/`, plus the routes and hooks listed in the [file map](#file-map).

It still opens a **Jellyfin session**, for the one thing the server has to know: what is being
watched and how far — see [Playback reporting](#playback-reporting).

## Contents

- [Scope and context](#scope-and-context)
- [Path selection](#path-selection)
- [The remux pipeline](#the-remux-pipeline)
  - [`byteSource` — HTTP range reads](#bytesource--http-range-reads)
  - [`ebml` / `matroska` — header and index](#ebml--matroska--header-and-index)
  - [`mp4Demux` — MP4 input](#mp4demux--mp4-input)
  - [`decodeOrder` — reconstructing decode times](#decodeorder--reconstructing-decode-times)
  - [`mp4Muxer` — writing the container](#mp4muxer--writing-the-container)
  - [`remuxer` — segmentation and delivery](#remuxer--segmentation-and-delivery)
  - [MSE delivery](#mse-delivery)
- [Audio](#audio)
- [Subtitles](#subtitles)
- [Black bars baked into the file](#black-bars-baked-into-the-file)
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

`pathSelector.ts` decides whether the native path can carry the file and **always states its
reasoning**. There is no silent downgrade — a player that drops a level without saying so looks
like a player that works.

| Outcome | Mechanism | When |
|---|---|---|
| **Remux → native `<video>`** | Matroska or MP4 repackaged into fragmented MP4 in the browser, fed to a real `<video>` through MediaSource | The normal path |
| **Refusal → server player** | An error naming the codec or the reason (`Aucun chemin de lecture disponible pour ce fichier. remux : …`), which the host hands to the server player (`fallToStable`) — or shows as a playback error when `PLAYER_SERVER_FALLBACK=false` | The native path cannot carry it |

There used to be a second local path between the two, **WebCodecs → canvas** (software decode frame
by frame, canvas render, hand-held audio clock, HDR→SDR in a shader). It was removed on 2026-09-24:
ten sessions in three weeks, all of them tests, every one ending in the same server fallback a
second later, and every reason that once led there now handled by the native path. What it taught
the project, and where to find it: [`docs/lecteur-canvas.md`](docs/lecteur-canvas.md), tag
`lecteur-canvas-final-2026-09-24`.

**Resuming a few seconds earlier** (`resumeRewind.ts`, native player): opening a title this
device has not played for ten minutes — the next day, or after the TV — starts 5 s before the resume
point, and so does pressing play after a pause of ten minutes or more. Never for a rebuild or a
handover between players, which follow the last picture by seconds, nor within 30 s of either end.
"Played recently" is kept per device in local storage (50 titles); a lost value means a 5 s rewind,
never a missed scene.

**The next episode is prepared during the credits** (`nextEpisodeWarmup.ts`): a minute before the
end, its description, its resume state and its file header and index are fetched and left where
the opening looks for them, so it starts without the round trips to a distant server. No picture is
read, and the source closes without taking the current film's handover slot (`close(false)`).

**Casting goes through the server player** (AirPlay, Chromecast): a MediaSource stream cannot be
sent to a television, so the host hands over with `cast: true` and takes the film back when the
route ends. That handover belongs to the playback that asked for it — the takeover carries its
session (`castingNow`) — and never enters `handedOver`, the list of files the native path could not
carry, which lasts until the app reloads: closing the player mid-cast used to send every later
launch of that title to the server player. In the playlist a television receives, an HDR file keeps
only its copied variant (`castMasterPlaylist`): Jellyfin adds two SDR re-encodes declared at the
same bitrate, and after a seek a television gave up on the slow restart of the copy, switched to a
4K re-encode sharing the same Jellyfin job, and asked for the same segment forever. The cost: a
television without HDR finds no SDR version of such a file.

**The native path is nearly free.** Matroska samples are already exactly what MP4 wants — length-prefixed
HEVC/AVC access units, AC-3/AAC frames as they are. Only the packaging differs. No pixel and no
audio sample passes through JavaScript: the browser decodes in hardware, composes the image itself,
drives its own audio clock, and **displays HDR natively**. Building one group of pictures takes
15–56 ms, against ~2 500 ms to download it.

**Every file goes through the same pipeline, MP4 included.** An MP4 used to be handed to
`<video>` untouched ("direct play"), on the reasoning that it is already the packaging the remuxer
produces. A good container does not mean everything in it plays natively: E-AC3/AC-3 in an MP4
played **silently** on Chrome and Firefox — no error, so no fallback —, a file with several audio
and subtitle tracks offered no track menu and ignored the account's language, embedded subtitles
never showed, and an HEVC the browser refused ended on an error screen instead of the server
player. The pipeline does nothing (or almost) when nothing is needed — copied samples, a new
wrapper — and everything it knows how to do when something is: track choice, audio re-encoding,
subtitles, seeking, the kept byte zone, rebuilds. See [`mp4Demux`](#mp4demux--mp4-input).

**The container is detected on the file's own bytes** (`mediaFile.ts`: a `ftyp`, `moov`, `mdat`,
`free`, `skip` or `wide` box at offset 0 means ISO BMFF), never on what the server calls it:
Jellyfin names a container after the ffmpeg demuxer that reads it, so an ordinary MP4 comes back
as `mov,mp4,m4a,3gp,3g2,mj2`.

**Path 3** in practice covers `.avi` files, in MPEG-4 ASP and MP3, which no browser decodes — and
MP4s this player does not read (fragmented), which are refused before any path is tried and go to
the server player.

---

## The remux pipeline

```
byteSource ──▶ ebml/matroska ──▶ sampleReader ──────▶ remuxer ──▶ mseSource ──▶ <video>
 HTTP ranges   │ header, tracks,    raw samples,        fragmented    MediaSource
               │ index              decode order        MP4
               └▶ mp4Demux ───────▶ Mp4SampleReader ─┘
                  moov → same        samples in
                  description        decode-time order
```

`mediaFile.ts` is the only door: `openMediaFile` reads the header of either container into the
same `MatroskaFile` description, and `createSampleReader` returns the matching reader. Every caller
— remuxer, TrueHD decoder, path selection — goes through it, so none of them knows
or cares which container it reads.

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
- **No round trip before the first range when the size is known.** The file description the host
  fetches (`sizeBytes`, from Jellyfin's media source) is passed down to `HttpByteSource.open`, which
  then skips its `HEAD` and starts both ends at once; with no size, the `HEAD` (then a
  `bytes=0-0` probe) comes back. A known size is checked against the first `Content-Range` that
  arrives — before the parser has read a byte — and replaced by it if they differ (a file replaced
  while its description sat in the session cache), with a trace line; cached chunks the new size
  makes wrong are dropped.
- **Both ends of the file are requested at open**, in parallel: the header at the start, the index
  wherever the Cues were written (the very end, for a streaming-oriented file). The parse result is
  **cached under the file name**, so reopening the same file — or rebuilding after the platform
  dropped the source — does not pay for it again.
- **`warm(offset)` on seek.** The index knows which cluster a seek lands in several milliseconds
  before the parser asks for its first byte. Without warming, every seek began with a single
  request on an idle link; on a dense 4K file, 4 MB must arrive before the first frame, for ~12 ms
  of remux work. Index back-off benefits from the same mechanism, since it targets a colder region
  still.

- **A seek abandons the reads it no longer needs.** Each chunk has its own abort controller.
  `MseSource.seek` calls `Remuxer.prepareSeek` at request time, before the seek is served; that
  aborts every in-flight chunk outside the target chunk and its readahead (`ByteSource.abandon`), then
  warms the target. On a distant server a seek used to wait up to 2 s for a read of the position just
  left, while that position's readahead held the link. Whoever was awaiting an aborted read gets
  `ReadAbandoned` and stands down without repair: the fill loop does not count a refused segment or
  start a recovery, and the audio transcoder does not rebuild its encoder. `seekTo` then resets
  everything, as after any seek.

- **Readahead is cut to two chunks until a seek has its first picture** (`seekSettled`, 8 s at most).
  Measured with `Server-Timing` and the per-seek network trace, from a distant server at 75 Mb/s: the
  server spent under 20 ms per range, and 11 to 21 MB crossed the link before the first picture of a
  seek that needed 4 to 6. The six readahead chunks were sharing the link with the one the parser
  was waiting for.
- **Every seek traces its network cost** at its first append: requests, bytes, throughput, first-byte
  delays, the slowest request, the server's own time (`Server-Timing: app;dur, jf;dur`, added by
  the stream relay), and the protocol of each request counted (`protocole h2`, or
  `protocoles h2 ×5, http/1.1 ×1`) — read from the latest Resource Timing entry for the stream URL
  (`nextHopProtocol`), since every range shares that URL. The browser's buffer stops at a few hundred
  entries; past it, the value read is that of the earliest requests, which for one origin is the
  same answer. Absent when the browser does not say; never thrown.

**Before the stream is even opened**, the player needs two JSON answers: the file description
(`/api/jellyfin/direct/…`) and the viewer's state (`/api/jellyfin/playback-state/…`, resume position
and track preferences). A detail sheet asks for both when it opens, for the title its main button
would play and nothing else (`usePlaybackPrefetch`): the description goes into SWR under the key the
host reads, so a request still in flight is taken over rather than repeated; the viewer's state is
kept for 30 s, used once, and forgotten whenever a player closes — a resume position must not be
carried across a viewing. See `DECISIONS.md`, « Ce que Lire trouve déjà prêt ».

Retries: 4 attempts, with 60 s of patience while the network is offline. An abandoned read is never
retried.

### `ebml` / `matroska` — header and index

Header, tracks and index only. **Clusters are never walked**: on a 40 GB file that would mean
reading the whole thing, when the index already says where each keyframe lives.

**An index point carries one set of positions per indexed track.** Taking the first one yields the
place where *audio* can resume, almost never a keyframe — so the track's own position must be
selected explicitly.

A file with no Cues can be played but not seeked, and says so.

### `mp4Demux` — MP4 input

An MP4 (ISO BMFF: `.mp4`, `.m4v`, `.mov`) is described in **exactly the shape of a parsed
Matroska** — same `MatroskaTrack`s, same codec ids, same configuration records, an index of access
points — so nothing downstream branches on the container. Checked against ffmpeg on synthetic
fixtures: the codec records of an MP4 and of its `ffmpeg -c copy` Matroska twin come out
identical, and every sample's presentation time, size, file offset and sync flag matches
`ffprobe -show_packets`.

- **`moov` is read whole, `mdat` never.** The top-level boxes are walked by their headers only
  (16 bytes each), so the index is found at the front or behind a multi-gigabyte `mdat` at the
  end. `moov` is one read: 2–14 MB on a feature film (it lists every sample of every track), the
  same bytes a `<video>` given the URL would read before its first frame.
- **Sample entries → Matroska codec ids**: `avc1`/`avc3` → `V_MPEG4/ISO/AVC` (`avcC`),
  `hvc1`/`hev1`/`dvh1`/`dvhe` → `V_MPEGH/ISO/HEVC` (`hvcC`; `dvcC`/`dvvC` → `dolbyVision`),
  `av01` → `V_AV1`, `mp4a` → `A_AAC` (the AudioSpecificConfig out of `esds`) or `A_MPEG/L3`,
  `ac-3`/`ec-3` → `A_AC3`/`A_EAC3` (no codec private, as in Matroska: the remuxer describes them
  from a frame), `Opus` → `A_OPUS` (`dOps` rewritten as the Ogg `OpusHead` Matroska keeps), `fLaC`
  → `A_FLAC` (`fLaC` + the `dfLa` blocks), `mlpa` → `A_TRUEHD`, `tx3g` → `S_TEXT/UTF8`. Anything
  else keeps its four-character code (`V_MP4/encv`, `A_MP4/alac`…) so the refusal names it.
- **Channel counts come from the codec records**, not the sample entry: ETSI TS 102 366 fixes
  `channelcount` at 2 in `ac-3`/`ec-3` entries, so a 5.1 is read from `dac3`/`dec3`; AAC from its
  AudioSpecificConfig.
- **Language**: `mdhd`, and `und` is `null`. Not Matroska's "absent means English" rule — here the
  field is always written, and `und` means unknown; ffmpeg (hence the server) reads it the same way.
- **Default and enabled.** MP4 has no default flag; the `tkhd` "enabled" flag stands in for it (ffmpeg
  only enables the default track of each type). It is **not** used as `isEnabled`, which would drop
  every non-default subtitle track from the menu.
- **One video track**: the one with the most samples. A single-picture track (a cover stored as a
  track, a JPEG/PNG sample entry), a chapter text track (`tref/chap`, QuickTime `text`), a data or
  timecode track become `other` and are never read.
- **Timestamps** per track timescale: decode times from `stts`, composition offsets from `ctts`
  (signed in both versions), and the edit list applied as ffmpeg and mediabunny apply it — empty
  edits shift the start, the first media edit's `media_time` is subtracted. Presentation times
  therefore match what ffprobe reports, and the audio mediabunny decodes for re-encoding lands on
  the same instants as the samples copied beside it (verified to the microsecond on library files).
  Only the first media edit is followed; a longer list is traced.
- **The sample index** (`stsz`/`stz2`, `stco`/`co64`, `stsc`, `stss`, `stts`, `ctts`) is expanded into
  typed arrays — about 25 bytes per sample, some 20 MB for a three-hour film with three quarters
  of a million samples across its tracks.
- **Access points** are the video track's sync samples. A point's position is the smallest file
  offset among the samples (all tracks) decoded from its keyframe on — reading from there yields the
  keyframe *and* the sound around it, which is what a Matroska cluster position means, and what the
  kept byte zone (`keptRangeAt`) and seek warming (`warm`) use.
- **`Mp4SampleReader` yields samples in decode-time order across tracks**, not file order. A
  Matroska stores clusters by time; an MP4 stores chunks however its muxer chose, and nothing forces
  sound to sit near the picture — some files put all the video, then all the audio. Read in byte
  order, such a file would deliver minutes of picture with no sound, and MediaSource plays only the
  intersection of its buffers. On a well-interleaved file the two orders are the same up to small
  back-and-forth inside one cached megabyte.
- **mov_text samples** lose their two-byte length prefix and trailing style boxes; an empty sample
  (the gap between two lines) is empty text, ignored like an empty Matroska block.
- **Fragmented MP4** (`moof`/`mvex`, or sample tables with no samples) is refused with a named
  error before any path is tried, and goes to the server player.

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
| `playbackGuard.ts` | **The element's clock**: pause, resume, landing, resumed start |
| `mseSource.ts` | **The bytes**: buffers, filling, seeks, recovery |

The guard never speaks of bytes; it decides *when* the playhead should move, and the source remains
the only thing that moves media. The source hands it a narrow view of itself (`GuardHost`): three
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
  further on. Three nudges of 0.08 s; past those, a real recovery (below), once per 1.5 s. The
  recovery's own 0.08 s step is not playback: counted as such, it reset the nudges after every
  recovery, and a frozen picture took four minutes to reach the stable player (24/09).
- **The recovery ladder** (`recover` → `escalate` → `handOver`, `mseSource.ts`). Both kinds of
  stall climb the same rungs, and no rung is ever a dead end:
  1. seek to the head again, buffers cleared and re-read — **three times** at one spot within 5 s;
  2. **the next indexed keyframe** past the head (`Remuxer.keyframeAfter`, `cueTimeAfter`), 0.1 s
     inside its group — the same group re-read fails the same way, the next one has not been
     touched. Three attempts there too;
  3. **hand over to the host**: `onError(…, "playback")` with `lost` now true, so the host's
     ordinary source-loss rebuild runs — its budget, its step past a place that failed twice, and
     the stable player once that budget is spent. The watchdog stands down.

  Each rung is climbed once until the clock has **really played for 3 s** (forward ticks under
  0.6 s, no seek). Eight attempts without playback climb it anyway, however they are spaced.
  Two latches this replaced (22/09/2026, a −10 s skip that froze a film for nineteen seconds):
  the 5 s window was refreshed by *abandoned* calls too — the watchdog calls every 250 ms, so it
  never expired and every call after the third gave up; and the frozen clock was left alone for
  good after its third nudge.
- **Network failure with lead** (`keepThroughNetworkFailure`): a read that fails for the network,
  retries included, used to go through a recovery — both buffers cleared. With **5 s or more** of
  lead, the buffers are kept and the read is retried after 1, 2, 4 then 8 s, from where it stopped
  — and nothing is read in between, since only the retry repositions the file reader;
  just before the first re-read segment is appended, only what it will replace (its group, from its
  first picture) is removed, so the buffer never holds the same pictures twice — and never anything
  under the head: a group starting less than 1 s ahead of it falls back to the ordinary recovery
  instead (long GOPs, a late retry). Below 5 s of lead,
  after four tries, or if a seek intervened, the ordinary recovery runs as before (24/09).
- **Source loss**: iOS reclaims media resources in the background and closes the MediaSource. This
  is a pipeline to rebuild at the current position, not a failure to report — up to three times.
- **The rebuild budget decays.** Three source losses an hour apart are not the failure the limit
  exists to stop: past three minutes without incident the counter resets. Otherwise a two-hour film
  exhausts its budget by accident and yields to the stable player mid-session.

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
  MediaSource. Without the Opus fallback it loses the native path, and the film goes to the
  server player.
- **iOS does not accept Opus** in MediaSource, but encodes AAC in 5.1.

### Channel order: who converts, measured (2026-09-21)

Every decoder here hands back the **standard (WAVE) order** — L R C LFE Ls Rs (Lrs Rrs): mediabunny's
AC-3/E-AC3/DTS (measured against ffmpeg, 19/09), libFLAC (the format defines it), FFmpeg's TrueHD
(layout masks 0x60f / 0x63f). `fold` reads that order. What differs is the **encoder**:

| Encoder | Takes | Verified by |
|---|---|---|
| AAC, Chrome / Edge (desktop) | standard order, converts itself | a viewer's ears on Chrome/Windows (19/09) |
| AAC, Apple — Safari, every iOS browser, **and Chrome on macOS** | **AAC order** (C L R Ls Rs LFE): AudioToolbox is handed a channel *count*, no layout — by WebKit's `AudioEncoderCocoa`, and by Chromium's `AudioToolboxAudioEncoder` ("We don't setup the AudioConverter channel layout here") | ears on iPhone: "Titanic" 5.1 (07/09), Braveheart 7.1 (21/09); Chrome/macOS read in its source |
| AAC, Chrome on Android | standard order, probably: MediaCodec without a channel mask; Android's software AAC encoder is set to WAVE order | read, not measured |
| AAC, Apple, 8 channels | never asked: folded to 5.1 first (`appleAacCap`) — AAC has no true back-surround 7.1 | — |
| Opus, Firefox | standard order, converts itself (libopus) | tagged tones per channel encoded in Firefox, decoded by ffmpeg (21/09) |
| Opus, Chrome / Safari | stereo only | refused beyond two channels |

The table lives in `APPLE_AAC_ORDER` / `orderFor` (`audioTranscode.ts`), keyed on
`appleAudioToolbox()` — the *system*, not the browser: it is the platform encoder that decides, and
Chrome on a Mac uses the same one as Safari.

**Not measured, and where to look first if a viewer reports voices on one side:**
- AAC from **Chrome on Android** (42 plays here): read in Chromium and Android, not heard.
- Multichannel **Opus decoded by Apple** — why only mono and stereo Opus are transcoded on Safari.

Library census (30 110 audio tracks, 21/09): 99.5 % mono, stereo, 5.1 or 7.1. The rest — Opus 3.0
(76, series), AC-3 3.0 (8), DTS 6.1 (5), E-AC3 5.0 (2), AC-3 4.1 (2) — go through `fold`'s rule
for layouts it cannot name: keep L R C, drop the rest, rather than guess. The rule holds even when
the count does not change, and an encoder is never asked for five or seven channels: they go out as
six or eight (`knownLayoutAtLeast`), L R C in place and the rest silent — Firefox's Opus encoder
accepts five channels and read a 4.1 as a 5.0, the LFE in the left surround (24/09).

How it was measured, to do it again: encode one sine per channel at distinct frequencies with the
browser's own `AudioEncoder`, wrap the packets in a container ffmpeg reads, decode with ffmpeg, and
read the dominant frequency of each output channel. A browser's own decoder cannot settle it — it
may mirror its encoder's convention and hide it.

> Expected side effect: once the LFE is correctly labelled, the standard stereo fold **excludes**
> it. Before the fix it was taken for a surround channel and mixed in, so the sound is quieter
> afterwards. That is the correct behaviour, not a regression.

### Audio delivery: per track, and every track change rebuilds

**Default since 2026-09-21 (`perTrack` in `remuxer.ts`).** Each track is delivered in its best
form — a Dolby track the browser takes is copied untouched, TrueHD, DTS and anything else it
refuses is re-encoded.

**Changing track has one path: the player is rebuilt** at the same position, opening directly on
the new track (`RemuxPlayback.requestAudioTrack`, `openingAudio`, `ExperimentalPlayerHost`) — same
format or not, on every engine, since 2026-09-22. It is the machinery that already brings the
player back after a lost source; the frame on screen is held, a film paused stays paused, and a
track change does not spend the rebuild budget reserved for failures. A position asked for by a
seek still loading is the one reopened.

Until then a same-format change stayed **in the buffer**: the audio buffer emptied and refilled
while the picture played, behind an exclusive section and a picture hold. Measured on Safari,
Chrome and Firefox, it was the slower of the two (0.4 to 3.1 s median, with multi-second tails,
against 0.05 to 0.35 s for a rebuild — it waited for the fragment being built, where a rebuild
drops it), and on WebKit it could leave a lasting audio offset that only a seek cleared: the
refill carried up to one keyframe interval of past audio, and Safari's audio renderer only
re-synced to the picture if the hold won a race of a few tens of milliseconds. It was removed, with
its buffer surgery and its capability probe.

**The one refusal**: a file with no index, past its first second. A rebuild reopens by the index,
and without one it would restart the film from zero — so, like a seek on that file, the change is
refused with a warning (`noIndexAudio`) and the previous track keeps playing. At the very start,
reading from the beginning *is* the right answer, and the change rebuilds.

The `audio` lines of the playback log carry `via`: `reconstruction`, or `refus` for that refusal
(older lines say `tampon` for the in-buffer change).

Why per track: once TrueHD became decodable, 19 films mixing TrueHD and Dolby had their Dolby VF
re-encoded — a second lossy generation, and work for the phone — and a re-encoded language change
cost 2 to 15 s on iPhone, where a recovery rebuild took 0.3 to 0.5 s.

Rebuilding tears a *healthy* MediaSource down mid-playback. The 2026-09-03 attempt below, "rebuild
the MediaSource", failed because it swapped a MediaSource under a running pipeline; this tears the
whole pipeline down and builds a new one on the element, and holds on device. Passing
`perTrack: false` (`RemuxOptions`, given to `Remuxer.open` and to the plan functions — no longer a
module-level setting) restores the per-file unification below; track changes rebuild there too.

What the first device test (2026-09-21, Braveheart VF ↔ VO) taught, and what now holds it:

- **Apple's AAC encoder must not be reused through `reset()`.** Every fresh encoder primed; every
  `InternalAudioEncoderCocoa encoding failed` followed a `reset()` + `configure()` — which is what
  a seek did, and a rebuild does twice. A seek now builds a **fresh** encoder with the exact
  configuration (`renew` in `audioTranscode.ts`), and only the current encoder is listened to.
- **An encoder that fails in use lowers the rate for the session**, never below the last rung of
  the ladder (without an imposed rate Safari answers with HE-AAC, another object type).
- **The encoder's rebuild budget decays** like the player's: three rebuilds, forgotten after thirty
  clean segments (`GOOD_SEGMENTS_TO_FORGIVE`) — otherwise a long film spent its budget on
  hiccups twenty minutes apart and went to the server player at the fourth.
- **A replacement encoder must describe the buffer as the one it replaces**: `retryTranscoder`
  refuses one whose actual codec, rate or channel count differs from the buffer's, rather than
  changing a live buffer's configuration.
- **The end of the file is declared with a transcoder too**: once the last picture is out, the
  rest of the re-encoded sound is asked for once, then `nextSegment()` answers `null` and the
  stream is ended. Until 22/09/2026 it never did, and every re-encoded film looped in its credits.
- **A switch that cannot open reverts to the previous track** instead of falling to the server
  player (`revertFailedSwitch`).
- **The rebuild keeps the picture**: the frame on screen is copied into a canvas above the
  element and fades out once the new pipeline has its own; and the new `HttpByteSource` inherits
  the size and the chunks of the one just closed for the same URL (no HEAD, no re-download —
  `handover`, five seconds at most).
- **The bytes around the playhead stay in memory** (`keep` in `byteSource.ts`, `keptRangeAt`): the
  cache evicted oldest-first while the player reads up to thirty seconds ahead, so the region a
  track change re-reads — sound is interleaved with the picture — was long gone and came back over
  the network (9 s on a slow link, 21/09). The player now names that region every two seconds of
  playback and on every seek; eviction passes over it (24 MiB at most; the cache grew from 48 to
  64 MiB so it does not eat into the read-ahead), and it survives a rebuild with the handover.
- **A pause stays a pause**: `startPaused` reaches `PlaybackGuard.opened`, which otherwise took a
  player opened standing still for a failed start and started it.

### One codec per file (the fallback)

**Mid-buffer codec transitions do not exist here.** If a file's tracks cannot all be delivered
as-is, **they are all re-encoded** — decided at open, and frozen for the life of the MediaSource.

All three ways of changing a live buffer's codec were tested on device:

| Approach | Measured result |
|---|---|
| `changeType` | Safari accepts, then `media failed to decode`, sometimes 6 s later. Closes the MediaSource. |
| Rebuild the MediaSource | Detaches the element; Safari does not come back. |
| `removeSourceBuffer` + `addSourceBuffer` | The API works, the result is inert: segments accepted, ranges growing, head advancing, **no sound**. The first seek closes the source. |

The third one's code, its probe and the `TRUST_BUFFER_REBUILD` switch that disbelieved it were
removed on 2026-09-22 with the in-buffer track change: every track change now rebuilds the whole
player, so no live buffer ever changes codec.

**Accepted cost**: on a mixed-codec file, an AC-3 track that could have passed through intact is
re-encoded. It buys a language change that cannot break playback.

> `decoderConfig.description` is *specified* as the bare AudioSpecificConfig, and Chrome returns it
> that way — **Safari returns the whole `esds` contents**. Wrapping it a second time yields
> `mp4a.40.0` (the first five bits read are the `0x03` tag byte) and closes the MediaSource. The
> descriptor tree is therefore unwrapped, and what actually came out is read rather than what was
> asked for.

---

## Black bars baked into the file

A 2.39:1 film is often delivered in a 16:9 frame, its bars part of every image (1920×1080 holding
1920×872 of picture). The element fits the *frame* to the screen (`object-contain`), so on a
screen wider than 16:9 — a phone in landscape — the film is boxed in black on all four sides.
Measured on a sample of 222 titles coded 16:9: 90 carry bars at the top and bottom, 7 on the sides.

**The measure is server-side and decodes no video** (`pictureFrame.ts`). It reads Jellyfin's
trickplay thumbnails — one image every ten seconds over the whole file, already extracted for the
scrubbing preview — decodes the JPEG sheets with `sharp` into greyscale, and finds in each
thumbnail where the content starts (a row or column is picture once its mean luminance exceeds
24/255, `cropdetect`'s 0.1). A few sheets per film: about 0.2 s, cached on disk for six months
under a key that includes the thumbnail count, so a replaced file is measured again. No
trickplay, or fewer than 30 informative thumbnails, means no answer and no enlargement.
`PLAYER_AUTO_FRAME=false` turns the whole thing off.

**It can only err on the safe side.** The result is the *union* of every thumbnail's content —
the largest picture seen over the film. A dark scene narrows its own measure and never the union;
for real picture to be taken for a bar, that edge would have to be black from one end of the film
to the other. A film whose ratio changes (IMAX sequences) gives the whole frame, hence no
enlargement. The first 3 % and last 8 % are skipped (studio logos, credits), the two outermost
pixels of each thumbnail are not trusted (JPEG blocks bleed across neighbouring thumbnails in a
sheet), the result is widened by a pixel on every side, and a bar under 1 % is ignored.
Checked against `ffmpeg cropdetect` at twelve points on the same 222 titles: no title where the
thumbnails claim more bar than ffmpeg, one where they see less.

**The enlargement is client-side** (`frameFit.ts`): the scale that brings the *picture*, not the
frame, to the first screen edge it meets — the smaller of the two ratios, so the other dimension
keeps everything — and an offset that centres the picture when its bars are unequal. On a touch
screen (rounded corners) the picture stops 2 % short of the edge; the Dynamic Island is left to
float over it, as in every iOS video app. It is a CSS
transform on a wrapper around the surfaces, inside a clipping box, recomputed on every resize; the
surfaces keep their own opacity transitions. The request leaves at open, alongside everything
else, and nothing waits for it: from the cache it lands before the first picture, measured for the
first time it arrives a moment later and the picture glides into place. Not in the mini-player,
which fills its window already. The server-side player is not affected.

---

## Subtitles

**Overlapping lines** are shown together, in the order they appeared, two at most
(`simultaneousText`, DECISIONS.md n°19); they stay at the top only if every one asks for it.

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
is the only one that knows they exist. Measured on a 672-film library: 272 carry at least one
external text subtitle, and 95 have no text subtitle in the container at all — 88 of those are
covered by a file alongside.

- `/api/jellyfin/direct/[itemId]` lists them (`IsExternal`, text codecs only).
- They are numbered **negatively** (`-1 - index`), so they can never be confused with a track read
  from the file.
- They are fetched **when selected**, as WebVTT — Jellyfin converts, whatever the on-disk format.
- They are held **above the pipelines**, like the chosen language, so they survive a rebuild after a
  network cut.
- Lookup is **binary and non-destructive**: seeking backwards finds its line again instead of
  showing nothing until the next one.

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
- An account with **no subtitle language** gets only what the file's flags designate — a forced
  track *in the audio's language*, else a default one, else none — except in `Always` mode. Reading the empty language as
  "any language" switched on the first full track, whatever its language (24/09).
- A track is **never** selected on the grounds that it is the only one left. Without the requested
  language, nothing is touched.
- **Audio descriptions and commentaries are excluded** — `French (France) AD` is a real-world
  track name.
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

Intro skipping and next-episode come from Jellyfin's **media segments** (`/MediaSegments/{id}`,
Jellyfin 12), with the old Intro Skipper endpoint (`/Episode/{id}/Timestamps`) as a fallback — on
Jellyfin 12 it answers 404 for every episode. `timestampsFromSegments` keeps the earliest `Intro`
and the earliest `Outro` starting after the first minute, and ignores segments shorter than 5 s:
some analyses produce a 3-second "intro" or an "outro" at 3 s next to the real one. Both players
use it.

The next-episode card appears at the credits, or **in the last second** when no credits are known,
so an episode never freezes on its final frame with nothing offered. Its countdown only runs while
playing (or at the very end): pausing during the credits no longer starts the next episode behind
the viewer's back. Specials (season 0) are chained among themselves, never after a series' finale.

A film's end is reported to Jellyfin **when it ends**, not when the player closes — that stop is
what marks it watched, and a page killed on the end screen used to never send it. *Watch again*
re-declares the session. A close only applies to the playback that asked for it (`openId` on the
session): a film opened during the previous one's 200 ms fade is no longer closed by it.

---

## User-facing messages

The rule: **the banner is for the viewer, the log is for us.** A message belongs on screen only if
it describes something the viewer *sees* or can *act on*. Anything that repaired itself goes to the
trace. Every message clears after **6 seconds** — they all describe a moment, not a state.

Shown:

| Message | Raised when |
|---|---|
| `This audio track could not be opened: …` | Track change refused; **the previous one keeps playing** |
| `External subtitles unavailable.` | The requested `.srt` did not come back from the server |
| `This file has no seek index: seeking is not possible.` | Matroska without Cues |
| `This file has no seek index: the audio track cannot be changed during playback.` | Track change past the first second of a file without Cues — both ways of changing track reposition through the index (`RemuxPlayback.switchNeedsIndex`); the previous track keeps playing |
| `Part of this file could not be decoded: playback resumes just after.` | Second source loss at the same place — a piece of film was skipped |

Sent to the trace instead, because the viewer saw nothing and has nothing to do: refused segment
retried, refused seek retried, recovery abandoned after N attempts (the remuxer's index back-off
routinely reaches the position just afterwards) and the ladder's next rung, pipeline rebuilt, sound
restored by the software decoder.

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
| `seek` | A seek from the controls: from, to, already buffered or not, how long, and `steps` — the trace since the request |
| `stall` | The element says it is playing and the clock has covered under a second in 5 s — once per stall, at most one a minute. Position, `readyState`/`networkState`/`seeking`, source state, video and audio ranges near the head, lead, whether a read is running, `recoveryStreak`/`frozenNudges`/`recoveries`, ms since the last append, `streaming` (ManagedMediaSource only), and `steps`: the last 20 s of trace. Emitted by `MseSource.watchForStall` on the watchdog tick |
| `audio` | A track change: both tracks described, copied or re-encoded, `applied`, how long, and `steps` |
| `cast` | Server player only: a television has actually taken the route |
| `stop` | The session's summary. `why` (`close`, `next`, `page`, `unmount`, or `lost` — see below), `watched` seconds, `ended`, `rebuild`; `waits` / `waitedMs` / `longestWaitMs` — stops of 250 ms or more mid-playback, excluding opening and seeks (`stall` only fires at 5 s); `seeks` / `seekWaitMs`; `audioSwitches`; `backgrounds` / `backgroundMs` / `backgroundRebuilds` — times the page went to the background, for how long, and how many returns found the source closed by the platform and rebuilt (each also written as a `rebuild` line, reason "source fermée en arrière-plan", with `hiddenMs`); `recoveries`, `frozenNudges`, `escalations` when any; `audioSync` and `frames` (presented / dropped). The server player writes `why` and `at` |

Each line carries the time, **the account taken from the session** (never from the request body:
the one field that says who this is must not be the one anybody can invent), the file, its
container, video codec, resolution, bit depth and range, plus the browser — and, on the native
player, a **`session`** id. A rebuild rewrites `start` (with `rebuild` > 0), so lines are joined by
`session`, never by account and time: two devices on one account used to be read as one viewer.

**A stop that could not be sent.** A page iOS kills in the background never receives `pagehide`:
before this, about one session in fourteen had no `stop`. While a session lives, its summary is
kept in `localStorage` (`src/lib/unsentStop.ts`), rewritten every 30 s and when the page is hidden,
and removed once the real `stop` leaves. A summary left untouched for two minutes is sent on the
next launch (and every minute after) as `why: "lost"` with `lateByMs`, and removed only once the
server accepts it — the app also opens on the login screen, where it would be refused. A tab woken
after being declared lost still sends its real `stop`: keep the last line per `session`. The
`stop` itself leaves through `navigator.sendBeacon`, which the browser keeps queued after the page.

Three guardrails, since a browser decides what gets written: fields are **bounded** (24 at most,
500 characters each — 4 000 for `steps` —, objects flattened one level and no deeper), the file **rotates** at 5 MB keeping five generations (`player.log.1` newest … `.5`), and a
failed write **never brings down a playback**.

Lines carrying `bench` (a device test bench session) are written to `data/logs/bench-player.log`
instead — same format, two generations — so a bench never rotates real viewers' history away.

```bash
tail -f data/logs/player.log | jq .
jq -c 'select(.kind == "fallback")' data/logs/player.log   # fallbacks only
jq -r '.kind' data/logs/player.log | sort | uniq -c        # the distribution
# one summary per session: last stop line per session id
jq -s 'map(select(.kind == "stop" and .session)) | group_by(.session) | map(last)' data/logs/player.log
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

`cout.spec.ts` answers the other question — not *is it right* but *where does the time go*:

```bash
docker run --rm -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
  -e COUT_FILE="/media/movies/…/file.mkv" node:24-alpine npx vitest run cout.spec.ts
```

It reports reads, bytes and milliseconds for four moments: reading the header, opening the
remuxer, producing the first segment, and seeking. Measured on a real library on 2026-09-20:

| | header | before the first frame | seek |
|---|---|---|---|
| 4K, 8.3 GB, 13 tracks | 77 ms / 0.2 MB | **4.2 MB** | 4.4 MB |
| HD, 2.3 GB, 7 tracks | 79 ms / 0.2 MB | **2.0 MB** | 1.4 MB |

That 2.1× ratio is the one `data/logs/player.log` reports for real openings on real devices (4K
1250–1600 ms, HD 565–690 ms), which is the whole point: **launching is bound by bytes, not by
CPU** — remuxing costs 2 to 20 ms per segment, and everything above totals about 110 ms. And
those bytes are the file's own interleaving: producing 29 KB of video means traversing 2.8 MB,
because thirteen tracks are braided together in the same clusters. No change on this side removes
them; only remuxing the files themselves would, and those belong to Radarr.

Synthetic tests pass on files real ones fail; this harness exists because that gap is where the
original defects lived.

---

## Seek lifecycle

A seek's state lives in one object, `SeekLifecycle` (`src/lib/webcodecs/seekLifecycle.ts`), owned by
`MseSource`: *requested* (a burst keeps only the last), *serving* (the target the source is serving,
used to recognise its own `seeking` events), *in flight* (from `seeking` until the playhead reaches
the target), *arrived*. Its two rules are written once in `seekArrival.ts` and shared by the source,
the host and the bench: arrived means within 1.5 s of the target (`seekArrived`), and a file with no
index can only be reached near its start (`reachable`).

- **A deliberate step around the target moves the target with it** (`moved`): landing on the first
  media, a frozen-clock nudge, a re-asserted pause position. None of these is a departure.
- **One detector for a playhead out of place** (`watchForHeadAway`). During a seek, the playhead
  moving away from its target sends it back to the *target*. After arrival, a clock running three
  seconds with no media under the playhead resumes from where it is. Both go through the recovery
  ladder. When the ladder is exhausted, `handOver` keeps the position the host rebuilds from, which
  is the target and not wherever the playhead ran to.
- **Any deliberate move tells the pause guard**, including a step within what is already buffered.
  A forward seek made while paused was pulled back to the pause position on resume.
- **The host forgets the target it asked for** once the source says the seek is over
  (`seekPending`), even if the playhead landed elsewhere. A seek replaced by the next one is logged
  as `superseded`, and as `arrived` if it was at its target.
- **No clock hold during a seek.** A WebKit-only `playbackRate = 0` hold was tried and removed on the
  same day. Across two iPhone benches, Safari still moved a playhead back to its old position with
  the clock held, and the out-of-place detector caught it both times. The hold also silenced the
  frozen-clock and stall watches. Safari fires no `requestVideoFrameCallback` at rate 0, so the
  release cannot wait for the first picture either.
- **One landing for opening and for seeking** (`landingFor`). The playhead stays on the target if
  media covers it. Otherwise it goes one frame inside the first media that starts after the target
  (`LANDING_INSET`), up to 15 s later. Opening used to land exactly on the media's first instant,
  which WebKit leaves unresolved, and reached only 1 s ahead, so a sparse index could only be
  joined through a recovery that re-read the file.

## Device test bench

The benches above prove what the remuxer *produces*; they cannot say what a given browser does with
it. The device bench does: an administrator starts it from the cinema's Account panel, on the phone
or computer to be tested, and it plays real films through the real player while measuring.

- **Driven, not simulated.** When a session carries `bench` (`PlaybackSession.bench`), the native
  player registers a bridge (`src/lib/playerBench/bridge.ts`). Seeks go through the same
  `noteSeekRequest` + `currentTime` pair as the controls, track changes through the same
  `changeAudioTrack` as the menu. Bench sessions report nothing to Jellyfin (a bench seeks to the
  end of films, which would mark them watched), and every player line they cause carries
  `bench: <run id>` and goes to `data/logs/bench-player.log`, not `player.log` — the server
  player's lines included, when a film is handed to it during a bench.
- **A film handed to the server player is not judged.** Whether it was handed over before the
  bench reached it (a cast, an earlier refusal) or during its opening (Dolby Vision without an
  HDR10 base layer on a browser with no Dolby Vision decoder), it is marked `skip` — "nothing to
  measure here" — rather than waited on for 45 s and failed. A film where nothing was measured is
  `skip`, never `ok`.
- **Which films.** `/api/player/bench/plan` reads `player.log` and all its archives — real viewers
  only, lines carrying `bench` ignored even in archives written before the split: the files that stalled, erred, fell
  back or seeked slowly first, then enough to cover Dolby Vision, HDR10, SDR, MP4, 4K and an episode.
  No title is written in the code.
- **What is measured** (`measure.ts`, pure and tested): the film clock against wall time and against
  presented frames (`getVideoPlaybackQuality`), sampled every 250 ms. That reads a frozen clock, a
  clock running with no picture, an unrequested jump, and a clock running fast.
- **Scenarios** (`runner.ts`): opening; playback; seeks (far forward, −10 s, +30 s, seeded random
  positions, far back, near the end, back again); a burst of five seeks in 0.6 s; pause and resume;
  a seek while paused; each other audio track; a seek immediately followed by a track change; a
  track change while paused; subtitles; 30 s of continuous playback. The quick depth keeps a subset.
- **Questions.** Optional yes/no prompts for what cannot be measured: sync, picture after a seek,
  language after a switch, subtitle timing, picture quality.
- **Results.** One line per film in `data/logs/bench.log` (admin-only routes), each failure with the
  player's own trace; the Account panel lists recent runs.

## Known limitations

| Limitation | Detail |
|---|---|
| **No adaptive quality** | The file is read as it is — for a local network |
| **TrueHD is decoded here** | Since 2026-09-21: FFmpeg's decoder compiled to WebAssembly (`tools/truehd-wasm`), run on the main thread in quarter-second batches with a yield between them (Turbopack does not compile a TypeScript worker), fed one Matroska block per call (FFmpeg's parser loses sync mid-stream), re-encoded like DTS. 52 tracks in the library — 50 TrueHD Atmos 7.1, 2 TrueHD 5.1 — 35 films whose VO or VF exists only in TrueHD. Validated against `ffmpeg astats` to 0.01 dB on every channel (`truehd-bench.spec.ts`); at most 88 ms of silence after a seek. Atmos objects are not rendered: the 7.1 presentation is, as on the server player |
| **False keyframes cost one seek in eighty** | On the affected file only; a few seconds of frames nobody sees are re-read |
| **ASS/SSA without styling** | Dialogue only — see [Subtitles](#subtitles) |
| **Fragmented MP4 refused** | `moof`/`mvex` files carry no sample tables; the header read refuses them by name and the server player takes over. Only the first media edit of an edit list is followed |
| **An MP4's index is read whole** | `moov` lists every sample, 2–14 MB on a feature film, fetched before the first frame — what a `<video>` given the URL reads too. Matroska's header and index are 0.2 MB |
| **Bitmap subtitles not rendered** | PGS and VobSub, covered by external `.srt` in every affected file here |
| **FLAC is carried where it is taken, decoded here where it is not** | Chrome and Firefox accept FLAC in a MediaSource and get it untouched. Safari refuses it, and since 2026-09-21 it is decoded by libFLAC compiled to WebAssembly (`@wasm-audio-decoders/flac`, `flacDecoder.ts`) and re-encoded like DTS. Verified against `ffmpeg astats` on 24-bit stereo, 16-bit mono and 24-bit 5.1 library tracks: every channel within 0.05 dB, dialogue in the centre |
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
| `mp4Demux.ts` | MP4 input: `moov` → the same description, and `Mp4SampleReader` |
| `mediaFile.ts` | The one door: container detection, header, sample reader |
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
| `playbackGuard.ts` | The element's clock: pause, resume, landing, resumed start |
| `mseSource.ts` | MediaSource, buffers, filling, seeks, recovery |
| `pathSelector.ts` | Which path, and why |

### Audio, subtitles, capabilities

| File | Role |
|---|---|
| `audioTranscode.ts`, `softwareAudio.ts` | Audio decoding and re-encoding |
| `externalSubtitles.ts` | The `.srt` files alongside: fetching, lookup by time |
| `subtitleMarkup.ts` | Markup stripping, for internal tracks **and** files; text of a subtitle block (`subtitleText`) |
| `playerTrack.ts` | A track as the interface sees it (`PlayerTrack`), read from the container |
| `capabilities.ts` | What the device accepts, measured |

### Server side and reporting

| File | Role |
|---|---|
| `src/app/api/jellyfin/playback-state/[itemId]` | Position and preferences: what changes between two playbacks |
| `src/lib/usePlaybackSession.ts` | What the server learns: start, heartbeat, end |
| `src/lib/playbackClients.ts` | The two names the app plays under |
| `src/lib/playerLog.ts` | The playback log: writing, bounds, rotation |
| `src/lib/reportPlayback.ts` | What the browser sends to it |
| `trace.ts` | The timestamped account |
| `src/lib/pictureFrame.ts`, `src/app/api/player/frame/[itemId]` | Where the picture sits in the frame, measured from trickplay thumbnails |
| `src/lib/frameFit.ts` | The enlargement to the nearest screen edge, and its hook |
