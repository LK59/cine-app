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
import { parseMatroska, clusterOffsetForTime, type MatroskaFile, type MatroskaTrack, type MediaSample } from "./matroska";
import { SampleReader } from "./sampleReader";
import { audioConfigCandidates, audioConfigFor, videoConfigFor, unsupportedReason } from "./codecConfig";
import { createRenderer, type FrameRenderer } from "./renderer";
import type { AudioConfig } from "./codecConfig";
import { AudioOutput, WallClock } from "./audioOutput";
import { SoftwareAudioTrack } from "./softwareAudio";

export type EngineEventName =
  | "loadedmetadata"
  | "timeupdate"
  | "playing"
  | "pause"
  | "waiting"
  | "ended"
  | "error"
  | "warning"
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

/** Non-fatal: playback continues, the viewer is told. Distinct from "error", which stops it. */
// Text subtitle codecs the engine can render itself. ASS/SSA are deliberately absent for now:
// they are styled, positioned and often font-embedded, and rendering them badly is worse than
// not offering them — see the roadmap. SRT and plain UTF-8 text carry no styling to lose.
const TEXT_SUBTITLE_CODECS = new Set(["S_TEXT/UTF8", "S_TEXT/ASCII", "S_TEXT/ASS", "S_TEXT/SSA"]);

/**
 * The displayable text of a subtitle block.
 *
 * SRT blocks are the line itself. ASS blocks are the tail of a Dialogue row — nine
 * comma-separated fields before the text — carrying inline override tags like {\i1}. Those are
 * stripped rather than honoured: styled positioning is out of scope, but throwing the track away
 * over its styling would leave 218 files in this library with no subtitles at all when the text
 * is right there.
 */
export function subtitleText(raw: string, codecId: string): string {
  if (codecId !== "S_TEXT/ASS" && codecId !== "S_TEXT/SSA") return raw.trim();
  const fields = raw.split(",");
  const text = fields.length > 8 ? fields.slice(8).join(",") : raw;
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/gi, "\n")
    .replace(/\\h/gi, " ")
    .trim();
}

export interface EngineOptions {
  hdr: boolean;
  /** Mastering peak in nits, when known. Only shifts where the highlight roll-off begins. */
  peakNits?: number;
  startSeconds?: number;
  audioTrackNumber?: number;
}

/**
 * Codec strings a browser claimed to support and then decoded nothing from.
 *
 * This project already learned this the hard way on the stable player: an iPhone's capability
 * query claims E-AC-3 and its pipeline then produces nothing at all — no error, no samples, just
 * silence. A capability query is a claim; the only trustworthy probe is a real decode. Kept in
 * localStorage so the lie is discovered once per device rather than on every playback.
 */
const AUDIO_LIAR_KEY = "cine:webcodecs-audio-liars:v1";

