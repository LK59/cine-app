// Turns a Matroska file into the segment stream a MediaSource eats, without touching a single
// byte of the compressed video or audio.
//
// The samples inside Matroska are already exactly what MP4 wants — HEVC and AVC access units
// prefixed by their length, AC-3 and AAC frames as they are. Only the packaging differs. So this
// copies samples verbatim and rebuilds the wrapper around them, which is why it costs almost
// nothing and, unlike the WebCodecs path, hands the decoding back to the browser's own hardware
// pipeline: no canvas, no per-frame JavaScript, no colour conversion, HDR handled natively.

import { deriveDurations, assignDecodeTimes } from "./decodeOrder";
import { avcCodecString, hevcCodecString } from "./codecConfig";
import type { MatroskaFile, MatroskaTrack, MediaSample } from "./matroska";
import { clusterOffsetForTime } from "./matroska";
import { initSegment, mediaSegment, type MuxSample, type MuxTrackInfo } from "./mp4Muxer";
import { audioSampleEntryFor, videoSampleEntry } from "./mp4SampleEntries";
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

export interface RemuxSegment {
  video: Uint8Array | null;
  audio: Uint8Array | null;
  /** Presentation time of the end of this segment, in seconds. */
  endSeconds: number;
}

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

/** Whether this track can be remuxed at all — checked before any of the work starts. */
export function remuxableVideo(track: MatroskaTrack): boolean {
  return videoCodecString(track) !== null;
}

export function remuxableAudio(track: MatroskaTrack): boolean {
  return audioCodecString(track) !== null;
}

export class Remuxer {
  private pendingVideo: MediaSample[] = [];
  private pendingAudio: MediaSample[] = [];
  private videoDecodeTime = 0;
  private audioDecodeTime = 0;
  private presentationDelayUs: number | null = null;
  private audioFrameUs: number | null = null;
  private clampedSamples = 0;
  private sequence = 1;
  private done = false;

  private constructor(
    private readonly file: MatroskaFile,
    private readonly videoTrack: MatroskaTrack,
    private readonly audioTrack: MatroskaTrack | null,
    private readonly videoInfo: MuxTrackInfo,
    private readonly audioInfo: MuxTrackInfo | null,
    /**
     * The same reader the audio probe used, not a fresh one. A second reader would restart at
     * the beginning of the file and hand back the samples the probe already consumed, which
     * duplicates the opening keyframe and shifts the entire presentation timeline.
     */
    private readonly reader: SampleReader
  ) {}

  static async open(
    source: ByteSource,
    file: MatroskaFile,
    videoTrack: MatroskaTrack,
    audioTrack: MatroskaTrack | null,
    dimensions: { width: number; height: number }
  ): Promise<Remuxer> {
    if (!remuxableVideo(videoTrack)) throw new Error(`Vidéo non remultiplexable : ${videoTrack.codecId}`);
    if (audioTrack && !remuxableAudio(audioTrack)) throw new Error(`Audio non remultiplexable : ${audioTrack.codecId}`);

    const start = file.firstClusterOffset ?? file.segmentDataStart;

    // AC-3 and E-AC-3 carry no description in the Matroska header: it has to be read out of a
    // frame. The probe uses its own reader and throws its samples away rather than handing them
    // to the segment builder — the byte source caches what it read, so starting over costs
    // nothing, and there is then no second copy of the opening samples to accidentally emit
    // twice. How far the first audio frame sits from the start varies a lot between files: some
    // open with a long run of video before any sound.
    let firstAudioFrame: Uint8Array | null = null;
    if (audioTrack && (audioTrack.codecId === "A_AC3" || audioTrack.codecId === "A_EAC3")) {
      const probe = new SampleReader(source, file, start);
      for (let i = 0; i < 20_000 && !firstAudioFrame; i++) {
        const sample = await probe.next();
        if (!sample) break;
        if (sample.trackNumber === audioTrack.number) firstAudioFrame = sample.data;
      }
      if (!firstAudioFrame) throw new Error("Aucune trame audio trouvée pour décrire la piste AC-3.");
    }

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

    const audioInfo: MuxTrackInfo | null = audioTrack
      ? {
          id: 2,
          kind: "audio",
          timescale: TIMESCALE,
          sampleEntry: audioSampleEntryFor({
            codecId: audioTrack.codecId,
            codecPrivate: audioTrack.codecPrivate,
            channels: audioTrack.audio?.channels ?? 2,
            sampleRate: audioTrack.audio?.sampleRate ?? 48000,
            firstFrame: firstAudioFrame,
          }),
          width: 0,
          height: 0,
          language: audioTrack.language ?? "und",
        }
      : null;

    return new Remuxer(file, videoTrack, audioTrack, videoInfo, audioInfo, reader);
  }

