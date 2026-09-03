// Turns a Matroska file into the segment stream a MediaSource eats, without touching a single
// byte of the compressed video or audio.
//
// The samples inside Matroska are already exactly what MP4 wants — HEVC and AVC access units
// prefixed by their length, AC-3 and AAC frames as they are. Only the packaging differs. So this
// copies samples verbatim and rebuilds the wrapper around them, which is why it costs almost
// nothing and, unlike the WebCodecs path, hands the decoding back to the browser's own hardware
// pipeline: no canvas, no per-frame JavaScript, no colour conversion, HDR handled natively.

import { deriveDurations, assignDecodeTimes } from "./decodeOrder";
import { subtitleText, TEXT_SUBTITLE_CODECS, type SubtitleCue } from "./engine";
import { avcCodecString, hevcCodecString, isRandomAccessPoint, nalLengthSize } from "./codecConfig";
import type { MatroskaFile, MatroskaTrack, MediaSample } from "./matroska";
import { clusterOffsetForTime } from "./matroska";
import { initSegment, mediaSegment, type MuxSample, type MuxTrackInfo } from "./mp4Muxer";
import { audioSampleEntryFor, videoSampleEntry } from "./mp4SampleEntries";
import { transcodeTargetCodec, AudioTranscoder, transcodableAudio, type TranscodedFrame } from "./audioTranscode";
import { trace } from "./trace";
import { containerAccepts } from "./mseSource";
import { SampleReader } from "./sampleReader";
import type { ByteSource } from "./byteSource";

/** Microseconds — Matroska's own precision, so sample times are copied rather than rescaled. */
const TIMESCALE = 1_000_000;

/** Roughly how much media each segment carries. Cut at keyframes, so it is a floor, not a target. */
const SEGMENT_US = 2_000_000;

/**
 * How many times a failing encoder is rebuilt before its failure is reported.
 *
 * One is usually enough — the hiccup is transient — and an encoder that refuses every time must
 * not turn into a player that reads a whole film in silence.
 */
const MAX_ENCODER_RESTARTS = 3;

/**
 * How far back to read from when the index points at a picture a decoder cannot start on.
 *
 * More than the widest gap between genuine random access points measured across this library —
 * ten seconds — so one step is normally enough. Tried a few times, further each time, because a
 * file could in principle have a long stretch with none at all.
 */
const INDEX_BACKUP_US = 12_000_000;
const MAX_INDEX_BACKUPS = 3;

/**
 * How much a single fragment may carry, and how many samples.
 *
 * Both bounds matter. The bytes are what a player has to swallow in one call, and the sample
 * count is what its parser has to walk; a stretch of tiny pictures can be many of one and little
 * of the other. Two seconds of this library's video is about a megabyte, so these are that, with
 * room for a hard scene.
 */
const FRAGMENT_BYTES = 1_200_000;
const FRAGMENT_SAMPLES = 60;

/**
 * How many pictures beyond a fragment must be read before its timeline is final.
 *
 * A picture's decode time is its rank among the group's presentation times, so one read later can
 * still displace one already held — but only within the reordering depth of the codec, which is a
 * handful of pictures and never the whole group. The depth is measured once per stream; until
 * there is anything to measure, this generous guess stands in for it. Sixty-four is far past any
 * reordering a real encoder produces, and still a fraction of a twenty-five-second group.
 */
const REORDER_LOOKAHEAD_GUESS = 64;
const REORDER_LOOKAHEAD_MARGIN = 4;

/** A frame's duration when nothing in the file says what it is: 24 fps, close enough for one frame. */
const FALLBACK_FRAME_US = 41_667;

/**
 * Extra room on top of the reordering depth measured in the first segment, in frames.
 *
 * The delay is fixed for the whole stream — changing it mid-way would put a gap or an overlap at
 * a segment boundary — so it is measured once and given margin in case a later segment reorders
 * more deeply than the opening one.
 */
const DELAY_MARGIN_FRAMES = 3;

/** An audio frame's duration when the file gives nothing to measure it from: 1536 samples at 48 kHz. */
const FALLBACK_AUDIO_FRAME_US = 32_000;

/** A subtitle line, carrying the track it belongs to so a change of language costs nothing. */
export interface TrackedCue extends SubtitleCue {
  track: number;
}

export interface RemuxSegment {
  /**
   * The pictures, in one or more fragments — see Remuxer.fragmentise. Empty when this stretch's
   * pictures were not wanted, which is what a change of audio language asks for.
   */
  video: Uint8Array[];
  audio: Uint8Array | null;
  /**
   * Subtitle lines found while reading this stretch of the file, already timed on the player's
   * clock — for *every* text track, not only the one on screen.
   *
   * They come free: every sample in the file passes through here anyway, so picking the subtitle
   * ones out costs no extra reading, and text weighs nothing next to the pictures. Collecting
   * only the selected track would mean re-reading the file whenever the viewer changes language,
   * and re-reading means re-appending media the browser has already played — which it catches up
   * on at speed, so a change of subtitles came with a second of fast-forward.
   */
  subtitles: TrackedCue[];
  /** Presentation time of the end of this segment, in seconds. */
  endSeconds: number;
}

/** How long a subtitle stays up when the file does not say. Long enough to read a short line. */
const SUBTITLE_FALLBACK_SECONDS = 3;

export interface RemuxPlan {
  videoMimeType: string;
  audioMimeType: string | null;
  videoInit: Uint8Array;
  audioInit: Uint8Array | null;
  durationSeconds: number;
}

