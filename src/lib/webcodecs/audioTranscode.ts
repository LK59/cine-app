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
import { trace } from "./trace";
import { containerAccepts } from "./mseSource";
import { extractAudioSpecificConfig, opusSampleEntry, parseAacConfig } from "./mp4SampleEntries";

/** AAC-LC. The one encoder both an iPhone and a desktop browser were measured to offer. */
const TARGET_CODEC = "mp4a.40.2";

/**
 * The fallback for a browser with no AAC encoder.
 *
 * Firefox is one: it plays AAC perfectly well and cannot produce it, while it both encodes Opus
 * — in stereo and in 5.1 — and accepts it in a MediaSource. Measured, not assumed; the panel's
 * probe says so on the machine in front of the viewer. Without this, every file whose sound has
 * to be re-encoded loses the hardware path there, and on 10-bit HEVC the software path has no
 * decoder either, so it loses playback altogether.
 */
const FALLBACK_CODEC = "opus";

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

/**
 * A bitrate generous enough that an encoder has no reason to reach for HE-AAC.
 *
 * Left to choose, Safari answers a low default with SBR — a different object type, twice the
 * sample rate, and a description that contradicts the `mp4a.40.2` written beside it. Asking for
 * enough bits is the polite way to get the plain profile; reading back what actually came out,
 * below, is the way that does not depend on being obeyed.
 */
function preferredBitrate(channels: number): number {
  return Math.min(320_000, Math.max(128_000, 64_000 * channels));
}

/**
 * Codecs there is a decoder for here, whether or not the browser has one.
 *
 * Being on this list does not mean a track will be re-encoded — only that it *can* be, if the
 * browser turns out not to accept it. Which of the two happens is a question for the browser, not
 * a property of the codec: an iPhone takes AC-3 in a container untouched and should never pay for
 * a decode, while Chrome ships no Dolby decoder at all and would otherwise be shut out of the
 * hardware path for most of a library.
 */
const DECODABLE_HERE = new Set([
  "A_DTS",
  "A_DTS/EXPRESS",
  "A_DTS/LOSSLESS",
  "A_AC3",
  "A_EAC3",
]);

