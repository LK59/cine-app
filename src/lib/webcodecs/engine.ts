// The experimental player's engine: file in, pictures and sound out.
//
// Three loops run against each other, all bounded so a 40 GB file never becomes 40 GB of memory:
//
//   * demux — pulls samples and feeds the decoders, and stops as soon as either decoder's queue
//     or the frame queue is full. This is the backpressure that keeps everything else honest.
//   * present — a requestAnimationFrame loop that draws whichever decoded frame the clock has
//     reached, and drops any it has already passed.
//   * audio — decoder output goes straight into the AudioContext's own schedule, which is also
//     what the clock reads (see audioOutput.ts for why audio is the master).
//
// Failures are surfaced, never worked around: this player exists to find out whether a file can
// be decoded directly, so a silent fallback to another pipeline would defeat the purpose.

import { HttpByteSource, type ByteSource } from "./byteSource";
import { parseMatroska, clusterOffsetForTime, type MatroskaFile, type MatroskaTrack } from "./matroska";
import { SampleReader } from "./sampleReader";
import { audioConfigFor, videoConfigFor, unsupportedReason } from "./codecConfig";
import { createRenderer, type FrameRenderer } from "./renderer";
import { AudioOutput, WallClock } from "./audioOutput";

export type EngineEventName =
  | "loadedmetadata"
  | "timeupdate"
  | "playing"
  | "pause"
  | "waiting"
  | "ended"
  | "error"
  | "subtitle";

export interface EngineTrack {
  number: number;
  codecId: string;
  language: string | null;
  name: string | null;
  isDefault: boolean;
  isForced: boolean;
}

/** A subtitle line, already decoded to text and timed in seconds. */
export interface SubtitleCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

// Text subtitle codecs the engine can render itself. ASS/SSA are deliberately absent for now:
// they are styled, positioned and often font-embedded, and rendering them badly is worse than
// not offering them — see the roadmap. SRT and plain UTF-8 text carry no styling to lose.
const TEXT_SUBTITLE_CODECS = new Set(["S_TEXT/UTF8", "S_TEXT/ASCII"]);

export interface EngineOptions {
  hdr: boolean;
  /** Mastering peak in nits, when known. Only shifts where the highlight roll-off begins. */
  peakNits?: number;
  startSeconds?: number;
  audioTrackNumber?: number;
}

/** Enough decoded video to ride out a stall, not so much that 4K frames pile up in memory. */
const MAX_QUEUED_FRAMES = 8;
const MAX_DECODE_QUEUE = 12;

/**
 * The cue to show at `seconds`, dropping any that have expired.
 *
 * Mutates the queue on purpose: cues arrive in order and are consumed in order, so discarding
 * the past ones is what keeps this from re-scanning a growing list on every animation frame.
 */
export function selectCue(cues: SubtitleCue[], seconds: number): SubtitleCue | null {
  while (cues.length > 0 && cues[0].endSeconds < seconds) cues.shift();
  return cues.find((cue) => cue.startSeconds <= seconds && cue.endSeconds >= seconds) ?? null;
}

export class PlaybackEngine {
  private source: ByteSource | null = null;
  private file: MatroskaFile | null = null;
  private reader: SampleReader | null = null;
  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private renderer: FrameRenderer | null = null;
  private audio: AudioOutput | null = null;
  private wallClock = new WallClock();

  private videoTrack: MatroskaTrack | null = null;
  private audioTrack: MatroskaTrack | null = null;
  private readonly frames: VideoFrame[] = [];
  /** Subtitle lines read ahead of the playhead, dropped as they expire. */
  private pendingCues: SubtitleCue[] = [];
  private readonly listeners = new Map<EngineEventName, Set<(payload?: unknown) => void>>();

  private playing = false;
  private destroyed = false;
  private demuxing = false;
  private endOfFile = false;
  private rafHandle: number | null = null;
  private lastReportedTime = -1;
  /** Frames before this timestamp are decoded for context after a seek, but never shown. */
  private presentFromUs = 0;

  duration = 0;
  volume = 1;
  muted = false;
  /** Subtitle track currently displayed, or null. */
  private subtitleTrackNumber: number | null = null;
  private activeCue: SubtitleCue | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  // ── events ────────────────────────────────────────────────────────────────

  on(event: EngineEventName, handler: (payload?: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
    return () => set.delete(handler);
  }

  private emit(event: EngineEventName, payload?: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) handler(payload);
  }

  private fail(message: string): void {
    if (this.destroyed) return;
    this.playing = false;
    this.emit("error", message);
  }