export interface RemuxDiagnostics {
  /**
   * How far the whole presentation timeline sits after the source's, in seconds.
   *
   * Reordering forces it: a decoder cannot show a picture it has not decoded, so the first
   * picture cannot be presented at the same instant the first picture is decoded. Both tracks
   * carry the identical shift, so they stay in sync with each other — but the player's clock is
   * this much ahead of the file's, which is what a seek has to account for.
   */
  presentationDelaySeconds: number;
  /** Pictures whose offset had to be clamped because the fixed delay was too small. Should be 0. */
  clampedSamples: number;
  /** The sound is being decoded and encoded again on the way through, rather than copied. */
  transcodedAudio: boolean;
  /** What it was re-encoded as, when it was. Not always AAC — see chooseTranscodeCodec. */
  transcodedCodec: string | null;
  /** Where the last segment built began, on the file's clock. What a seek actually landed on. */
  segmentStartSeconds: number;
}

function aacCodecString(codecPrivate: Uint8Array | null): string {
  // The object type is the first five bits of the AudioSpecificConfig; 2 is AAC-LC, which is
  // what all but a handful of files use.
  const objectType = codecPrivate && codecPrivate.length > 0 ? codecPrivate[0] >> 3 : 2;
  return `mp4a.40.${objectType === 31 ? 2 : objectType}`;
}

function audioCodecString(track: MatroskaTrack): string | null {
  switch (track.codecId) {
    case "A_AAC": return aacCodecString(track.codecPrivate);
    case "A_FLAC": return "flac";
    case "A_AC3": return "ac-3";
    case "A_EAC3": return "ec-3";
    default: return null;
  }
}

function videoCodecString(track: MatroskaTrack): string | null {
  if (!track.codecPrivate) return null;
  if (track.codecId === "V_MPEGH/ISO/HEVC") return hevcCodecString(track.codecPrivate);
  if (track.codecId === "V_MPEG4/ISO/AVC") return avcCodecString(track.codecPrivate);
  return null;
}

/**
 * The MIME types the remuxed segments would carry, derivable from the track headers alone.
 *
 * Worth having separately from `plan()`: opening a remuxer reads from the file — an AC-3 track
 * cannot be described without seeing a frame — and there is no point paying for that before
 * knowing whether the browser would accept the result.
 */
export function plannedMimeTypes(
  videoTrack: MatroskaTrack,
  audioTrack: MatroskaTrack | null,
  file?: MatroskaFile
): { video: string | null; audio: string | null } {
  const video = videoCodecString(videoTrack);
  // What will arrive in the container, which for a re-encoded track is not what is in the file.
  const audio = !audioTrack
    ? null
    : audioDelivery(audioTrack, file) === "transcode"
      ? TRANSCODED_CODEC()
      : audioCodecString(audioTrack);
  return {
    video: video ? `video/mp4; codecs="${video}"` : null,
    audio: audio ? `audio/mp4; codecs="${audio}"` : null,
  };
}

/** Whether this track can be remuxed at all — checked before any of the work starts. */
export function remuxableVideo(track: MatroskaTrack): boolean {
  return videoCodecString(track) !== null;
}

/** What this codec can be described as in an MP4, or null if it cannot. */
export function remuxableAudio(track: MatroskaTrack): boolean {
  return audioCodecString(track) !== null;
}

/** What has to happen to a track's sound for this player to carry it. */
export type AudioDelivery = "copy" | "transcode" | "none";

function naturalDelivery(track: MatroskaTrack): AudioDelivery {
  const natural = audioCodecString(track);
  if (natural && containerAccepts(`audio/mp4; codecs="${natural}"`)) return "copy";
  return transcodableAudio(track) ? "transcode" : "none";
}

/**
 * Whether this browser lets the audio buffer be replaced rather than reinterpreted.
 *
 * Settled by a probe before any file is opened, and it decides which of two designs runs: unify
 * every track onto one codec so no transition can happen, or keep each track's own codec and
 * rebuild the buffer when it changes. The first is what a browser that cannot do the second gets.
 */
let rebuildable = false;

export function setAudioBufferRebuildable(value: boolean): void {
  rebuildable = value;
}

export function audioBufferRebuildable(): boolean {
  return rebuildable;
}

/** What a re-encoded track is delivered as, and therefore what every track is unified to. */
const TRANSCODED_CODEC = () => transcodeTargetCodec();

/**
 * The one codec every audio track of this file will be delivered in — or null when they can all
 * keep their own.
 *
 * This is the design that replaced changing a live buffer's codec, and the reason is worth
 * writing down. A source buffer can be told to reinterpret itself mid-playback, and the
 * specification says so, but this device answers a language change that crosses codecs with
 * "media failed to decode" — sometimes at once, sometimes six seconds later at the next pause —
 * and a decode failure closes the MediaSource and takes the picture with it. Every attempt to
 * make that transition survivable was a guess about someone else's decoder.
 *
 * So the transition is removed instead. If a file's audio tracks cannot all be delivered as they
 * are, they are all delivered re-encoded, decided once when the file is opened. The codec then
 * never changes for the life of the MediaSource, and changing language is what it always should
 * have been: empty the audio buffer, read it again.
 *
 * The cost is real and worth naming: on a file that mixes codecs, a track that could have ridden
 * through untouched is decoded and encoded again. It buys a language change that cannot break
 * playback. A file whose tracks already agree — most of the library — pays nothing.
 */
