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