  /** The first track this platform will actually decode, asking rather than assuming. */
  private async firstDecodable(tracks: MatroskaTrack[]): Promise<MatroskaTrack | null> {
    for (const track of tracks) {
      const config = audioConfigFor(track);
      if (!config) continue;
      const support = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (support.supported) return track;
    }
    return null;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async load(streamUrl: string, options: EngineOptions): Promise<void> {
    this.source = await HttpByteSource.open(streamUrl);
    this.file = await parseMatroska(this.source);
    this.duration = this.file.durationSeconds ?? 0;

    this.videoTrack = this.file.tracks.find((t) => t.type === "video" && t.isEnabled) ?? null;
    if (!this.videoTrack) throw new Error("Ce fichier n'a pas de piste vidéo lisible.");

    const audioCandidates = this.file.tracks.filter((t) => t.type === "audio" && t.isEnabled);
    // An explicit choice always wins. Otherwise the default track is preferred, but only if the
    // platform can actually decode it: on a library where most default tracks are AC3/E-AC3,
    // silently picking one this browser cannot decode when a playable track sits right beside it
    // would be a worse answer than switching language.
    this.audioTrack = audioCandidates.find((t) => t.number === options.audioTrackNumber) ?? null;
    if (!this.audioTrack) {
      const preferred = audioCandidates.find((t) => t.isDefault) ?? audioCandidates[0] ?? null;
      this.audioTrack = (await this.firstDecodable(preferred ? [preferred, ...audioCandidates] : audioCandidates)) ?? preferred;
    }

    const videoConfig = videoConfigFor(this.videoTrack);
    if (!videoConfig) throw new Error(unsupportedReason(this.videoTrack) ?? "Piste vidéo non prise en charge.");

    // Asked before configuring, so an unsupported profile is reported as such instead of
    // surfacing later as an opaque decoder error.
    const support = await VideoDecoder.isConfigSupported(videoConfig);
    if (!support.supported) {
      throw new Error(`Ce navigateur ne sait pas décoder ${videoConfig.codec} (${this.videoTrack.codecId}).`);
    }

    this.renderer = createRenderer(this.canvas, { hdr: options.hdr, peakNits: options.peakNits });

    this.videoDecoder = new VideoDecoder({
      output: (frame) => this.onVideoFrame(frame),
      error: (error) => this.fail(`Décodage vidéo interrompu : ${error.message}`),
    });
    this.videoDecoder.configure(videoConfig);

    if (this.audioTrack) {
      const audioConfig = audioConfigFor(this.audioTrack);
      if (!audioConfig) {
        // Not fatal on its own — the caller decides whether a silent film is acceptable — but it
        // is reported so the UI can say exactly which codec is missing.
        this.emit("error", unsupportedReason(this.audioTrack) ?? "Piste audio non prise en charge.");
        this.audioTrack = null;
      } else {
        const audioSupport = await AudioDecoder.isConfigSupported(audioConfig).catch(() => ({ supported: false }));
        if (!audioSupport.supported) {
          this.emit("error", `Ce navigateur ne sait pas décoder l'audio ${this.audioTrack.codecId}.`);
          this.audioTrack = null;
        } else {
          this.audio = new AudioOutput({ sampleRate: audioConfig.sampleRate, numberOfChannels: audioConfig.numberOfChannels });
          this.audioDecoder = new AudioDecoder({
            output: (data) => this.onAudioData(data),
            error: (error) => this.fail(`Décodage audio interrompu : ${error.message}`),
          });
          this.audioDecoder.configure(audioConfig);
        }
      }
    }

    const startUs = Math.round((options.startSeconds ?? 0) * 1e6);
    this.reader = new SampleReader(this.source, this.file, clusterOffsetForTime(this.file, startUs) ?? this.file.firstClusterOffset ?? 0);
    this.presentFromUs = startUs;
    this.wallClock.seek(startUs / 1e6);
    this.emit("loadedmetadata");

    // Fill the pipeline before reporting readiness, so pressing play starts on a picture rather
    // than on a blank canvas.
    await this.pump();
    this.startPresenting();
  }

  destroy(): void {
    this.destroyed = true;
    this.playing = false;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    for (const frame of this.frames) frame.close();
    this.frames.length = 0;
    try { this.videoDecoder?.close(); } catch { /* already closed */ }
    try { this.audioDecoder?.close(); } catch { /* already closed */ }
    this.renderer?.destroy();
    void this.audio?.close();
    this.source?.close();
  }

  // ── tracks ────────────────────────────────────────────────────────────────

  get audioTracks(): EngineTrack[] {
    return (this.file?.tracks ?? [])
      .filter((t) => t.type === "audio" && t.isEnabled)
      .map((t) => ({ number: t.number, codecId: t.codecId, language: t.language, name: t.name, isDefault: t.isDefault, isForced: t.isForced }));
  }

  get subtitleTracks(): EngineTrack[] {
    return (this.file?.tracks ?? [])
      .filter((t) => t.type === "subtitle" && t.isEnabled && TEXT_SUBTITLE_CODECS.has(t.codecId))
      .map((t) => ({ number: t.number, codecId: t.codecId, language: t.language, name: t.name, isDefault: t.isDefault, isForced: t.isForced }));
  }

  get currentAudioTrack(): number | null {
    return this.audioTrack?.number ?? null;
  }

  get currentSubtitleTrack(): number | null {
    return this.subtitleTrackNumber;
  }

  /**
   * Switches audio track without interrupting the picture.
   *
   * Both tracks live in the same clusters, so this is a decoder change rather than a new stream:
   * reconfigure, then re-read from the current position so the new track's samples for the
   * moment being watched actually exist. Nothing is re-fetched from the server that the byte
   * cache doesn't already hold.
   */
  async setAudioTrack(trackNumber: number): Promise<void> {
    const track = this.file?.tracks.find((t) => t.number === trackNumber && t.type === "audio");
    if (!track || track.number === this.audioTrack?.number) return;

    const config = audioConfigFor(track);
    if (!config) {
      this.emit("error", unsupportedReason(track) ?? "Piste audio non prise en charge.");
      return;
    }
    const support = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!support.supported) {
      this.emit("error", `Ce navigateur ne sait pas décoder l'audio ${track.codecId}.`);
      return;
    }

    const resumeAt = this.currentTime;
    this.audioTrack = track;
    try { this.audioDecoder?.close(); } catch { /* already closed */ }
    await this.audio?.close();

    this.audio = new AudioOutput({ sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels });
    this.audio.setVolume(this.volume, this.muted);
    this.audioDecoder = new AudioDecoder({
      output: (data) => this.onAudioData(data),
      error: (error) => this.fail(`Décodage audio interrompu : ${error.message}`),
    });
    this.audioDecoder.configure(config);
    await this.seek(resumeAt);
  }

