// FLAC for the browser that will not take it — Safari on an iPhone.
//
// Chrome and Firefox accept FLAC inside a MediaSource, and there the track is carried untouched.
// Safari refuses it (measured on an iPhone on 21/09/2026: switching *Stand by Me* to its FLAC
// track handed the film to the server player), so FLAC joins DTS and AC-3 on the re-encoding
// path: decoded here, encoded again as AAC, and the picture stays on the hardware.
//
// The decoder is libFLAC, the format's reference implementation, compiled to WebAssembly by
// @wasm-audio-decoders/flac — not something written here. It is registered with mediabunny the
// way @mediabunny/dts registers its own, so everything downstream — demuxing through the engine's
// byte cache, timing, channel handling, the encoder — is the path DTS already proved.
//
// Channel order needs no care: FLAC's order for every count it defines is the WAVE order, which
// is the one AudioData expects (L R C LFE Ls Rs …). Nothing is permuted.
import { AudioSample, CustomAudioDecoder, registerDecoder, type EncodedPacket } from "mediabunny";
import type { FLACDecoder } from "@wasm-audio-decoders/flac";

/** Planes laid end to end, the layout `f32-planar` means. */
function planar(channels: Float32Array[], frames: number): Float32Array {
  const out = new Float32Array(channels.length * frames);
  channels.forEach((plane, i) => out.set(plane.subarray(0, frames), i * frames));
  return out;
}

class FlacDecoder extends CustomAudioDecoder {
  private decoder: FLACDecoder | null = null;

  static override supports(codec: string): boolean {
    return codec === "flac";
  }

  async init(): Promise<void> {
    const { FLACDecoder } = await import("@wasm-audio-decoders/flac");
    this.decoder = new FLACDecoder();
    await this.decoder.ready;
    // libFLAC reads a stream, not loose frames: the header comes first. Matroska's CodecPrivate
    // is exactly that — "fLaC" and the metadata blocks — and a frame whose header says "see
    // STREAMINFO" for its sample rate or depth cannot be read without it.
    const description = this.config.description;
    if (description) {
      const bytes =
        description instanceof ArrayBuffer
          ? new Uint8Array(description)
          : new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
      await this.decoder.decodeFrames([bytes.slice()]);
    }
  }

  async decode(packet: EncodedPacket): Promise<void> {
    if (!this.decoder) throw new Error("décodeur FLAC non initialisé");
    const decoded = await this.decoder.decodeFrames([packet.data]);
    if (decoded.samplesDecoded === 0) {
      // A frame that yields nothing and says why is an error worth surfacing; one that says
      // nothing is libFLAC still reading ahead, and the next packet will carry the samples.
      if (decoded.errors.length > 0) throw new Error(`FLAC illisible : ${decoded.errors[0].message}`);
      return;
    }
    this.onSample(
      new AudioSample({
        data: planar(decoded.channelData, decoded.samplesDecoded),
        format: "f32-planar",
        numberOfChannels: decoded.channelData.length,
        sampleRate: decoded.sampleRate,
        timestamp: packet.timestamp,
      })
    );
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    this.decoder?.free();
    this.decoder = null;
  }
}

let registered = false;

export function registerFlacDecoder(): void {
  if (registered) return;
  registered = true;
  registerDecoder(FlacDecoder);
}

export const __testing = { FlacDecoder };