export function unifiedAudioCodec(file: MatroskaFile): string | null {
  // Not needed where the audio buffer can simply be replaced when the codec changes: there, a
  // track that can ride through untouched does, and only what has to be re-encoded is.
  if (rebuildable) return null;

  const audio = file.tracks.filter((t) => t.type === "audio" && naturalDelivery(t) !== "none");
  if (audio.length < 2) return null;
  const delivered = new Set(
    audio.map((t) => (naturalDelivery(t) === "copy" ? audioCodecString(t) : TRANSCODED_CODEC()))
  );
  if (delivered.size < 2) return null;
  // Unifying is only possible if everything can actually be carried that way.
  return audio.every((t) => audioCodecString(t) === TRANSCODED_CODEC() || transcodableAudio(t))
    ? TRANSCODED_CODEC()
    : null;
}

/**
 * Asked of the browser, not answered from a list.
 *
 * Which codecs a player takes inside a MediaSource is not a property of the codec: an iPhone
 * takes AC-3 there and should carry it through untouched, while Chrome ships no Dolby decoder at
 * all and would otherwise lose the hardware path for most of a library over it. So the question
 * is put to the browser, and only what it declines is decoded and encoded again.
 *
 * Given the file as well, the answer also accounts for the other tracks in it: see
 * {@link unifiedAudioCodec}.
 */
export function audioDelivery(track: MatroskaTrack, file?: MatroskaFile): AudioDelivery {
  const natural = naturalDelivery(track);
  if (!file || natural === "none") return natural;

  const unified = unifiedAudioCodec(file);
  if (!unified) return natural;
  if (natural === "copy" && audioCodecString(track) === unified) return "copy";
  return "transcode";
}

/** Carried through at all — either untouched, or by being decoded and encoded again. */
export function playableAudio(track: MatroskaTrack): boolean {
  return audioDelivery(track) !== "none";
}

/**
 * Builds the box that tells a decoder how to read this audio track.
 *
 * AC-3 and E-AC-3 carry no description in the Matroska header — it has to be read out of a frame.
 * The probe uses its own reader and throws its samples away rather than handing them to the
 * segment builder: the byte source caches what it read, so starting over costs nothing, and there
 * is then no second copy of the opening samples to accidentally emit twice. How far the first
 * audio frame sits from the start varies a lot between files; some open with a long run of video
 * before any sound.
 */
async function describeAudio(
  source: ByteSource,
  file: MatroskaFile,
  start: number,
  track: MatroskaTrack
): Promise<MuxTrackInfo> {
  let firstFrame: Uint8Array | null = null;
  if (track.codecId === "A_AC3" || track.codecId === "A_EAC3") {
    const probe = new SampleReader(source, file, start);
    for (let i = 0; i < 20_000 && !firstFrame; i++) {
      const sample = await probe.next();
      if (!sample) break;
      if (sample.trackNumber === track.number) firstFrame = sample.data;
    }
    if (!firstFrame) throw new Error("Aucune trame audio trouvée pour décrire la piste AC-3.");
  }

  return {
    id: 2,
    kind: "audio",
    timescale: TIMESCALE,
    sampleEntry: audioSampleEntryFor({
      codecId: track.codecId,
      codecPrivate: track.codecPrivate,
      channels: track.audio?.channels ?? 2,
      sampleRate: track.audio?.sampleRate ?? 48000,
      firstFrame,
    }),
    width: 0,
    height: 0,
    language: track.language ?? "und",
  };
}

/** The track description for sound the encoder produces rather than the file supplying. */
/**
 * Refuses a re-encoded track whose result this browser will not take.
 *
 * Checked here, before the description is put anywhere, because the alternative is discovering it
 * by appending: an init segment the browser rejects does not merely fail on Safari, it closes the
 * MediaSource, and the video buffer playing perfectly beside it dies with it.
 */
function assertContainerTakes(transcoder: AudioTranscoder): void {
  const mime = `audio/mp4; codecs="${transcoder.codecString}"`;
  if (containerAccepts(mime)) return;
  transcoder.close();
  throw new Error(`Ce navigateur produit un AAC qu'il n'accepte pas lui-même : ${mime}`);
}

/**
 * Which samples go in which fragment, given how big each one is.
 *
 * Separate from the muxing so it can be exercised on shapes real files rarely produce: a run of
 * tiny pictures, one picture larger than the whole budget, a group that divides evenly.
 */
/**
 * How many pictures beyond a fragment settle its timeline.
 *
 * Separate from the remuxer so the rule can be read and exercised on its own: it is the one thing
 * standing between handing media over early and handing over a timeline that later moves.
 */
function reorderLookahead(delayUs: number | null, frameUs: number | null): number {
  if (delayUs === null || frameUs === null) return REORDER_LOOKAHEAD_GUESS;
  const depth = Math.ceil(delayUs / Math.max(1, frameUs));
  return Math.min(REORDER_LOOKAHEAD_GUESS, depth + REORDER_LOOKAHEAD_MARGIN);
}

function planFragments(count: number, byteLengthOf: (index: number) => number): number[][] {
  const fragments: number[][] = [];
  let from = 0;
  while (from < count) {
    let to = from;
    let bytes = 0;
    // At least one sample, however large it is on its own: a fragment of nothing is not a
    // smaller fragment, it is an infinite loop.
    do {
      bytes += byteLengthOf(to);
      to += 1;
    } while (to < count && to - from < FRAGMENT_SAMPLES && bytes < FRAGMENT_BYTES);
    fragments.push(Array.from({ length: to - from }, (_, i) => from + i));
    from = to;
  }
  return fragments;
}

function transcodedAudioInfo(transcoder: AudioTranscoder, track: MatroskaTrack): MuxTrackInfo {
  return {
    id: 2,
    kind: "audio",
    timescale: TIMESCALE,
    sampleEntry: transcoder.sampleEntry,
    width: 0,
    height: 0,
    language: track.language ?? "und",
  };
}