  /** Null turns subtitles off. */
  setSubtitleTrack(trackNumber: number | null): void {
    this.subtitleTrackNumber = trackNumber;
    this.activeCue = null;
    this.emit("subtitle", null);
  }

  // ── transport ─────────────────────────────────────────────────────────────

  get currentTime(): number {
    if (this.audio?.primed) return this.audio.currentMediaTime();
    return this.wallClock.currentMediaTime();
  }

  get paused(): boolean {
    return !this.playing;
  }

  async play(): Promise<void> {
    if (this.destroyed || this.playing) return;
    this.playing = true;
    await this.audio?.resume();
    if (!this.audio) this.wallClock.start(this.wallClock.currentMediaTime());
    this.emit("playing");
    void this.pump();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    void this.audio?.suspend();
    this.wallClock.stop();
    this.emit("pause");
  }

  setVolume(volume: number, muted: boolean): void {
    this.volume = volume;
    this.muted = muted;
    this.audio?.setVolume(volume, muted);
  }

  async seek(seconds: number): Promise<void> {
    if (!this.file || !this.reader || this.destroyed) return;
    const target = Math.max(0, Math.min(seconds, this.duration || seconds));
    const targetUs = Math.round(target * 1e6);

    // Decoders keep state across pictures; feeding them post-seek samples without a reset would
    // decode the new keyframe against the old reference frames and produce visible corruption.
    this.videoDecoder?.reset();
    this.audioDecoder?.reset();
    const videoConfig = this.videoTrack ? videoConfigFor(this.videoTrack) : null;
    if (videoConfig) this.videoDecoder?.configure(videoConfig);
    const audioConfig = this.audioTrack ? audioConfigFor(this.audioTrack) : null;
    if (audioConfig) this.audioDecoder?.configure(audioConfig);

    for (const frame of this.frames) frame.close();
    this.frames.length = 0;
    this.pendingCues = [];
    this.activeCue = null;
    this.emit("subtitle", null);
    this.audio?.flush(target);
    this.wallClock.seek(target);
    this.endOfFile = false;
    this.presentFromUs = targetUs;

    this.reader.seekTo(clusterOffsetForTime(this.file, targetUs) ?? this.file.firstClusterOffset ?? 0);
    this.emit("waiting");
    await this.pump();
    this.emit("timeupdate", target);
  }

  // ── decode ────────────────────────────────────────────────────────────────

