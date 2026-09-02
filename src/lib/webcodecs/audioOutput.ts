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


/**
 * Folds a multichannel block down to stereo.
 *
 * Channel order follows the usual convention — front left, front right, centre, LFE, then the
 * surrounds — which is what both libav and the browser decoders produce. The centre goes to both
 * sides at -3 dB and each surround to its own side at -3 dB, which is the standard fold; the LFE
 * is dropped, as it is in every stereo downmix, because a phone has nothing to reproduce it with
 * and summing it in only eats headroom. The result is scaled to keep a loud mix from clipping.
 */
function foldToStereo(planes: Float32Array[], frames: number): Float32Array[] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const centre = planes[2];
  const surroundLeft = planes[4];
  const surroundRight = planes[5];
  const HALF_POWER = Math.SQRT1_2;
  const HEADROOM = 0.8;

  for (let i = 0; i < frames; i++) {
    let l = planes[0][i];
    let r = planes[1][i];
    if (centre) {
      l += HALF_POWER * centre[i];
      r += HALF_POWER * centre[i];
    }
    if (surroundLeft) l += HALF_POWER * surroundLeft[i];
    if (surroundRight) r += HALF_POWER * surroundRight[i];
    // Anything beyond 5.1 (height channels, a second surround pair) is spread evenly rather than
    // discarded — quieter is better than absent.
    for (let extra = 6; extra < planes.length; extra++) {
      l += 0.5 * planes[extra][i];
      r += 0.5 * planes[extra][i];
    }
    left[i] = Math.max(-1, Math.min(1, l * HEADROOM));
    right[i] = Math.max(-1, Math.min(1, r * HEADROOM));
  }
  return [left, right];
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
  private lastChannelCount = 0;
  private lastPeak = 0;
  /** Media element the graph plays through — see the constructor for why it exists. */
  private element: HTMLAudioElement | null = null;
  /** Scratch for interleaved blocks: copied once per block, read by every channel. */
  private interleaved: ArrayBuffer | null = null;
  private interleavedFor: AudioData | null = null;
  /** Set by the engine so a failure inside a decoder callback is reported rather than lost. */
  onError: ((reason: string) => void) | null = null;

  constructor(options: AudioOutputOptions) {
    void options;
    // No sampleRate is requested, deliberately. Forcing one that the hardware doesn't run at is
    // a documented source of trouble on iOS — the context is created, reports "running", and
    // produces nothing — and it buys nothing here: an AudioBuffer may carry any rate, and the
    // source node resamples it to the context's on playback.
    this.context = new AudioContext({ latencyHint: "playback" });
    this.gain = this.context.createGain();

    // The output goes through a media element rather than straight to the context's destination.
    //
    // On iOS, Web Audio plays under an audio session that the ring/silent switch mutes, while a
    // media element gets the playback session that does not. The symptom is precise and was
    // exactly what the diagnostics showed: a running context, blocks decoded, the buffer ahead of
    // the playhead, the graph correct — and nothing audible. Routing through an <audio> element
    // promotes the session, and costs a few milliseconds of latency that a film does not notice.
    try {
      const stream = this.context.createMediaStreamDestination();
      this.gain.connect(stream);
      const element = document.createElement("audio");
      element.srcObject = stream.stream;
      element.autoplay = true;
      // Never rendered, but attached: a detached element is not reliably allowed to play.
      element.style.display = "none";
      element.setAttribute("playsinline", "");
      document.body.appendChild(element);
      this.element = element;
    } catch {
      // Anything unsupported here falls back to the direct connection, which is correct
      // everywhere except under a silent switch.
      this.gain.connect(this.context.destination);
    }
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  /** "running", "suspended" or "closed" — the single most useful fact when there is no sound. */
  get state(): string {
    return `${this.context.state} @ ${this.context.sampleRate} Hz`;
  }

  /** Channels actually handed to the audio graph, and the gain they pass through. */
  get outputState(): string {
    const route = this.element ? `élément ${this.element.paused ? "en pause" : "actif"}` : "direct";
    return `${this.lastChannelCount} canal(aux), gain ${this.gain.gain.value.toFixed(2)}, ${route}`;
  }

  /** Peak of the last block handed to the graph. Zero here means the audio is genuinely silent. */
  get level(): string {
    return this.lastPeak.toFixed(3);
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
    // The element has its own autoplay gate, and this is called from a real gesture.
    await this.element?.play().catch(() => {});
  }

  async suspend(): Promise<void> {
    if (this.context.state === "running") await this.context.suspend();
  }

  /**
   * Reads one channel out of a decoded block as floats, whatever the decoder's own layout.
   *
   * Written the long way on purpose. An earlier version asked copyTo to convert to "f32-planar"
   * and assumed every browser would — an assumption never verified, and the kind that fails
   * invisibly: copyTo throwing inside a decoder's output callback is swallowed by the browser, so
   * the symptom is silence with a perfect picture and no error anywhere. Requesting the format the
   * decoder actually produced cannot fail that way, and the conversion is a few lines of
   * arithmetic.
   */
  private channelFloats(data: AudioData, channel: number, frames: number): Float32Array {
    const format = data.format ?? "f32-planar";
    const planar = format.endsWith("-planar");
    const planeIndex = planar ? channel : 0;
    const size = data.allocationSize({ planeIndex, format });

    // An interleaved block is copied once and read by every channel; a planar one is copied per
    // channel, which is what the format means.
    if (!planar && this.interleavedFor !== data) {
      this.interleavedFor = data;
      this.interleaved = new ArrayBuffer(size);
      data.copyTo(new Uint8Array(this.interleaved), { planeIndex: 0, format });
    }
    const raw = planar ? new ArrayBuffer(size) : this.interleaved!;
    if (planar) data.copyTo(new Uint8Array(raw), { planeIndex, format });

    const out = new Float32Array(frames);
    const stride = planar ? 1 : data.numberOfChannels;
    const offset = planar ? 0 : channel;

    if (format.startsWith("f32")) {
      const view = new Float32Array(raw);
      for (let i = 0; i < frames; i++) out[i] = view[offset + i * stride];
    } else if (format.startsWith("s16")) {
      const view = new Int16Array(raw);
      for (let i = 0; i < frames; i++) out[i] = view[offset + i * stride] / 32768;
    } else if (format.startsWith("s32")) {
      const view = new Int32Array(raw);
      for (let i = 0; i < frames; i++) out[i] = view[offset + i * stride] / 2147483648;
    } else {
      // u8 is unsigned, centred on 128.
      const view = new Uint8Array(raw);
      for (let i = 0; i < frames; i++) out[i] = (view[offset + i * stride] - 128) / 128;
    }
    return out;
  }

  /**
   * Queues one decoded chunk, whatever produced it.
   *
   * Both decoder paths converge here on plain float planes: the native one converts its AudioData
   * (see channelFloats), the software one reads them straight off its sample. One representation
   * means one place where the audio can be wrong, and one place that measures it.
   */
  enqueuePcm(planes: Float32Array[], sampleRate: number, mediaSeconds: number): boolean {
    try {
      const frames = planes[0]?.length ?? 0;
      if (frames === 0) return false;

      // Anything above stereo is folded down here rather than handed to the audio graph to
      // downmix: a multichannel AudioBuffer a browser declines to downmix accepts everything and
      // plays nothing, which is indistinguishable from a working player with no sound.
      const output = planes.length > 2 ? foldToStereo(planes, frames) : planes;

      // The one thing the diagnostics could not see: whether the samples carry any signal at all.
      // Silence with a perfect pipeline and silence with an empty buffer look identical from the
      // outside, and they have nothing in common as problems.
      let peak = 0;
      for (const plane of output) {
        for (let i = 0; i < frames; i += 32) peak = Math.max(peak, Math.abs(plane[i]));
      }
      this.lastPeak = peak;

      this.lastChannelCount = output.length;
      const buffer = this.context.createBuffer(output.length, frames, sampleRate);
      for (let channel = 0; channel < output.length; channel++) {
        buffer.copyToChannel(output[channel], channel);
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
      return true;
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "mise en file audio impossible");
      return false;
    }
  }

  /** The native decoder's path: convert its AudioData to planes, then the shared route above. */
  enqueue(data: AudioData, mediaSeconds: number): boolean {
    try {
      const planes: Float32Array[] = [];
      for (let channel = 0; channel < data.numberOfChannels; channel++) {
        planes.push(this.channelFloats(data, channel, data.numberOfFrames));
      }
      return this.enqueuePcm(planes, data.sampleRate, mediaSeconds);
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "lecture du bloc audio impossible");
      return false;
    }
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
    if (this.element) {
      this.element.pause();
      this.element.srcObject = null;
      this.element.remove();
      this.element = null;
    }
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