export class Remuxer {
  private pendingVideo: MediaSample[] = [];
  private pendingAudio: MediaSample[] = [];
  /**
   * Where the last segment's decode timeline ended. Reporting only: decode times are absolute,
   * anchored per segment on its own earliest picture, so nothing is chained off this.
   */
  private videoDecodeTime = 0;
  private encoderRestarts = 0;
  /** How many of the current group's pictures have already been handed over. */
  private emitted = 0;
  /** The picture that closes the current group and opens the next one. */
  private boundary: MediaSample | null = null;
  /** Whether the current group's last picture has been read. */
  private groupClosed = false;
  /** The group's own earliest presentation, fixed once enough of it has been read. */
  private groupAnchorUs: number | null = null;
  /** The typical gap between pictures, for turning a reordering delay into a count of them. */
  private frameDurationUs: number | null = null;
  /**
   * Whether segments should carry their pictures.
   *
   * Lowered while the caller re-reads a stretch it already holds — a change of audio language
   * reads the file again from the playhead, and on a 4K file that meant copying five and eight
   * megabytes of picture into segments that were then dropped.
   */
  private videoWanted = true;
  /** Where a seek asked to be, while the reader is still looking for somewhere to start. */
  private seekTargetUs: number | null = null;
  private backupsLeft = 0;
  /** Read once from the codec's configuration record; see nalLengthSize. */
  private readonly nalLength: number;

  /**
   * Whether a decoder may start on this picture — which is not the same question as whether the
   * container called it a keyframe. See isRandomAccessPoint.
   */
  private startsHere(sample: MediaSample): boolean {
    return sample.isKey && isRandomAccessPoint(sample.data, this.videoTrack.codecId, this.nalLength);
  }
  private presentationDelayUs: number | null = null;
  private audioFrameUs: number | null = null;
  private subtitleNumbersCache: Map<number, MatroskaTrack> | null = null;
  /** Where the segment being built actually starts, on the file's clock. */
  private segmentStartUs = 0;
  /** A seek the transcoder still owes, deferred until that start is known. */
  private transcoderSeekPending = false;
  private videoCuePointsCache: number | null = null;
  private needKeyframe = false;
  private pendingSubtitles: MediaSample[] = [];
  private clampedSamples = 0;
  private sequence = 1;
  private done = false;

  private constructor(
    private readonly file: MatroskaFile,
    private readonly videoTrack: MatroskaTrack,
    private audioTrack: MatroskaTrack | null,
    private readonly videoInfo: MuxTrackInfo,
    private audioInfo: MuxTrackInfo | null,
    /**
     * The same reader the audio probe used, not a fresh one. A second reader would restart at
     * the beginning of the file and hand back the samples the probe already consumed, which
     * duplicates the opening keyframe and shifts the entire presentation timeline.
     */
    private readonly reader: SampleReader,
    private readonly source: ByteSource,
    /** Present only when the chosen track has to be re-encoded to be carried at all. */
    private transcoder: AudioTranscoder | null
  ) {
    this.nalLength = nalLengthSize(videoTrack.codecId, videoTrack.codecPrivate);
  }

  static async open(
    source: ByteSource,
    file: MatroskaFile,
    videoTrack: MatroskaTrack,
    audioTrack: MatroskaTrack | null,
    dimensions: { width: number; height: number }
  ): Promise<Remuxer> {
    if (!remuxableVideo(videoTrack)) throw new Error(`Vidéo non remultiplexable : ${videoTrack.codecId}`);
    if (audioTrack && !playableAudio(audioTrack)) throw new Error(`Audio non remultiplexable : ${audioTrack.codecId}`);

    const start = file.firstClusterOffset ?? file.segmentDataStart;
    // A track that cannot ride in the container is decoded and encoded again on the way through,
    // and the encoder — not the file — is then what describes it.
    const transcoder =
      audioTrack && audioDelivery(audioTrack, file) === "transcode" ? await AudioTranscoder.open(source, audioTrack) : null;
    if (transcoder) assertContainerTakes(transcoder);
    const audioInfo = audioTrack
      ? transcoder
        ? transcodedAudioInfo(transcoder, audioTrack)
        : await describeAudio(source, file, start, audioTrack)
      : null;
    const reader = new SampleReader(source, file, start);

    const videoInfo: MuxTrackInfo = {
      id: 1,
      kind: "video",
      timescale: TIMESCALE,
      sampleEntry: videoSampleEntry(videoTrack.codecId, videoTrack.codecPrivate!, dimensions.width, dimensions.height),
      width: dimensions.width,
      height: dimensions.height,
      language: videoTrack.language ?? "und",
    };

    return new Remuxer(file, videoTrack, audioTrack, videoInfo, audioInfo, reader, source, transcoder);
  }

  plan(): RemuxPlan {
    const duration = this.file.durationSeconds ?? 0;
    return {
      videoMimeType: `video/mp4; codecs="${videoCodecString(this.videoTrack)}"`,
      // Once there is a transcoder, it is the authority on what the audio buffer will carry:
      // `plannedMimeTypes` has to guess before one exists, and an encoder is free to answer with
      // a different profile than the one asked for.
      audioMimeType: !this.audioTrack
        ? null
        : this.transcoder
          ? `audio/mp4; codecs="${this.transcoder.codecString}"`
          : plannedMimeTypes(this.videoTrack, this.audioTrack, this.file).audio,
      videoInit: initSegment(this.videoInfo, duration),
      audioInit: this.audioInfo ? initSegment(this.audioInfo, duration) : null,
      durationSeconds: duration,
    };
  }