function readAudioLiars(): string[] {
  try {
    const raw = localStorage.getItem(AUDIO_LIAR_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function rememberAudioLiar(codec: string): void {
  try {
    const liars = new Set(readAudioLiars());
    liars.add(codec);
    localStorage.setItem(AUDIO_LIAR_KEY, JSON.stringify([...liars]));
  } catch {
    // Storage unavailable — the check still works for this session.
  }
}

// Enough decoded video to ride out a stall, not so much that it becomes the problem. The depth
// is chosen from the resolution because a decoded frame is not a small object: eight 4K frames
// are on the order of a hundred megabytes of GPU memory, which on a phone buys a stutter of a
// different kind. Below 4K the frames are small enough that a deeper queue is free.
function queueDepthFor(width: number, height: number): { frames: number; decode: number } {
  const pixels = width * height;
  if (pixels >= 3840 * 1600) return { frames: 4, decode: 6 };
  if (pixels >= 1920 * 1080) return { frames: 6, decode: 8 };
  return { frames: 8, decode: 12 };
}

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
  /** The exact configuration the platform accepted, reused verbatim on every reconfigure. */
  private audioConfig: AudioConfig | null = null;
  /** Set instead of audioDecoder when the platform has no decoder for this track. */
  private softwareAudio: SoftwareAudioTrack | null = null;
  private audioPath: "native" | "software" | "none" = "none";
  private audioDiagnostic: string | null = null;
  /** Decoded blocks that came OUT of the decoder. */
  private audioChunks = 0;
  /** Encoded blocks fed IN. The gap between the two is what exposes a decoder that lies. */
  private audioFed = 0;
  private demotingAudio = false;
  private softwareAudioGeneration = 0;
  private readonly frames: VideoFrame[] = [];
  /**
   * Encoded video samples read but not yet handed to the decoder.
   *
   * Audio and video are interleaved in the file, so the only way to reach the next audio sample
   * is to read past the video samples in front of it. Stopping the read because the video queue
   * is full therefore starves the audio — which is exactly what happened. Video that has nowhere
   * to go waits here instead, and the read continues. These are compressed samples: tens of them
   * are a few megabytes, against a hundred for the same number of decoded 4K frames.
   */
  private pendingVideo: MediaSample[] = [];
  /**
   * Subtitle lines per track, read ahead of the playhead and dropped as they expire.
   *
   * Every text track is collected, not just the selected one: cues only exist in the clusters
   * being read, so collecting on selection meant switching subtitles showed nothing until
   * playback reached the next cluster — which reads as a broken button. Parsing a few lines of
   * text per cluster costs nothing.
   */
  private pendingCues = new Map<number, SubtitleCue[]>();
  private readonly listeners = new Map<EngineEventName, Set<(payload?: unknown) => void>>();

  private playing = false;
  private destroyed = false;
  private demuxing = false;
  private endOfFile = false;
  /**
   * A freshly configured or reset decoder refuses anything but a keyframe — it answers "Key frame
   * is required" and dies. Samples are therefore dropped until the first one arrives, which also
   * covers the race where a demux started before a seek delivers an old delta frame afterwards.
   */
  private needsKeyframe = true;
  /**
   * Bumped by every seek. A demux pass that started before it aborts instead of feeding the
   * decoder samples from where the viewer no longer is.
   */
  private generation = 0;
  /** True while playback has run out of decoded frames — see freeze()/thaw(). */
  private starved = false;
  /** Timestamp of the frame last shown while paused, so it is drawn once and not on every tick. */
  private previewedTimestamp: number | null = null;
  private depth = { frames: 8, decode: 12 };
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
  private subtitleLookup: Map<number, MatroskaTrack> | null = null;

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

  /**
   * Runs the software decoder for a track the platform refuses, feeding the same AudioOutput the
   * native path uses. It is its own producer loop rather than part of pump(): mediabunny does its
   * own demuxing (through the engine's byte cache, so the file is still read once) and hands back
   * decoded samples directly, so there is nothing for the demux loop to route.
   */
  private async startSoftwareAudio(track: MatroskaTrack, fromSeconds: number): Promise<boolean> {
    if (!this.source) return false;
    let software: SoftwareAudioTrack;
    try {
      software = await SoftwareAudioTrack.open(this.source, track.number);
    } catch (error) {
      // Surfaced, not swallowed: "no sound" with no reason is the single most expensive kind of
      // bug to chase, and the reason is right here.
      this.audioDiagnostic = error instanceof Error ? error.message : "ouverture du décodeur logiciel échouée";
      return false;
    }

    this.audioPath = "software";
    this.audioFed = 0;
    this.softwareAudio = software;
    this.audio = new AudioOutput(software.format);
    this.audio.setVolume(this.volume, this.muted);
    void this.runSoftwareAudio(fromSeconds);
    return true;
  }

  private async runSoftwareAudio(fromSeconds: number): Promise<void> {
    const software = this.softwareAudio;
    if (!software) return;
    const generation = ++this.softwareAudioGeneration;

    try {
      for await (const data of software.samples(fromSeconds)) {
        // A seek or a track change started a newer loop; this one's samples belong to a position
        // nobody is watching any more.
        if (this.destroyed || generation !== this.softwareAudioGeneration) {
          data.close();
          return;
        }
        this.onAudioData(data);
        // Decoding runs about ten times faster than playback, so without waiting for the queue to
        // drain it would decode the whole film into memory in a couple of minutes.
        while (!this.destroyed && generation === this.softwareAudioGeneration && this.audio && !this.audio.needsMore) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    } catch (error) {
      this.emit("error", `Décodage audio logiciel interrompu : ${error instanceof Error ? error.message : "erreur"}`);
    }
  }

  /** The configuration this platform accepts for a track, or null if it accepts none. */
  private async supportedAudioConfig(track: MatroskaTrack) {
    const liars = readAudioLiars();
    for (const config of audioConfigCandidates(track)) {
      // Already caught claiming this one on this device.
      if (liars.includes(config.codec)) continue;
      const support = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (support.supported) return config;
    }
    return null;
  }

  /** The first track this platform will actually decode, asking rather than assuming. */
  private async firstDecodable(tracks: MatroskaTrack[]): Promise<MatroskaTrack | null> {
    for (const track of tracks) {
      if (await this.supportedAudioConfig(track)) return track;
    }
    return null;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async load(streamUrl: string, options: EngineOptions): Promise<void> {
    // WebCodecs is secure-context only. Over plain HTTP — a LAN IP, a development port — the
    // constructors simply do not exist, and the failure that follows is an opaque
    // "VideoDecoder is not defined" rather than the actual reason.
    if (typeof VideoDecoder === "undefined") {
      throw new Error(
        "WebCodecs n'est pas disponible ici. Le lecteur expérimental exige une connexion sécurisée (HTTPS) ou localhost."
      );
    }

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

    // Tone-mapping needs the frame's planes on the CPU, and copyTo is a full readback: at 4K
    // that is roughly 12 MB per frame, 300 MB/s at 24fps, which on a phone is enough to take the
    // hardware decoder down with it — the observed failure being a flat "Decoder failure" on a
    // 4K HDR file. Above that size the picture goes through the plain canvas instead: flat
    // colours, but a picture, and a decoder that survives.
    const pixels = videoConfig.codedWidth * videoConfig.codedHeight;
    const tooLargeForToneMapping = pixels > 2_500_000;
    if (options.hdr && tooLargeForToneMapping) {
      this.emit(
        "warning",
        "Conversion HDR désactivée sur ce fichier : trop lourde en 4K pour cet appareil. Image affichée sans."
      );
    }

    this.renderer = createRenderer(this.canvas, {
      hdr: options.hdr && !tooLargeForToneMapping,
      peakNits: options.peakNits,
      // Surfaced rather than swallowed: the picture still plays, but flat, and knowing that is
      // the difference between "HDR isn't working here" and "this player is broken".
      onHdrFallback: (reason) =>
        this.emit("warning", `Conversion HDR indisponible, image affichée sans (${reason}).`),
    });

    this.videoDecoder = new VideoDecoder({
      output: (frame) => this.onVideoFrame(frame),
      error: (error) => this.fail(`Décodage vidéo interrompu : ${error.message}`),
    });
    this.videoDecoder.configure(videoConfig);
    this.needsKeyframe = true;
    this.depth = queueDepthFor(videoConfig.codedWidth, videoConfig.codedHeight);

    if (this.audioTrack) {
      const audioConfig = await this.supportedAudioConfig(this.audioTrack);
      if (!audioConfig) {
        // The platform can't decode this one. Before giving up on sound, try the software
        // decoder — which is where most of this library ends up, since AC3 and E-AC3 are not
        // part of the web baseline and iOS doesn't expose them either.
        const started = await this.startSoftwareAudio(this.audioTrack, options.startSeconds ?? 0);
        if (!started) {
          // Reported, not fatal: a silent picture is still worth showing, and naming the codec
          // is what tells us which files this pipeline genuinely cannot handle.
          this.emit(
            "error",
            `Pas de son : ${this.audioDiagnostic ?? unsupportedReason(this.audioTrack) ?? `aucun décodeur pour ${this.audioTrack.codecId.replace("A_", "")}`}.`
          );
          this.audioTrack = null;
        }
      } else {
        this.audioConfig = audioConfig;
        this.audio = new AudioOutput({ sampleRate: audioConfig.sampleRate, numberOfChannels: audioConfig.numberOfChannels });
        this.audioDecoder = new AudioDecoder({
          output: (data) => this.onAudioData(data),
          error: (error) => this.fail(`Décodage audio interrompu : ${error.message}`),
        });
        this.audioDecoder.configure(audioConfig);
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
    this.softwareAudioGeneration += 1;
    this.softwareAudio?.close();
    this.renderer?.destroy();
    void this.audio?.close();
    this.source?.close();
  }

  /**
   * What the engine is actually doing, for the technical panel.
   *
   * Written because three rounds of "no sound" were diagnosed by reasoning about code rather than
   * by looking: the audio path, the state of the audio hardware and whether any samples reached
   * it answer in one glance what an afternoon of hypotheses did not.
   */
  get diagnostics(): Record<string, string> {
    return {
      "Chemin audio": this.audioPath === "software" ? "décodeur logiciel" : this.audioPath === "native" ? "natif (plateforme)" : "aucun",
      "Piste audio": this.audioTrack ? `${this.audioTrack.codecId.replace("A_", "")} ${this.audioTrack.audio?.channels ?? "?"}ch` : "—",
      "Sortie audio": this.audio ? this.audio.state : "non créée",
      "Blocs audio": `${this.audioFed} fournis, ${this.audioChunks} décodés`,
      "Audio en avance": this.audio ? `${this.audio.bufferedAhead.toFixed(2)} s` : "—",
      "Images en file": `${this.frames.length} décodées, ${this.pendingVideo.length} en attente`,
      "Horloge": `${this.currentTime.toFixed(1)} s`,
      ...(this.audioDiagnostic ? { "Dernier échec audio": this.audioDiagnostic } : {}),
    };
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
   * Sets up whatever can decode this track: the platform first, the software decoder second.
   *
   * Both paths end at the same AudioOutput, so everything downstream — the clock, the volume,
   * seeking — is unaware of which one is running. Returns false only when neither can, which is
   * a silent picture rather than a failure.
   */
  private async configureAudioFor(track: MatroskaTrack, fromSeconds: number): Promise<boolean> {
    // Whatever was running has to go first: two decoders feeding one output would interleave
    // two soundtracks.
    this.softwareAudioGeneration += 1;
    this.softwareAudio?.close();
    this.softwareAudio = null;
    try { this.audioDecoder?.close(); } catch { /* already closed */ }
    this.audioDecoder = null;
    await this.audio?.close();
    this.audio = null;
    this.audioConfig = null;

    const config = await this.supportedAudioConfig(track);
    if (config) {
      this.audioConfig = config;
      this.audioPath = "native";
      this.audioFed = 0;
      this.audioChunks = 0;
      this.audio = new AudioOutput({ sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels });
      this.audio.setVolume(this.volume, this.muted);
      this.audioDecoder = new AudioDecoder({
        output: (data) => this.onAudioData(data),
        error: (error) => this.fail(`Décodage audio interrompu : ${error.message}`),
      });
      this.audioDecoder.configure(config);
      return true;
    }

    return this.startSoftwareAudio(track, fromSeconds);
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

    const resumeAt = this.currentTime;
    this.audioTrack = track;
    // Same two-step as the initial load, software decoder included — a track the platform
    // refuses is exactly the case this player exists to handle, and refusing it here while the
    // same codec plays fine at startup would be incoherent.
    const configured = await this.configureAudioFor(track, resumeAt);
    if (!configured) {
      this.emit("warning", unsupportedReason(track) ?? `Aucun décodeur disponible pour l'audio ${track.codecId.replace("A_", "")}.`);
      return;
    }
    await this.seek(resumeAt);
  }

  /** Null turns subtitles off. */
  setSubtitleTrack(trackNumber: number | null): void {
    this.subtitleTrackNumber = trackNumber;
    this.activeCue = null;
    this.emit("subtitle", null);
  }

  /** Lookup for the demux loop, built once from the track list. */
  private get subtitleTracksByNumber(): Map<number, MatroskaTrack> {
    if (!this.subtitleLookup) {
      this.subtitleLookup = new Map(
        (this.file?.tracks ?? [])
          .filter((t) => t.type === "subtitle" && t.isEnabled && TEXT_SUBTITLE_CODECS.has(t.codecId))
          .map((t) => [t.number, t])
      );
    }
    return this.subtitleLookup;
  }

  // ── transport ─────────────────────────────────────────────────────────────

  get currentTime(): number {
    if (this.audio?.primed) return this.audio.currentMediaTime();
    return this.wallClock.currentMediaTime();
  }

  get paused(): boolean {
    return !this.playing;
  }

  /**
   * Unblocks the audio hardware. Must be called from inside a real user gesture.
   *
   * iOS starts every AudioContext suspended and only lets it resume from the task of a genuine
   * interaction — an await in between is enough to lose that permission. Playback here starts
   * from an async chain (open the file, parse it, configure the decoders), so by the time play()
   * runs the gesture is long gone and the sound never comes: the pipeline decodes correctly into
   * a context that is not running. The host therefore also calls this straight from a pointer
   * handler, where the permission still holds.
   */
  async resumeAudio(): Promise<void> {
    await this.audio?.resume();
  }

  async play(): Promise<void> {
    if (this.destroyed || this.playing) return;
    this.playing = true;
    this.starved = false;
    await this.audio?.resume();
    this.wallClock.start(this.wallClock.currentMediaTime());
    this.emit("playing");
    void this.pump();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.starved = false;
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
    // Invalidates any demux pass already in flight before touching the decoders, so a sample
    // read for the old position cannot arrive after the reset and be fed to it.
    this.generation += 1;
    this.videoDecoder?.reset();
    this.audioDecoder?.reset();
    const videoConfig = this.videoTrack ? videoConfigFor(this.videoTrack) : null;
    if (videoConfig) this.videoDecoder?.configure(videoConfig);
    if (this.audioConfig) this.audioDecoder?.configure(this.audioConfig);
    this.needsKeyframe = true;

    for (const frame of this.frames) frame.close();
    this.frames.length = 0;
    this.pendingVideo = [];
    this.pendingCues.clear();
    this.activeCue = null;
    this.emit("subtitle", null);
    this.audio?.flush(target);
    this.wallClock.seek(target);
    this.endOfFile = false;
    this.presentFromUs = targetUs;
    // Held until a frame for the new position actually exists. Letting the clock run from the
    // target while the decoder is still catching up means every frame it produces is already
    // late and gets dropped — which is the "jumps, then freezes for a second, then resumes"
    // that a seek was showing. thaw() starts it again on the first frame.
    this.starved = true;
    this.wallClock.stop();

    this.reader.seekTo(clusterOffsetForTime(this.file, targetUs) ?? this.file.firstClusterOffset ?? 0);
    // The software path is a separate producer and doesn't go through the reader — it gets its
    // own restart at the new position.
    if (this.softwareAudio) void this.runSoftwareAudio(target);
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
    this.audioChunks += 1;
    this.audio.enqueue(data, data.timestamp / 1e6);
    data.close();
  }

  /** True while the video decoder has room for another sample. */
  private get videoHasRoom(): boolean {
    return this.frames.length < this.depth.frames && (this.videoDecoder?.decodeQueueSize ?? 0) < this.depth.decode;
  }

  private decodeVideoSample(sample: MediaSample): void {
    if (this.videoDecoder?.state !== "configured") return;
    if (this.needsKeyframe) {
      if (!sample.isKey) return;
      this.needsKeyframe = false;
    }
    this.videoDecoder.decode(
      new EncodedVideoChunk({
        type: sample.isKey ? "key" : "delta",
        timestamp: sample.timestampUs,
        ...(sample.durationUs !== null ? { duration: sample.durationUs } : {}),
        data: sample.data,
      })
    );
  }

  /** Feeds the decoders until everything downstream is satisfied, or the file ends. */
  private async pump(): Promise<void> {
    if (this.demuxing || this.destroyed || !this.reader) return;
    this.demuxing = true;
    const generation = this.generation;
    try {
      for (;;) {
        if (this.destroyed || this.endOfFile) return;
        // A seek happened while this pass was awaiting a read; everything it would feed now
        // belongs to the position the viewer just left.
        if (generation !== this.generation) return;

        // Anything held back earlier goes in first, so the queue drains in file order.
        while (this.pendingVideo.length > 0 && this.videoHasRoom) {
          this.decodeVideoSample(this.pendingVideo.shift()!);
        }

        // The native audio decoder is fed from here; the software one runs its own loop and
        // needs nothing from this one.
        const audioWants = !!this.audioDecoder && !!this.audio && this.audio.needsMore;
        if (!this.videoHasRoom && !audioWants) return;
        // Reading on for audio's sake is bounded: past this the file is simply ahead of the
        // decoder and waiting is the right answer.
        if (!this.videoHasRoom && this.pendingVideo.length >= 120) return;

        const sample = await this.reader.next();
        if (!sample) {
          this.endOfFile = true;
          await this.videoDecoder?.flush().catch(() => {});
          await this.audioDecoder?.flush().catch(() => {});
          return;
        }

        if (this.videoTrack && sample.trackNumber === this.videoTrack.number) {
          if (this.videoHasRoom) this.decodeVideoSample(sample);
          else this.pendingVideo.push(sample);
        } else if (this.subtitleTracksByNumber.has(sample.trackNumber)) {
          // Text subtitles are not decoded, only timed: the block payload is the line itself, and
          // its duration is how long it stays up.
          const track = this.subtitleTracksByNumber.get(sample.trackNumber)!;
          const text = subtitleText(new TextDecoder().decode(sample.data), track.codecId);
          if (text) {
            const queue = this.pendingCues.get(sample.trackNumber) ?? [];
            queue.push({
              startSeconds: sample.timestampUs / 1e6,
              endSeconds: (sample.timestampUs + (sample.durationUs ?? 3_000_000)) / 1e6,
              text,
            });
            this.pendingCues.set(sample.trackNumber, queue);
          }
        } else if (this.audioTrack && sample.trackNumber === this.audioTrack.number && this.audioDecoder?.state === "configured") {
          this.audioFed += 1;
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

  /**
   * Catches a decoder that claimed a codec and then produced nothing.
   *
   * A hard failure arrives through the decoder's error callback; this is the other kind, where
   * everything reports success and no sound comes out. Enough blocks fed with none returned is
   * the evidence — at which point the codec string is remembered as a liar for this device and
   * the software decoder takes over from the current position.
   */
  private maybeDemoteNativeAudio(): void {
    if (this.demotingAudio || this.audioPath !== "native" || !this.audioTrack) return;
    if (this.audioFed < 12 || this.audioChunks > 0) return;

    this.demotingAudio = true;
    const track = this.audioTrack;
    const codec = this.audioConfig?.codec;
    if (codec) rememberAudioLiar(codec);
    this.audioDiagnostic = `${codec ?? "le décodeur natif"} annoncé comme géré mais silencieux — bascule sur le décodeur logiciel`;

    const resumeAt = this.currentTime;
    void this.configureAudioFor(track, resumeAt)
      .then(async (ok) => {
        if (!ok) {
          this.emit("warning", `Pas de son : ${this.audioDiagnostic}.`);
          this.audioTrack = null;
          return;
        }
        this.emit("warning", `Son rétabli par le décodeur logiciel (${codec ?? "codec natif"} ne produisait rien).`);
        await this.seek(resumeAt);
      })
      .finally(() => {
        this.demotingAudio = false;
      });
  }

  /**
   * Draws a frame and releases it once the draw is genuinely finished.
   *
   * The HDR renderer is asynchronous — it has to copy the frame's planes out before it can upload
   * them — so closing the frame right after calling draw() would pull the pixels out from under
   * it. The SDR path is synchronous and closes immediately.
   */
  private present(frame: VideoFrame): void {
    const drawing = this.renderer?.draw(frame);
    if (drawing instanceof Promise) void drawing.finally(() => frame.close());
    else frame.close();
  }

  /** Emits only on change, so the overlay isn't re-rendered sixty times a second. */
  private updateSubtitle(seconds: number): void {
    // Expired lines are dropped on every track, not just the selected one, or an unwatched track
    // would accumulate a film's worth of text.
    for (const queue of this.pendingCues.values()) {
      while (queue.length > 0 && queue[0].endSeconds < seconds - 1) queue.shift();
    }
    if (this.subtitleTrackNumber === null) return;
    const due = selectCue(this.pendingCues.get(this.subtitleTrackNumber) ?? [], seconds);
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
      this.maybeDemoteNativeAudio();
      void this.pump();
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  /**
   * Stops the clock when playback runs out of decoded frames, and restarts it when they come
   * back.
   *
   * Without this the clock keeps advancing through a stall, so every frame that finally arrives
   * is already late and gets dropped — and the player never catches up. What that looks like is
   * a film running at a fraction of its real frame rate rather than a brief pause, which is
   * exactly the wrong trade: a short freeze is forgivable, a permanently stuttering picture is
   * not.
   */
  private freeze(): void {
    if (this.starved) return;
    this.starved = true;
    this.wallClock.stop();
    void this.audio?.suspend();
    this.emit("waiting");
  }

  private thaw(): void {
    if (!this.starved) return;
    this.starved = false;
    if (this.playing) {
      this.wallClock.start(this.wallClock.currentMediaTime());
      void this.audio?.resume();
      this.emit("playing");
    }
  }

  private presentDueFrame(): void {
    if (this.frames.length === 0) {
      if (this.playing && this.endOfFile) {
        this.playing = false;
        this.emit("ended");
      } else if (this.playing) {
        this.freeze();
      }
      return;
    }
    this.thaw();

    const nowUs = this.currentTime * 1e6;
    // Paused still draws the first pending frame once — that is what makes a seek show its
    // destination instead of leaving the previous picture on screen.
    if (!this.playing) {
      // Shows the first pending frame — that is what makes a seek display its destination
      // instead of leaving the previous picture up — but does NOT consume the queue.
      //
      // Consuming it was the cause of three separate symptoms: playback appeared not to start
      // (the frames play() was about to need had already been drawn and closed at 60 per second
      // before the clock ever ran), pausing looked like fast-forward (one frame per animation
      // frame, with no timing), and resuming froze (every remaining frame was older than the
      // clock and got dropped).
      const frame = this.frames[0];
      if (frame && this.previewedTimestamp !== frame.timestamp) {
        this.previewedTimestamp = frame.timestamp;
        void this.renderer?.draw(frame);
      }
      return;
    }
    this.previewedTimestamp = null;

    let drawn: VideoFrame | null = null;
    while (this.frames.length > 0 && this.frames[0].timestamp <= nowUs) {
      const frame = this.frames.shift()!;
      // Only the newest due frame is drawn; anything older is already late and drawing it would
      // cost a blit to show a picture the viewer would never perceive.
      drawn?.close();
      drawn = frame;
    }
    if (drawn) this.present(drawn);

    const seconds = this.currentTime;
    this.updateSubtitle(seconds);
    if (Math.abs(seconds - this.lastReportedTime) >= 0.2) {
      this.lastReportedTime = seconds;
      this.emit("timeupdate", seconds);
    }
  }
}