  plan(): RemuxPlan {
    const duration = this.file.durationSeconds ?? 0;
    return {
      videoMimeType: `video/mp4; codecs="${videoCodecString(this.videoTrack)}"`,
      audioMimeType: this.audioTrack ? `audio/mp4; codecs="${audioCodecString(this.audioTrack)}"` : null,
      videoInit: initSegment(this.videoInfo, duration),
      audioInit: this.audioInfo ? initSegment(this.audioInfo, duration) : null,
      durationSeconds: duration,
    };
  }

  diagnostics(): RemuxDiagnostics {
    return {
      presentationDelaySeconds: (this.presentationDelayUs ?? 0) / TIMESCALE,
      clampedSamples: this.clampedSamples,
    };
  }

  /**
   * Restarts at the cluster containing this time. The caller must clear its source buffers.
   *
   * @param seconds a time on the *source's* clock. A caller working from the player's clock has
   *   to subtract `presentationDelaySeconds` first.
   */
  seekTo(seconds: number): void {
    const offset = clusterOffsetForTime(this.file, Math.round(seconds * 1e6));
    this.reader.seekTo(offset ?? this.file.firstClusterOffset ?? this.file.segmentDataStart);
    this.pendingVideo = [];
    this.pendingAudio = [];
    this.done = false;
    // Decode times restart at the seek point so the segments land where the player expects them,
    // rather than continuing a timeline that no longer matches the media.
    this.videoDecodeTime = Math.round(seconds * TIMESCALE);
    this.audioDecodeTime = this.videoDecodeTime + (this.presentationDelayUs ?? 0);
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
        const span = this.pendingVideo.length > 0 ? sample.timestampUs - this.pendingVideo[0].timestampUs : 0;
        if (sample.isKey && span >= SEGMENT_US) {
          boundary = sample;
          break;
        }
        this.pendingVideo.push(sample);
      } else if (this.audioTrack && sample.trackNumber === this.audioTrack.number) {
        this.pendingAudio.push(sample);
      }
    }

    if (this.pendingVideo.length === 0 && this.pendingAudio.length === 0) return null;

    const video = this.buildVideo();
    const audio = this.buildAudio();
    const endUs = this.videoDecodeTime;

    this.pendingVideo = boundary ? [boundary] : [];
    this.pendingAudio = [];
    this.sequence += 1;

    return { video, audio, endSeconds: endUs / TIMESCALE };
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
    const ordered = assignDecodeTimes(
      presentations.map((presentation, i) => ({ presentation, duration: durations[i] })),
      Math.min(...presentations)
    );

    // Measured once, on the opening segment, then fixed for the whole stream. The audio timeline
    // is moved by the same amount at the same moment, which is the only thing keeping the picture
    // on the sound: shifting the video alone is the classic lip-sync error in a remux.
    if (this.presentationDelayUs === null) {
      this.presentationDelayUs = ordered.presentationDelay + DELAY_MARGIN_FRAMES * (durations[0] || FALLBACK_FRAME_US);
      this.audioDecodeTime += this.presentationDelayUs;
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

    this.audioDecodeTime = samples[samples.length - 1].decodeTime + samples[samples.length - 1].duration;
    return mediaSegment(this.audioInfo, this.sequence, samples);
  }
}