  /**
   * Swaps the audio track without disturbing anything else.
   *
   * The video description, the reader and the presentation delay all stay as they are: only the
   * description of the sound and which samples are picked out of the stream change. Rebuilding
   * the whole object instead would tear down the MediaSource the picture is playing through,
   * which stops playback rather than changing its language.
   */
  async setAudioTrack(trackNumber: number): Promise<void> {
    const track = this.file.tracks.find((t) => t.number === trackNumber && t.type === "audio");
    if (!track) throw new Error(`Piste audio ${trackNumber} introuvable.`);
    if (!playableAudio(track)) throw new Error(`Audio non remultiplexable : ${track.codecId}`);

    // Nothing the current track depends on is released until the new one is ready to take over.
    // Closing first and then failing to open leaves no way to produce sound at all — no segments,
    // a buffer that never advances, and a player that loads for ever with nothing to say.
    const previous = this.transcoder;
    const at = this.videoDecodeTime / TIMESCALE;

    if (audioDelivery(track, this.file) === "transcode") {
      // Primed where the viewer is, not at the beginning of the film: two hours in, the opening
      // is long out of the byte source's cache, and fetching it back to read one header is
      // network traffic spent on nothing.
      const next = await AudioTranscoder.open(this.source, track, at);
      // Before anything is released: a refusal here has to leave the working track working.
      assertContainerTakes(next);
      previous?.close();
      this.transcoder = next;
      this.audioInfo = transcodedAudioInfo(next, track);
    } else {
      // Same reasoning for a track that rides through untouched: any frame of it describes it
      // equally well, so the nearest one is read rather than the first.
      const here = clusterOffsetForTime(this.file, this.videoDecodeTime, this.videoTrack.number);
      const start = this.file.firstClusterOffset ?? this.file.segmentDataStart;
      const info =
        (here !== null && here !== start
          ? await describeAudio(this.source, this.file, here, track).catch(() => null)
          : null) ?? (await describeAudio(this.source, this.file, start, track));
      previous?.close();
      this.transcoder = null;
      this.audioInfo = info;
    }

    this.audioTrack = track;
    this.pendingAudio = [];
    this.audioFrameUs = null;
    this.transcoderSeekPending = this.transcoder !== null;
  }

  /** Whether the file carries an index. Without one there is no way to reach a time directly. */
  get seekable(): boolean {
    return this.file.cues.length > 0;
  }

  /** Index entries that actually point at pictures, which is what a seek needs. */
  get videoCuePoints(): number {
    // Counted once: the technical panel reads this twice a second, and a long film's index runs
    // to several thousand entries.
    if (this.videoCuePointsCache === null) {
      this.videoCuePointsCache = this.file.cues.filter((cue) => cue.track === this.videoTrack.number).length;
    }
    return this.videoCuePointsCache;
  }

  /** The subtitle tracks this path can render — the text ones; styled formats are not handled. */
  subtitleTracks(): MatroskaTrack[] {
    return this.file.tracks.filter(
      (t) => t.type === "subtitle" && t.isEnabled && TEXT_SUBTITLE_CODECS.has(t.codecId)
    );
  }

  audioTracks(): MatroskaTrack[] {
    return this.file.tracks.filter((t) => t.type === "audio");
  }

  /** Releases the decoder and encoder a transcoded track holds. */
  close(): void {
    this.transcoder?.close();
    this.transcoder = null;
  }

  diagnostics(): RemuxDiagnostics {
    return {
      presentationDelaySeconds: (this.presentationDelayUs ?? 0) / TIMESCALE,
      clampedSamples: this.clampedSamples,
      transcodedAudio: this.transcoder !== null,
      transcodedCodec: this.transcoder?.codecString ?? null,
      segmentStartSeconds: this.segmentStartUs / TIMESCALE,
    };
  }

  /**
   * Restarts at the cluster containing this time. The caller must clear its source buffers.
   *
   * @param seconds a time on the *source's* clock. A caller working from the player's clock has
   *   to subtract `presentationDelaySeconds` first.
   */
  seekTo(seconds: number): void {
    const offset = clusterOffsetForTime(this.file, Math.round(seconds * 1e6), this.videoTrack.number);
    this.reader.seekTo(offset ?? this.file.firstClusterOffset ?? this.file.segmentDataStart);
    // Deferred, not done here. Reading restarts at the indexed keyframe at or before the
    // requested time, which is regularly the best part of a second earlier — pointing the
    // transcoder at the request instead leaves that much of the segment with pictures and no
    // sound. The segment's real start is known a moment later, and that is what it is given.
    this.transcoderSeekPending = this.transcoder !== null;
    this.pendingVideo = [];
    this.pendingAudio = [];
    this.pendingSubtitles = [];
    // The group being handed over piece by piece is abandoned with everything else.
    this.emitted = 0;
    this.boundary = null;
    this.groupClosed = false;
    this.groupAnchorUs = null;
    this.needKeyframe = true;
    this.seekTargetUs = Math.round(seconds * 1e6);
    this.backupsLeft = MAX_INDEX_BACKUPS;
    this.done = false;
    // Decode times restart at the seek point so the segments land where the player expects them,
    // rather than continuing a timeline that no longer matches the media.
    this.videoDecodeTime = Math.round(seconds * TIMESCALE);
  }

