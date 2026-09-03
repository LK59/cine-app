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
import { avcCodecString, hevcCodecString } from "./codecConfig";
import type { MatroskaFile, MatroskaTrack, MediaSample } from "./matroska";
import { clusterOffsetForTime } from "./matroska";
import { initSegment, mediaSegment, type MuxSample, type MuxTrackInfo } from "./mp4Muxer";
import { audioSampleEntryFor, videoSampleEntry } from "./mp4SampleEntries";
import { AudioTranscoder, transcodableAudio } from "./audioTranscode";
import { containerAccepts } from "./mseSource";
import { SampleReader } from "./sampleReader";
import type { ByteSource } from "./byteSource";

/** Microseconds — Matroska's own precision, so sample times are copied rather than rescaled. */
const TIMESCALE = 1_000_000;

/** Roughly how much media each segment carries. Cut at keyframes, so it is a floor, not a target. */
const SEGMENT_US = 2_000_000;

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
  video: Uint8Array | null;
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
      ? TRANSCODED_CODEC
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

/** What a re-encoded track is delivered as, and therefore what every track is unified to. */
const TRANSCODED_CODEC = "mp4a.40.2";

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
  const audio = file.tracks.filter((t) => t.type === "audio" && naturalDelivery(t) !== "none");
  if (audio.length < 2) return null;
  const delivered = new Set(
    audio.map((t) => (naturalDelivery(t) === "copy" ? audioCodecString(t) : TRANSCODED_CODEC))
  );
  if (delivered.size < 2) return null;
  // Unifying is only possible if everything can actually be carried that way.
  return audio.every((t) => audioCodecString(t) === TRANSCODED_CODEC || transcodableAudio(t))
    ? TRANSCODED_CODEC
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
  ) {}

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
    this.needKeyframe = true;
    this.done = false;
    // Decode times restart at the seek point so the segments land where the player expects them,
    // rather than continuing a timeline that no longer matches the media.
    this.videoDecodeTime = Math.round(seconds * TIMESCALE);
  }

  /** The next pair of segments, or null once the file is exhausted. */
  async nextSegment(): Promise<RemuxSegment | null> {
    if (this.done) return null;

    // Read until a keyframe closes a segment of at least the target length. The keyframe that
    // ends this segment starts the next one, and knowing its time is what lets the previous
    // sample be given its true duration rather than an estimate.
    let boundary: MediaSample | null = null;
    for (;;) {
      const sample = await this.reader.next();
      if (!sample) {
        this.done = true;
        break;
      }
      if (sample.trackNumber === this.videoTrack.number) {
        // A cluster does not have to begin on a keyframe, and a decoder cannot start anywhere
        // else. Handing over the pictures that precede one produces a segment the browser holds
        // but can never show — which looks exactly like a seek that froze.
        if (this.needKeyframe) {
          if (!sample.isKey) continue;
          this.needKeyframe = false;
        }
        const span = this.pendingVideo.length > 0 ? sample.timestampUs - this.pendingVideo[0].timestampUs : 0;
        if (sample.isKey && span >= SEGMENT_US) {
          boundary = sample;
          break;
        }
        this.pendingVideo.push(sample);
      } else if (this.audioTrack && !this.transcoder && sample.trackNumber === this.audioTrack.number) {
        this.pendingAudio.push(sample);
      } else if (this.subtitleNumbers.has(sample.trackNumber)) {
        this.pendingSubtitles.push(sample);
      }
    }

    if (this.pendingVideo.length === 0 && this.pendingAudio.length === 0 && !this.transcoder) return null;

    const video = this.buildVideo();
    // Built after the video, because the stretch it has to cover is what the video just settled.
    const audio = this.transcoder ? await this.buildTranscodedAudio() : this.buildAudio();
    const subtitles = this.buildSubtitles();
    const endUs = this.videoDecodeTime;

    this.pendingVideo = boundary ? [boundary] : [];
    this.pendingAudio = [];
    this.pendingSubtitles = [];
    this.sequence += 1;

    return { video, audio, subtitles, endSeconds: endUs / TIMESCALE };
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

    const frames = await this.transcoder.framesUpTo(this.videoDecodeTime / TIMESCALE);
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

  private buildVideo(): Uint8Array | null {
    if (this.pendingVideo.length === 0) return null;

    const presentations = this.pendingVideo.map((s) => s.timestampUs);
    const durations = deriveDurations(presentations, FALLBACK_FRAME_US);

    // Anchored on this segment's own earliest picture, not on where the previous segment's decode
    // timeline happened to stop. Chaining them looks natural and is wrong: the keyframe that
    // opens a segment is first in *decode* order, and several pictures decoded after it are shown
    // before it, so it is not the segment's earliest presentation. Anchoring on the keyframe
    // therefore pushed every segment after the first later by that gap — a fifth of a second on a
    // real 4K file, which is the picture drifting away from the sound.
    this.segmentStartUs = Math.min(...presentations);
    const ordered = assignDecodeTimes(
      presentations.map((presentation, i) => ({ presentation, duration: durations[i] })),
      this.segmentStartUs
    );

    // Measured once, on the opening segment, then fixed for the whole stream. The audio timeline
    // is moved by the same amount at the same moment, which is the only thing keeping the picture
    // on the sound: shifting the video alone is the classic lip-sync error in a remux.
    if (this.presentationDelayUs === null) {
      this.presentationDelayUs = ordered.presentationDelay + DELAY_MARGIN_FRAMES * (durations[0] || FALLBACK_FRAME_US);
    }
    const delay = this.presentationDelayUs;

    const samples: MuxSample[] = this.pendingVideo.map((sample, i) => {
      const offset = ordered.samples[i].compositionOffset + delay;
      // A negative offset here would mean this segment reorders more deeply than the opening one
      // did. Clamping costs one picture shown a frame early; widening the delay instead would
      // break the timeline everywhere before this point.
      if (offset < 0) this.clampedSamples += 1;
      return {
        data: sample.data,
        decodeTime: ordered.samples[i].decode,
        duration: ordered.samples[i].duration,
        compositionOffset: Math.max(0, offset),
        isKeyframe: sample.isKey,
      };
    });

    this.videoDecodeTime = ordered.endDecodeTime;
    return mediaSegment(this.videoInfo, this.sequence, samples);
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
