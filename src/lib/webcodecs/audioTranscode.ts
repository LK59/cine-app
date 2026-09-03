// Sound for codecs no browser will accept, turned into sound every browser accepts.
//
// DTS is the case this exists for. No browser decodes it, and — separately — no browser will take
// it inside a MediaSource even if one did, so a DTS track can never be handed to the player as it
// is. Every option that keeps the picture on the hardware path therefore ends in the same place:
// decode the sound here, encode it again as something the player does accept, and put that in the
// container instead. The video is not touched, which is the whole point.
//
// The half-second of latency this adds is spent ahead of playback, not at it: a segment's audio is
// produced while the previous one is still being watched.

import { audioSampleEntryFor } from "./mp4SampleEntries";
import { SoftwareAudioTrack, type DecodedAudio } from "./softwareAudio";
import type { ByteSource } from "./byteSource";
import type { MatroskaTrack } from "./matroska";

/** AAC-LC. The one encoder both an iPhone and a desktop browser were measured to offer. */
const TARGET_CODEC = "mp4a.40.2";

/**
 * How far past a segment's end the encoder is fed before its output is taken.
 *
 * An encoder holds a frame or two before it hands anything back. Feeding a little beyond the
 * boundary is what lets it emit everything belonging below it — without being flushed, which for
 * a frame-based codec means padding or discarding whatever did not fill the current frame.
 */
const ENCODER_LOOKAHEAD_SECONDS = 0.3;

/** How long the encoder is given to describe itself before this is called a refusal. */
const PRIMING_TIMEOUT_MS = 8000;

/** Codecs that cannot ride in the container but can be turned into one that can. */
const TRANSCODABLE = new Set(["A_DTS", "A_DTS/EXPRESS", "A_DTS/LOSSLESS"]);

export function transcodableAudio(track: MatroskaTrack): boolean {
  return TRANSCODABLE.has(track.codecId);
}

export interface TranscodedFrame {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
}

/**
 * Whether this browser can encode what we would hand it.
 *
 * Asked with and without a bitrate: a browser can decline one rate while accepting the codec, and
 * reading that as a refusal would send a file down a slower path for no reason. Measured on a
 * desktop Chrome, which says no at 256 kbit/s and yes with nothing specified.
 */
export async function canEncodeAac(sampleRate: number, numberOfChannels: number): Promise<boolean> {
  const Encoder = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
  if (!Encoder?.isConfigSupported) return false;

  for (const config of [
    { codec: TARGET_CODEC, sampleRate, numberOfChannels, bitrate: 256_000 },
    { codec: TARGET_CODEC, sampleRate, numberOfChannels },
  ]) {
    try {
      if ((await Encoder.isConfigSupported(config)).supported) return true;
    } catch {
      // A configuration the browser considers malformed rather than unsupported.
    }
  }
  return false;
}

export class AudioTranscoder {
  private generator: AsyncGenerator<DecodedAudio> | null = null;
  private pending: TranscodedFrame[] = [];
  private lastDecodedSeconds = 0;
  private exhausted = false;
  private failure: string | null = null;

  private constructor(
    private readonly decoder: SoftwareAudioTrack,
    private readonly encoder: AudioEncoder,
    readonly sampleEntry: Uint8Array,
    readonly sampleRate: number,
    readonly channels: number
  ) {}

  private get config(): AudioEncoderConfig {
    return { codec: TARGET_CODEC, sampleRate: this.sampleRate, numberOfChannels: this.channels };
  }

  get codecString(): string {
    return TARGET_CODEC;
  }

