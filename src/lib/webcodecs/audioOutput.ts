// Audio output and, with it, the playback clock.
//
// Audio is the master clock, not video — the standard arrangement in every media player, and for
// a concrete reason: a dropped or late video frame is a momentary glitch, while a gap or an
// overlap in audio is immediately audible. So audio is scheduled on the AudioContext's own
// hardware clock and video is presented against it, rather than the other way round.

/** How far ahead of the playhead audio is queued. Enough to ride out a decode hiccup. */
const SCHEDULE_AHEAD_SECONDS = 0.6;

export interface AudioOutputOptions {
  sampleRate: number;
  numberOfChannels: number;
}

export class AudioOutput {
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private readonly sources = new Set<AudioBufferSourceNode>();
  /** Context time at which the next buffer should start. */
  private nextStartTime = 0;
  /** Media time corresponding to `nextStartTime` — the pair anchors the clock. */
  private anchorMediaSeconds = 0;
  private anchorContextTime = 0;
  private started = false;

  constructor(options: AudioOutputOptions) {
    this.context = new AudioContext({ sampleRate: options.sampleRate, latencyHint: "playback" });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  /** "running", "suspended" or "closed" — the single most useful fact when there is no sound. */
  get state(): string {
    return `${this.context.state} @ ${this.context.sampleRate} Hz`;
  }

  /** True once enough audio has been queued that playback can begin. */
  get primed(): boolean {
    return this.started;
  }

  /** Seconds of audio queued beyond the playhead. */
  get bufferedAhead(): number {
    return Math.max(0, this.nextStartTime - this.context.currentTime);
  }

  get needsMore(): boolean {
    return this.bufferedAhead < SCHEDULE_AHEAD_SECONDS;
  }

  setVolume(volume: number, muted: boolean): void {
    // A short ramp rather than a step: an instantaneous gain change on a running signal is an
    // audible click.
    this.gain.gain.setTargetAtTime(muted ? 0 : volume, this.context.currentTime, 0.01);
  }

  async resume(): Promise<void> {
    if (this.context.state === "suspended") await this.context.resume();
  }

  async suspend(): Promise<void> {
    if (this.context.state === "running") await this.context.suspend();
  }

  /**
   * Queues one decoded chunk. `mediaSeconds` is its presentation time in the file, which is what
   * lets the clock report a real position rather than "time since play was pressed".
   */
  enqueue(data: AudioData, mediaSeconds: number): void {
    const channels = data.numberOfChannels;
    const frames = data.numberOfFrames;
    const buffer = this.context.createBuffer(channels, frames, data.sampleRate);

    // Planar float is what every browser decoder produces here; copyTo converts if it isn't.
    const plane = new Float32Array(frames);
    for (let channel = 0; channel < channels; channel++) {
      data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
      buffer.copyToChannel(plane, channel);
    }

    const now = this.context.currentTime;
    // First chunk, or the queue ran dry: re-anchor to now plus a small cushion instead of
    // scheduling in the past, which the Web Audio API silently turns into "play immediately"
    // and would desynchronise the clock from what is actually audible.
    if (!this.started || this.nextStartTime < now) {
      this.nextStartTime = now + 0.05;
      this.anchorContextTime = this.nextStartTime;
      this.anchorMediaSeconds = mediaSeconds;
      this.started = true;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start(this.nextStartTime);
    source.onended = () => {
      this.sources.delete(source);
    };
    this.sources.add(source);
    this.nextStartTime += buffer.duration;
  }

  /** Current playback position in the file, in seconds. */
  currentMediaTime(): number {
    if (!this.started) return this.anchorMediaSeconds;
    return this.anchorMediaSeconds + (this.context.currentTime - this.anchorContextTime);
  }

  /** Drops everything queued — used by seeking, where queued audio is now wrong. */
  flush(mediaSeconds: number): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already finished; nothing to stop.
      }
    }
    this.sources.clear();
    this.started = false;
    this.nextStartTime = 0;
    this.anchorMediaSeconds = mediaSeconds;
    this.anchorContextTime = this.context.currentTime;
  }

  async close(): Promise<void> {
    this.flush(0);
    await this.context.close().catch(() => {});
  }
}

/**
 * The clock used when a file has no playable audio track — a wall clock that only advances while
 * playing. Kept deliberately separate: mixing "sometimes audio drives it, sometimes not" into one
 * class is how a player ends up with two subtly different notions of time.
 */
export class WallClock {
  private base = 0;
  private startedAt: number | null = null;

  start(fromSeconds: number): void {
    this.base = fromSeconds;
    this.startedAt = performance.now();
  }

  stop(): void {
    this.base = this.currentMediaTime();
    this.startedAt = null;
  }

  seek(toSeconds: number): void {
    this.base = toSeconds;
    if (this.startedAt !== null) this.startedAt = performance.now();
  }

  currentMediaTime(): number {
    if (this.startedAt === null) return this.base;
    return this.base + (performance.now() - this.startedAt) / 1000;
  }
}