  /** The next pair of segments, or null once the file is exhausted. */
  /**
   * The next piece of media, handed over as soon as it is settled rather than when the keyframe
   * group it belongs to has finished arriving.
   *
   * A picture's decode time is its rank among the group's presentation times, so nothing can be
   * emitted until the pictures that might hold a smaller presentation have been read. But that is
   * a handful of pictures — the reordering depth — and not the whole group. Waiting for the group
   * meant waiting for all of it: five megabytes on an ordinary file, fifteen on the two dozen in
   * this library whose keyframes sit twenty-five seconds apart, against forty milliseconds of
   * actual muxing.
   */
  async nextSegment(): Promise<RemuxSegment | null> {
    if (!(await this.readUntilSettled())) return null;

    const video = this.buildVideo();
    // Built after the video, because the stretch it has to cover is what the video just settled.
    const audio = this.transcoder ? await this.buildTranscodedAudio() : this.buildAudio();
    const subtitles = this.buildSubtitles();
    const endUs = this.videoDecodeTime;

    this.pendingAudio = [];
    this.pendingSubtitles = [];
    return { video, audio, subtitles, endSeconds: endUs / TIMESCALE };
  }

  /** Reads until a fragment's worth of pictures is settled, or the group ends. */
  private async readUntilSettled(): Promise<boolean> {
    // A group handed over to its end starts the next one, on the keyframe that closed it.
    if (this.groupClosed && this.emitted >= this.pendingVideo.length && !this.done) {
      this.pendingVideo = this.boundary ? [this.boundary] : [];
      this.boundary = null;
      this.emitted = 0;
      this.groupClosed = false;
      this.groupAnchorUs = null;
    }

    while (!this.groupClosed && !this.settled()) {
      const sample = await this.reader.next();
      if (!sample) {
        this.done = true;
        this.groupClosed = true;
        break;
      }
      if (sample.trackNumber === this.videoTrack.number) {
        // A cluster does not have to begin on a picture a decoder can start on, and handing over
        // the ones that precede it produces a segment the browser holds but can never show —
        // which looks exactly like a seek that froze.
        if (this.needKeyframe) {
          if (!this.startsHere(sample)) {
            // Past where the viewer asked to be, still with nowhere to start: the index pointed
            // at a picture a decoder cannot begin on, and reading on would land them wherever
            // the next genuine one happens to be — up to ten seconds late. Reading from earlier
            // instead costs a few seconds of pictures nobody sees, and lands them where they
            // asked. Only ever on the file that lies: elsewhere this never runs.
            if (this.seekTargetUs !== null && sample.timestampUs > this.seekTargetUs && this.backUp()) continue;
            continue;
          }
          this.needKeyframe = false;
          this.seekTargetUs = null;
        }
        const span = this.pendingVideo.length > 0 ? sample.timestampUs - this.pendingVideo[0].timestampUs : 0;
        if (this.startsHere(sample) && span >= SEGMENT_US) {
          this.boundary = sample;
          this.groupClosed = true;
          break;
        }
        this.pendingVideo.push(sample);
      } else if (this.audioTrack && !this.transcoder && sample.trackNumber === this.audioTrack.number) {
        this.pendingAudio.push(sample);
      } else if (this.subtitleNumbers.has(sample.trackNumber)) {
        this.pendingSubtitles.push(sample);
      }
    }

    const spent = this.emitted >= this.pendingVideo.length && this.pendingAudio.length === 0 && !this.transcoder;
    return !(this.done && spent);
  }

  /**
   * Whether enough has been read for the next fragment's timeline to be final.
   *
   * Past the reordering depth, what came before cannot move. The depth is measured on the first
   * group of the stream and used for every one after it — which is every seek; the first group is
   * given a generous guess instead, because there is nothing yet to measure it from.
   */
  private settled(): boolean {
    return this.pendingVideo.length - this.emitted >= FRAGMENT_SAMPLES + this.reorderLookahead() + 1;
  }

  private reorderLookahead(): number {
    return reorderLookahead(this.presentationDelayUs, this.frameDurationUs);
  }

  /** The text tracks worth collecting, worked out once and kept by number for the cue builder. */
  private get subtitleNumbers(): Map<number, MatroskaTrack> {
    if (!this.subtitleNumbersCache) {
      this.subtitleNumbersCache = new Map(this.subtitleTracks().map((t) => [t.number, t]));
    }
    return this.subtitleNumbersCache;
  }

  private buildSubtitles(): TrackedCue[] {
    if (this.pendingSubtitles.length === 0) return [];

    // Timed on the player's clock like everything else, so a line appears with the picture it
    // belongs to rather than a fifth of a second before it.
    const delay = (this.presentationDelayUs ?? 0) / TIMESCALE;
    const cues: TrackedCue[] = [];
    for (const sample of this.pendingSubtitles) {
      const track = this.subtitleNumbers.get(sample.trackNumber);
      if (!track) continue;
      const text = subtitleText(new TextDecoder().decode(sample.data), track.codecId);
      if (!text) continue;
      const startSeconds = sample.timestampUs / TIMESCALE + delay;
      cues.push({
        track: sample.trackNumber,
        startSeconds,
        endSeconds:
          startSeconds + (sample.durationUs !== null ? sample.durationUs / TIMESCALE : SUBTITLE_FALLBACK_SECONDS),
        text,
      });
    }
    return cues;
  }