  /**
   * Opens the track and gets far enough to describe it.
   *
   * The description an MP4 needs is not in the file — it is produced by the encoder, and only
   * once it has encoded something. So a little sound is pushed through here and kept, which is
   * also the earliest point at which a browser that cannot do this at all will say so.
   */
  static async open(source: ByteSource, track: MatroskaTrack): Promise<AudioTranscoder> {
    const Encoder = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
    if (!Encoder) throw new Error("Ce navigateur ne sait pas encoder de l'audio.");

    const decoder = await SoftwareAudioTrack.open(source, track.number, track.codecId);
    const { sampleRate, numberOfChannels } = decoder.format;
    if (!(await canEncodeAac(sampleRate, numberOfChannels))) {
      decoder.close();
      throw new Error(`Ce navigateur ne sait pas encoder de l'AAC en ${numberOfChannels} canaux.`);
    }

    let description: Uint8Array | null = null;
    let encoderError: string | null = null;
    // The encoder has to exist before the object that owns it, and it keeps handing frames back
    // for the rest of the session — so where they go is a reference, redirected at the instance
    // as soon as there is one. Left pointing at a local array, everything after the priming would
    // be encoded and quietly dropped.
    const sink = {
      frame: (_frame: TranscodedFrame) => {},
      failed: (message: string) => {
        encoderError = message;
      },
    };

    const encoder = new Encoder({
      output: (chunk, metadata) => {
        const carried = metadata?.decoderConfig?.description;
        if (carried && !description) description = new Uint8Array(toBytes(carried));
        sink.frame(toFrame(chunk));
      },
      error: (error) => sink.failed(error.message),
    });
    const config: AudioEncoderConfig = { codec: TARGET_CODEC, sampleRate, numberOfChannels };
    encoder.configure(config);

    // Enough to make the encoder describe itself, and no more: this runs before the first frame
    // of video is shown, so it is time the viewer is waiting through. Bounded, because an
    // encoder that accepts a configuration and then never answers is a real possibility — and a
    // player that waits for ever on it is worse than one that says what went wrong.
    const primer = decoder.samples(0);
    const prime = async () => {
      // Fed, then waited on — never flushed. A flush asks a frame-based encoder to produce a
      // frame from whatever it happens to hold, and doing that after a single 512-sample block,
      // over and over, is what a desktop Chrome answered with "Flushing error". Enough blocks to
      // fill several frames come first, and the description arrives with the first of them.
      while (!description && !encoderError) {
        for (let i = 0; i < 8; i++) {
          const next = await primer.next();
          if (next.done) return;
          encode(encoder, next.value);
        }
        for (let i = 0; i < 200 && encoder.encodeQueueSize > 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // One turn of the event loop for the outputs the encoder has finished to be delivered.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    // Raced, not merely bounded by a loop condition. The wait that has to be survived is one
    // *inside* a call — a decoder that never yields, an encoder that never answers a flush — and
    // a deadline checked between iterations never gets its turn to look.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        prime(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, PRIMING_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      void primer.return?.(undefined);
    }

    if (encoderError) {
      encoder.close();
      decoder.close();
      throw new Error(`Encodage audio refusé : ${encoderError}`);
    }
    if (!description) {
      try {
        encoder.close();
      } catch {
        // Already closed by whatever went wrong.
      }
      decoder.close();
      throw new Error(
        timedOut
          ? `L'encodeur audio n'a pas répondu en ${PRIMING_TIMEOUT_MS / 1000} s.`
          : "L'encodeur audio n'a pas décrit le flux qu'il produit."
      );
    }

    const sampleEntry = audioSampleEntryFor({
      codecId: "A_AAC",
      codecPrivate: description,
      channels: numberOfChannels,
      sampleRate,
      firstFrame: null,
    });

    const transcoder = new AudioTranscoder(decoder, encoder, sampleEntry, sampleRate, numberOfChannels);
    sink.frame = (frame) => transcoder.collect(frame);
    sink.failed = (message) => transcoder.fail(message);
    // The priming output is thrown away rather than kept: it starts at zero, and the first
    // segment asked for may be anywhere. Reading it again costs nothing — the bytes are cached.
    transcoder.seekTo(0);
    return transcoder;
  }

  /** Restarts decoding at this point on the file's clock. */
  seekTo(seconds: number): void {
    void this.generator?.return?.(undefined);

    // The encoder is emptied too, and it has to be. It holds whatever did not fill a frame —
    // roughly half of one, always — and a flush after the jump would either emit that with its
    // old timestamp or, worse, weld it to the first samples from the new position and hand back
    // one frame made of two places in the film.
    try {
      this.encoder.reset();
      this.encoder.configure(this.config);
    } catch {
      // An encoder that has already failed; framesUpTo reports it.
    }

    this.generator = this.decoder.samples(Math.max(0, seconds));
    this.pending = [];
    this.lastDecodedSeconds = seconds;
    this.exhausted = false;
  }

  /**
   * Every frame up to a point on the file's clock, encoded and ready to mux.
   *
   * Flushed at each boundary so a segment holds exactly its own sound. An encoder left to its own
   * schedule would hand the tail of one segment to the next, and the two would then disagree
   * about where they start.
   */
  async framesUpTo(endSeconds: number): Promise<TranscodedFrame[]> {
    if (this.failure) throw new Error(this.failure);
    if (!this.generator) this.seekTo(0);

    // Fed past the boundary rather than flushed at it. A flush is the only way to make a
    // frame-based encoder hand back a part-filled frame, and it does that by padding it or
    // throwing it away — every couple of seconds, for the length of a film. Feeding a little
    // beyond instead lets every frame belonging below the boundary come out whole and on time,
    // and the encoder carries its remainder across, exactly as it is meant to.
    const feedUntil = endSeconds + ENCODER_LOOKAHEAD_SECONDS;
    while (!this.exhausted && this.lastDecodedSeconds < feedUntil) {
      const next = await this.generator!.next();
      if (next.done) {
        this.exhausted = true;
        break;
      }
      this.lastDecodedSeconds = next.value.timestampSeconds;
      encode(this.encoder, next.value);
    }

    // At the end of the file there is nothing left to feed, so the remainder has to be asked for.
    if (this.exhausted) await this.encoder.flush();
    else await this.drain();
    if (this.failure) throw new Error(this.failure);

    const cut = endSeconds * 1e6;
    const ready = this.pending.filter((frame) => frame.timestampUs < cut);
    this.pending = this.pending.filter((frame) => frame.timestampUs >= cut);
    return ready;
  }

  /** Waits for what has been handed to the encoder to come back out, without forcing a frame. */
  private async drain(): Promise<void> {
    for (let i = 0; i < 200 && this.encoder.encodeQueueSize > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Both called by the encoder's own callbacks, redirected here once this object exists. */
  private collect(frame: TranscodedFrame): void {
    this.pending.push(frame);
  }

  private fail(message: string): void {
    this.failure = `Encodage audio interrompu : ${message}`;
  }

  close(): void {
    void this.generator?.return?.(undefined);
    this.decoder.close();
    try {
      this.encoder.close();
    } catch {
      // Already closed by an error it reported earlier.
    }
  }
}

function toBytes(source: BufferSource): ArrayBuffer {
  return source instanceof ArrayBuffer ? source.slice(0) : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
}

function toFrame(chunk: EncodedAudioChunk): TranscodedFrame {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return { data, timestampUs: chunk.timestamp, durationUs: chunk.duration ?? 0 };
}

/** Interleaves the decoder's planes, which is the layout an encoder takes. */
function encode(encoder: AudioEncoder, decoded: DecodedAudio): void {
  const channels = decoded.planes.length;
  const frames = decoded.planes[0]?.length ?? 0;
  if (frames === 0) return;

  const interleaved = new Float32Array(frames * channels);
  for (let channel = 0; channel < channels; channel++) {
    const plane = decoded.planes[channel];
    for (let i = 0; i < frames; i++) interleaved[i * channels + channel] = plane[i];
  }

  const data = new AudioData({
    format: "f32",
    sampleRate: decoded.sampleRate,
    numberOfFrames: frames,
    numberOfChannels: channels,
    timestamp: Math.round(decoded.timestampSeconds * 1e6),
    data: interleaved,
  });
  encoder.encode(data);
  data.close();
}