export function transcodableAudio(track: MatroskaTrack): boolean {
  return DECODABLE_HERE.has(track.codecId);
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
/** Every shape worth asking about for one codec, best first. */
function candidateConfigs(codec: string, sampleRate: number, numberOfChannels: number): AudioEncoderConfig[] {
  const bitrate = preferredBitrate(numberOfChannels);
  return codec === TARGET_CODEC
    ? [
        { codec, sampleRate, numberOfChannels, bitrate, aac: { format: "aac" } },
        { codec, sampleRate, numberOfChannels, aac: { format: "aac" } },
        { codec, sampleRate, numberOfChannels },
      ]
    : [
        { codec, sampleRate, numberOfChannels, bitrate },
        { codec, sampleRate, numberOfChannels },
      ];
}

async function firstSupported(codec: string, sampleRate: number, channels: number): Promise<AudioEncoderConfig | null> {
  const Encoder = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
  if (!Encoder?.isConfigSupported) return null;
  for (const config of candidateConfigs(codec, sampleRate, channels)) {
    try {
      if ((await Encoder.isConfigSupported(config)).supported) return config;
    } catch {
      // A configuration the browser considers malformed rather than unsupported.
    }
  }
  return null;
}

/**
 * What this browser can be handed instead of a codec it will not take — or null if nothing.
 *
 * Both halves have to hold: the browser has to be able to *produce* it and to *accept* it back
 * in a MediaSource. Firefox encodes Opus and takes it; Safari encodes Opus and does not.
 */
export async function chooseTranscodeCodec(sampleRate: number, channels: number): Promise<string | null> {
  for (const codec of [TARGET_CODEC, FALLBACK_CODEC]) {
    if (!containerAccepts(`audio/mp4; codecs="${codec}"`)) continue;
    if (await firstSupported(codec, sampleRate, channels)) {
      chosenTarget = codec;
      return codec;
    }
  }
  return null;
}

/**
 * The answer to the question above, kept for the places that cannot wait for it.
 *
 * Deciding what a re-encoded track will be delivered as means asking the browser, which is
 * asynchronous; naming that codec in a MIME type happens in the middle of building a plan, which
 * is not. The question is always put first — the path selector asks it before anything else is
 * opened — so by the time this is read it is the measured answer and not the default.
 */
export function transcodeTargetCodec(): string {
  return chosenTarget;
}

let chosenTarget = TARGET_CODEC;

export async function canEncodeAac(sampleRate: number, numberOfChannels: number): Promise<boolean> {
  return (await chooseTranscodeCodec(sampleRate, numberOfChannels)) !== null;
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
    readonly channels: number,
    private readonly actualCodec: string = "mp4a.40.2"
  ) {}

  private get config(): AudioEncoderConfig {
    return { codec: this.actualCodec, sampleRate: this.sampleRate, numberOfChannels: this.channels };
  }

  /** What the encoder actually produced, not what it was asked for. */
  get codecString(): string {
    return this.actualCodec;
  }

  /**
   * Opens the track and gets far enough to describe it.
   *
   * The description an MP4 needs is not in the file — it is produced by the encoder, and only
   * once it has encoded something. So a little sound is pushed through here and kept, which is
   * also the earliest point at which a browser that cannot do this at all will say so.
   */
  static async open(source: ByteSource, track: MatroskaTrack, fromSeconds = 0): Promise<AudioTranscoder> {
    const Encoder = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
    if (!Encoder) throw new Error("Ce navigateur ne sait pas encoder de l'audio.");

    trace(`transcodage audio : chargement du décodeur ${track.codecId}`);
    const decoder = await SoftwareAudioTrack.open(source, track.number, track.codecId);
    const { sampleRate, numberOfChannels } = decoder.format;
    trace(`transcodage audio : décodeur prêt — ${sampleRate} Hz, ${numberOfChannels} canaux`);
    const target = await chooseTranscodeCodec(sampleRate, numberOfChannels);
    if (!target) {
      decoder.close();
      throw new Error(`Ce navigateur ne sait produire aucun codec audio en ${numberOfChannels} canaux.`);
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
    // The shape this browser accepted when it was asked, a moment ago.
    const config =
      (await firstSupported(target, sampleRate, numberOfChannels)) ?? { codec: target, sampleRate, numberOfChannels };
    encoder.configure(config);
    trace(`transcodage audio : encodeur configuré (${target}), amorçage à ${fromSeconds.toFixed(1)} s`);

    // Enough to make the encoder describe itself, and no more: this runs before the first frame
    // of video is shown, so it is time the viewer is waiting through. Bounded, because an
    // encoder that accepts a configuration and then never answers is a real possibility — and a
    // player that waits for ever on it is worse than one that says what went wrong.
    // Primed where playback is, not at the start of the film: this also runs on a language
    // change, and reading the opening back two hours in is network traffic spent on nothing.
    const primer = decoder.samples(Math.max(0, fromSeconds));
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

    // Asking for a profile is not the same as being given it. The description is the only
    // statement of what came out, and everything written beside it in the container — the codec
    // string, the sample rate, the channel count — has to agree with it or the init segment
    // contradicts itself. Safari does not merely refuse such a segment: it closes the
    // MediaSource, and every buffer on it, including the video's, becomes invalid.
    // Chrome hands back the bare configuration; Safari hands back the whole descriptor tree with
    // the configuration inside it. Both have to end up as the same bytes here, or the `esds`
    // built below describes a description.
    const asc = target === TARGET_CODEC ? (extractAudioSpecificConfig(description) ?? description) : description;
    const actual = target === TARGET_CODEC ? parseAacConfig(asc) : null;
    const read =
      target === TARGET_CODEC
        ? actual
          ? `AOT ${actual.objectType}, ${actual.sampleRate} Hz, ${actual.channels} canaux`
          : "illisible"
        : // Opus says the same things in its own header: channels at byte 9, rate little-endian
          // at 12. Worth reading back for the same reason as the AAC one — the container is
          // about to state both, and it has to state what actually came out.
          `${asc[9]} canaux, ${new DataView(asc.buffer, asc.byteOffset, asc.byteLength).getUint32(12, true)} Hz`;
    trace(
      `transcodage audio : encodeur amorcé — description ${[...(description as Uint8Array)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")}${asc === description ? "" : ` (config extraite : ${[...asc].map((b) => b.toString(16).padStart(2, "0")).join(" ")})`} → ${read}`
    );

    const entryRate = actual?.sampleRate ?? sampleRate;
    const entryChannels = actual?.channels ?? numberOfChannels;
    const codecString = target === TARGET_CODEC ? (actual ? `mp4a.40.${actual.objectType}` : TARGET_CODEC) : target;

    const sampleEntry =
      target === TARGET_CODEC
        ? audioSampleEntryFor({
            codecId: "A_AAC",
            codecPrivate: asc,
            channels: entryChannels,
            sampleRate: entryRate,
            firstFrame: null,
          })
        : // Opus describes itself with the identification header, which is not shaped like the
          // box an MP4 wants — see dOps.
          opusSampleEntry(asc, entryChannels, entryRate);

    const transcoder = new AudioTranscoder(
      decoder,
      encoder,
      sampleEntry,
      sampleRate,
      numberOfChannels,
      codecString
    );
    sink.frame = (frame) => transcoder.collect(frame);
    sink.failed = (message) => transcoder.fail(message);
    // The priming output is thrown away rather than kept: the first segment asked for may be
    // anywhere. Reading it again costs nothing — those bytes are cached now.
    transcoder.seekTo(fromSeconds);
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