  /**
   * Sound that had to be decoded and encoded again, cut to this segment.
   *
   * Asked for by time rather than handed packets: the transcoder reads the file itself, through
   * the same cache, and runs its own decode and encode pipeline. Cutting at the video segment's
   * own end is what keeps the two tracks tiling together — each segment holds exactly the sound
   * belonging to the pictures beside it.
   */
  private async buildTranscodedAudio(): Promise<Uint8Array | null> {
    if (!this.transcoder || !this.audioInfo) return null;

    if (this.transcoderSeekPending) {
      this.transcoderSeekPending = false;
      this.transcoder.seekTo(this.segmentStartUs / TIMESCALE);
    }

    let frames: TranscodedFrame[];
    try {
      frames = await this.transcoder.framesUpTo(this.videoDecodeTime / TIMESCALE);
    } catch (error) {
      // Safari's own AAC encoder gives up from time to time — "InternalAudioEncoderCocoa encoding
      // failed" — always after a change of track, never at the start, and not reproducibly: the
      // same change succeeds on the next attempt. Nothing about the file or the configuration is
      // wrong, so ending playback over it throws away a session for someone else's hiccup. The
      // encoder is a service; it is closed and opened again where the reader stands.
      frames = await this.retryTranscoder(error);
    }
    if (frames.length === 0) return null;

    const delay = this.presentationDelayUs ?? 0;
    const fallback = Math.round((1024 / this.transcoder.sampleRate) * TIMESCALE);
    const samples: MuxSample[] = frames.map((frame) => ({
      data: frame.data,
      decodeTime: frame.timestampUs + delay,
      duration: Math.max(1, frame.durationUs || fallback),
      compositionOffset: 0,
      isKeyframe: true,
    }));

    return mediaSegment(this.audioInfo, this.sequence, samples);
  }

  /**
   * Builds a fresh transcoder in place of one that failed, and asks it again.
   *
   * Bounded, because an encoder that refuses every time is a real possibility and retrying it for
   * ever would be a player that reads the whole film without ever producing a sound. Past the
   * limit the original failure is raised, which is the one worth reporting.
   */
  private async retryTranscoder(cause: unknown): Promise<TranscodedFrame[]> {
    const track = this.audioTrack;
    if (!track || this.encoderRestarts >= MAX_ENCODER_RESTARTS) throw cause;
    this.encoderRestarts += 1;

    const at = this.segmentStartUs / TIMESCALE;
    trace(`transcodage audio : encodeur en échec, reconstruction (${this.encoderRestarts}) à ${at.toFixed(1)} s`);
    const previous = this.transcoder;
    const next = await AudioTranscoder.open(this.source, track, at);
    assertContainerTakes(next);
    if (previous && next.codecString !== previous.codecString) {
      // The buffer decodes by an initialisation segment already sent; a replacement that
      // describes itself differently cannot take over behind its back.
      next.close();
      throw cause;
    }
    previous?.close();
    this.transcoder = next;
    this.audioInfo = transcodedAudioInfo(next, track);
    next.seekTo(at);
    return next.framesUpTo(this.videoDecodeTime / TIMESCALE);
  }

  /** Whether the pictures read are also written into the segments handed back. */
  setVideoWanted(wanted: boolean): void {
    this.videoWanted = wanted;
  }

  /** Points the reader further back, one step at a time, and says whether it moved. */
  private backUp(): boolean {
    if (this.seekTargetUs === null || this.backupsLeft <= 0) return false;
    const step = MAX_INDEX_BACKUPS - this.backupsLeft + 1;
    this.backupsLeft -= 1;
    const earlier = this.seekTargetUs - INDEX_BACKUP_US * step;
    if (earlier < 0) return false;

    const start = this.file.firstClusterOffset ?? this.file.segmentDataStart;
    this.reader.seekTo(clusterOffsetForTime(this.file, earlier, this.videoTrack.number) ?? start);
    this.pendingVideo = [];
    this.pendingAudio = [];
    this.pendingSubtitles = [];
    trace(
      `index : rien où démarrer avant ${(this.seekTargetUs / 1e6).toFixed(1)} s, ` +
        `relecture depuis ${(earlier / 1e6).toFixed(1)} s`
    );
    return true;
  }

  private buildVideo(): Uint8Array[] {
    if (this.pendingVideo.length === 0 || this.emitted >= this.pendingVideo.length) return [];

    // The whole of the group read so far, not only the part about to be handed over: a picture's
    // decode time is its rank among these presentations, so the rank has to be taken against
    // everything known. What settles it is that the pictures beyond the fragment have been read.
    const presentations = this.pendingVideo.map((s) => s.timestampUs);
    const durations = deriveDurations(presentations, FALLBACK_FRAME_US);

    // Anchored on this group's own earliest picture, not on where the previous one's decode
    // timeline happened to stop. Chaining them looks natural and is wrong: the keyframe that
    // opens a group is first in *decode* order, and several pictures decoded after it are shown
    // before it, so it is not the group's earliest presentation. Anchoring on the keyframe
    // therefore pushed every segment after the first later by that gap — a fifth of a second on a
    // real 4K file, which is the picture drifting away from the sound.
    //
    // Fixed the first time this group is built, and kept. The reordering depth guarantees no
    // picture read later can be shown earlier than one already handed over, so re-deriving it
    // would give the same answer — and if it ever did not, the timeline would move underneath
    // media the browser is already holding.
    this.groupAnchorUs ??= Math.min(...presentations);
    this.segmentStartUs = this.groupAnchorUs;
    const ordered = assignDecodeTimes(
      presentations.map((presentation, i) => ({ presentation, duration: durations[i] })),
      this.segmentStartUs
    );

    // Measured once, on the opening group, then fixed for the whole stream. The audio timeline is
    // moved by the same amount at the same moment, which is the only thing keeping the picture on
    // the sound: shifting the video alone is the classic lip-sync error in a remux.
    if (this.presentationDelayUs === null) {
      this.frameDurationUs = durations[0] || FALLBACK_FRAME_US;
      this.presentationDelayUs = ordered.presentationDelay + DELAY_MARGIN_FRAMES * this.frameDurationUs;
    }
    const delay = this.presentationDelayUs;

    // Only what the reading has settled, and only a fragment of it at a time.
    const from = this.emitted;
    const until = this.groupClosed
      ? this.pendingVideo.length
      : Math.min(this.pendingVideo.length - this.reorderLookahead() - 1, from + FRAGMENT_SAMPLES);
    if (until <= from) return [];

    const samples: MuxSample[] = [];
    for (let i = from; i < until; i++) {
      const sample = this.pendingVideo[i];
      const offset = ordered.samples[i].compositionOffset + delay;
      // A negative offset here would mean this group reorders more deeply than the opening one
      // did. Clamping costs one picture shown a frame early; widening the delay instead would
      // break the timeline everywhere before this point.
      if (offset < 0) this.clampedSamples += 1;
      samples.push({
        data: sample.data,
        decodeTime: ordered.samples[i].decode,
        duration: ordered.samples[i].duration,
        compositionOffset: Math.max(0, offset),
        // The container's word is not enough here either: telling a player that a trailing
        // picture is a sync sample invites it to start decoding there.
        isKeyframe: this.startsHere(sample),
      });
    }
    this.emitted = until;

    // Where the sound is cut: the end of what has just been handed over, not the end of a group
    // that may still be arriving.
    this.videoDecodeTime =
      until >= this.pendingVideo.length ? ordered.endDecodeTime : ordered.samples[until].decode;

    // Everything above still had to happen: the decode times, the presentation delay and where
    // this piece ends are what the sound is cut against, and a reader that stopped keeping track
    // of them would put the next real segment in the wrong place. Only the copying is skipped —
    // which is all of the cost.
    if (!this.videoWanted) return [];
    return this.fragmentise(samples);
  }