  private onVideoFrame(frame: VideoFrame): void {
    if (this.destroyed) {
      frame.close();
      return;
    }
    // A seek decodes from the preceding keyframe, so the frames between it and the target are
    // needed as references but must never be shown.
    if (frame.timestamp + (frame.duration ?? 0) < this.presentFromUs) {
      frame.close();
      return;
    }
    this.frames.push(frame);
  }

  private onAudioData(data: AudioData): void {
    if (this.destroyed || !this.audio) {
      data.close();
      return;
    }
    if (data.timestamp + data.duration < this.presentFromUs) {
      data.close();
      return;
    }
    this.audio.enqueue(data, data.timestamp / 1e6);
    data.close();
  }

  /** Feeds the decoders until something downstream is full, or the file ends. */
  private async pump(): Promise<void> {
    if (this.demuxing || this.destroyed || !this.reader) return;
    this.demuxing = true;
    try {
      for (;;) {
        if (this.destroyed || this.endOfFile) return;
        if (this.frames.length >= MAX_QUEUED_FRAMES) return;
        if ((this.videoDecoder?.decodeQueueSize ?? 0) >= MAX_DECODE_QUEUE) return;
        if (this.audio && !this.audio.needsMore && this.frames.length > 2) return;

        const sample = await this.reader.next();
        if (!sample) {
          this.endOfFile = true;
          await this.videoDecoder?.flush().catch(() => {});
          await this.audioDecoder?.flush().catch(() => {});
          return;
        }

        if (this.videoTrack && sample.trackNumber === this.videoTrack.number && this.videoDecoder?.state === "configured") {
          this.videoDecoder.decode(
            new EncodedVideoChunk({
              type: sample.isKey ? "key" : "delta",
              timestamp: sample.timestampUs,
              ...(sample.durationUs !== null ? { duration: sample.durationUs } : {}),
              data: sample.data,
            })
          );
        } else if (this.subtitleTrackNumber !== null && sample.trackNumber === this.subtitleTrackNumber) {
          // Text subtitles are not decoded, only timed: the block payload is the line itself, and
          // its duration is how long it stays up.
          const text = new TextDecoder().decode(sample.data).trim();
          if (text) {
            this.pendingCues.push({
              startSeconds: sample.timestampUs / 1e6,
              endSeconds: (sample.timestampUs + (sample.durationUs ?? 3_000_000)) / 1e6,
              text,
            });
          }
        } else if (this.audioTrack && sample.trackNumber === this.audioTrack.number && this.audioDecoder?.state === "configured") {
          this.audioDecoder.decode(
            new EncodedAudioChunk({
              type: "key",
              timestamp: sample.timestampUs,
              ...(sample.durationUs !== null ? { duration: sample.durationUs } : {}),
              data: sample.data,
            })
          );
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Lecture interrompue.");
    } finally {
      this.demuxing = false;
    }
  }

  /** Emits only on change, so the overlay isn't re-rendered sixty times a second. */
  private updateSubtitle(seconds: number): void {
    if (this.subtitleTrackNumber === null) return;
    const due = selectCue(this.pendingCues, seconds);
    if (due?.text !== this.activeCue?.text) {
      this.activeCue = due;
      this.emit("subtitle", due?.text ?? null);
    }
  }

  // ── present ───────────────────────────────────────────────────────────────

  private startPresenting(): void {
    const tick = () => {
      if (this.destroyed) return;
      this.rafHandle = requestAnimationFrame(tick);
      this.presentDueFrame();
      void this.pump();
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private presentDueFrame(): void {
    if (this.frames.length === 0) {
      if (this.playing && this.endOfFile) {
        this.playing = false;
        this.emit("ended");
      } else if (this.playing) {
        this.emit("waiting");
      }
      return;
    }

    const nowUs = this.currentTime * 1e6;
    // Paused still draws the first pending frame once — that is what makes a seek show its
    // destination instead of leaving the previous picture on screen.
    if (!this.playing) {
      const frame = this.frames.shift();
      if (frame) {
        void this.renderer?.draw(frame);
        frame.close();
      }
      return;
    }

    let drawn: VideoFrame | null = null;
    while (this.frames.length > 0 && this.frames[0].timestamp <= nowUs) {
      const frame = this.frames.shift()!;
      // Only the newest due frame is drawn; anything older is already late and drawing it would
      // cost a blit to show a picture the viewer would never perceive.
      drawn?.close();
      drawn = frame;
    }
    if (drawn) {
      void this.renderer?.draw(drawn);
      drawn.close();
    }

    const seconds = this.currentTime;
    this.updateSubtitle(seconds);
    if (Math.abs(seconds - this.lastReportedTime) >= 0.2) {
      this.lastReportedTime = seconds;
      this.emit("timeupdate", seconds);
    }
  }
}
