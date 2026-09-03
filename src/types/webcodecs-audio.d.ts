// The audio half of WebCodecs, which this project's TypeScript DOM library doesn't declare yet
// (the video half — VideoFrame, VideoDecoder, EncodedVideoChunk — is already there).
//
// Declared to match the specification rather than to whatever satisfies the call sites: an
// over-loose declaration here would let a genuine mistake compile and only fail at runtime, in a
// browser, which is the one place this code is hard to debug.

type AudioSampleFormat = "u8" | "s16" | "s32" | "f32" | "u8-planar" | "s16-planar" | "s32-planar" | "f32-planar";

interface AudioDataCopyToOptions {
  planeIndex: number;
  frameOffset?: number;
  frameCount?: number;
  format?: AudioSampleFormat;
}

interface AudioDataInit {
  format: AudioSampleFormat;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: BufferSource;
  transfer?: ArrayBuffer[];
}

declare class AudioData {
  constructor(init: AudioDataInit);
  readonly format: AudioSampleFormat | null;
  readonly sampleRate: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly duration: number;
  readonly timestamp: number;
  allocationSize(options: AudioDataCopyToOptions): number;
  copyTo(destination: BufferSource, options: AudioDataCopyToOptions): void;
  clone(): AudioData;
  close(): void;
}

interface AudioDecoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: BufferSource;
}

interface AudioDecoderSupport {
  supported: boolean;
  config: AudioDecoderConfig;
}

interface AudioDecoderInit {
  output: (data: AudioData) => void;
  error: (error: DOMException) => void;
}

declare class AudioDecoder {
  constructor(init: AudioDecoderInit);
  readonly state: "unconfigured" | "configured" | "closed";
  readonly decodeQueueSize: number;
  configure(config: AudioDecoderConfig): void;
  decode(chunk: EncodedAudioChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
  static isConfigSupported(config: AudioDecoderConfig): Promise<AudioDecoderSupport>;
}

interface EncodedAudioChunkInit {
  type: "key" | "delta";
  timestamp: number;
  duration?: number;
  data: BufferSource;
}

declare class EncodedAudioChunk {
  constructor(init: EncodedAudioChunkInit);
  readonly type: "key" | "delta";
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  copyTo(destination: BufferSource): void;
}

/**
 * The encoding half, absent from this project's DOM lib for the same reason as the decoding half.
 *
 * It is what makes a codec no browser decodes playable at all: the sound is decoded here in
 * software and handed back as something the browser does accept, so the picture never has to
 * leave the hardware path.
 */
interface AudioEncoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate?: number;
  /** AAC framing. "aac" is raw frames, which is what an MP4 carries; "adts" adds a header. */
  aac?: { format?: "aac" | "adts" };
}

interface AudioEncoderSupport {
  supported: boolean;
  config: AudioEncoderConfig;
}

/** Carried on the first output, and the only place the decoder configuration comes from. */
interface EncodedAudioChunkMetadata {
  decoderConfig?: {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
    description?: BufferSource;
  };
}

interface AudioEncoderInit {
  output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => void;
  error: (error: DOMException) => void;
}

declare class AudioEncoder {
  constructor(init: AudioEncoderInit);
  readonly state: "unconfigured" | "configured" | "closed";
  readonly encodeQueueSize: number;
  static isConfigSupported(config: AudioEncoderConfig): Promise<AudioEncoderSupport>;
  configure(config: AudioEncoderConfig): void;
  encode(data: AudioData): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}