  /**
   * Cuts one keyframe group's samples into several fragments.
   *
   * A fragment does not have to be a whole keyframe group — that is what a CMAF chunk is, and
   * what every low-latency packager produces. The group has to be *computed* whole, though, and
   * that is why this happens here and not in the reader: the decode timeline is recovered by
   * sorting a group's presentation times, which only works for a group reordering cannot cross.
   * Cut the samples before that and a B-picture's decode time comes out wrong, which is drift.
   *
   * What it buys: this library's keyframes sit anywhere from nothing to ten seconds apart, so a
   * group can be eight megabytes of pictures handed over in one call. Safari answers one of those
   * — nine seconds, 228 samples, 5.5 MB, at 1951 s of a real file — by closing the MediaSource
   * with "media failed to decode", the same bytes every time.
   */
  private fragmentise(samples: MuxSample[]): Uint8Array[] {
    return planFragments(samples.length, (i) => samples[i].data.byteLength).map((indices) => {
      const from = indices[0];
      const to = indices[indices.length - 1] + 1;
      // The final sample of a fragment states the gap to the next sample's decode time, and at a
      // boundary that sample lives in the next fragment. Reading its own duration there instead
      // leaves the buffered range short of where the next fragment begins — invisible at a
      // constant frame rate, which is exactly how the same mistake hid for a day last time.
      const next = to < samples.length ? samples[to].decodeTime : undefined;
      const segment = mediaSegment(this.videoInfo, this.sequence, samples.slice(from, to), next);
      this.sequence += 1;
      return segment;
    });
  }

  private buildAudio(): Uint8Array | null {
    if (!this.audioInfo || this.pendingAudio.length === 0) return null;

    // Audio is never reordered, so there is nothing to reconstruct — but there is something to
    // undo. Matroska laces: one block holds several audio frames, and every frame in it carries
    // the block's timestamp. Eight E-AC-3 frames sharing one timestamp is normal. Taking the gap
    // between consecutive frames as their duration therefore yields zero for most of them, and
    // the sound then plays far faster than the picture.
    const runs: { timestamp: number; frames: MediaSample[] }[] = [];
    for (const sample of this.pendingAudio) {
      const last = runs[runs.length - 1];
      if (last && last.timestamp === sample.timestampUs) last.frames.push(sample);
      else runs.push({ timestamp: sample.timestampUs, frames: [sample] });
    }

    const delay = this.presentationDelayUs ?? 0;
    const samples: MuxSample[] = [];
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      const next = runs[r + 1];
      // The distance to the next block, split across the frames packed into this one, is the
      // frame duration — no knowledge of the codec's block layout needed. The last run of a
      // segment has no successor, so it reuses the duration measured from the runs before it.
      const frameDuration = next
        ? (next.timestamp - run.timestamp) / run.frames.length
        : (this.audioFrameUs ?? FALLBACK_AUDIO_FRAME_US);
      if (next && run.frames.length > 0) this.audioFrameUs = frameDuration;

      for (let i = 0; i < run.frames.length; i++) {
        // Re-anchored on the block's own timestamp rather than accumulated from the previous
        // segment, so a rounding error cannot build up into audible drift over a two-hour film.
        const decode = Math.round(run.timestamp + i * frameDuration) + delay;
        samples.push({
          data: run.frames[i].data,
          decodeTime: decode,
          duration: Math.max(1, Math.round(frameDuration)),
          compositionOffset: 0,
          isKeyframe: true,
        });
      }
    }

    return mediaSegment(this.audioInfo, this.sequence, samples);
  }
}

export const __testing = {
  planFragments,
  /** Pictures that must be read before the next fragment can be handed over. */
  settledAfter: (delayUs: number | null, frameUs: number | null) =>
    FRAGMENT_SAMPLES + reorderLookahead(delayUs, frameUs) + 1,
};
