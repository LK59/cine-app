// Audio for the codecs no browser decodes.
//
// 72% of this library's files have no audio track a browser can decode from its own baseline —
// AC3 and E-AC3 above all — and on a device whose OS doesn't provide them either (an iPhone, as
// it turns out) that means a silent film. Every published libav.js variant was checked and none
// carries those decoders; Jellyfin refuses to extract audio alone from a video item. What does
// work is @mediabunny/ac3, a 1.1 MB libavcodec-derived decoder — smaller than hls.js, and loaded
// only when a file actually needs it.
//
// The one thing worth care here is that mediabunny does its own demuxing. Pointed at the URL it
// would fetch the file a second time; given a CustomSource backed by the engine's own ByteSource
// it reads through the same 1 MiB chunk cache, so the bytes cross the network once and the
// second demux costs CPU only.

import type { ByteSource } from "./byteSource";

export interface SoftwareAudioFormat {
  sampleRate: number;
  numberOfChannels: number;
}

export class SoftwareAudioTrack {
  private constructor(
    private readonly sink: { samples(from: number): AsyncIterable<SoftwareSample> },
    readonly format: SoftwareAudioFormat,
    private readonly dispose: () => void
  ) {}

  /**
   * Opens the given Matroska track for software decoding.
   *
   * Throws with a specific reason rather than returning null: "no sound" with no explanation is
   * exactly the kind of failure that costs a round trip to diagnose, and every step here can fail
   * for a different reason — the module not loading, the worker not starting, the track not being
   * found, the decoder declining it.
   */
  static async open(source: ByteSource, trackNumber: number): Promise<SoftwareAudioTrack> {
    // Dynamic: a file whose audio the browser already decodes never pays for this.
    let modules;
    try {
      modules = await Promise.all([import("mediabunny"), import("@mediabunny/ac3")]);
    } catch (error) {
      throw new Error(`décodeur audio non chargé (${error instanceof Error ? error.message : "import échoué"})`);
    }
    const [{ Input, CustomSource, MatroskaInputFormat, AudioSampleSink }, { registerAc3Decoder }] = modules;
    registerAc3Decoder();

    const input = new Input({
      // The class is the format; mediabunny wants an instance.
      formats: [new MatroskaInputFormat()],
      source: new CustomSource({
        getSize: () => source.size,
        // end is exclusive, and the engine's source clamps at EOF on its own.
        read: (start, end) => source.read(start, end - start),
      }),
    });

    const tracks = await input.getAudioTracks();
    const track = tracks.find((t) => t.id === trackNumber) ?? tracks[0];
    if (!track) throw new Error("aucune piste audio trouvée par le décodeur logiciel");
    if (!(await track.canDecode())) throw new Error(`le décodeur logiciel refuse ${track.codec ?? "cette piste"}`);

    return new SoftwareAudioTrack(
      new AudioSampleSink(track) as unknown as { samples(from: number): AsyncIterable<SoftwareSample> },
      { sampleRate: track.sampleRate, numberOfChannels: track.numberOfChannels },
      () => void input.dispose?.()
    );
  }

  /**
   * Decoded audio from `fromSeconds` onwards, as plain float planes.
   *
   * Deliberately NOT via AudioSample.toAudioData(). That step was the one part of this chain
   * never verified anywhere: reading the PCM straight off the sample is what was measured
   * against real library files (6-channel E-AC3, peak 0.145, ten times real time), while
   * toAudioData() constructs a WebCodecs object whose relationship to the sample's memory is an
   * assumption. Handing back the floats keeps the proven path and removes a conversion nobody
   * needs.
   */
  async *samples(fromSeconds: number): AsyncGenerator<DecodedAudio> {
    for await (const sample of this.sink.samples(fromSeconds)) {
      const planes: Float32Array[] = [];
      for (let channel = 0; channel < sample.numberOfChannels; channel++) {
        const plane = new Float32Array(sample.numberOfFrames);
        sample.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
        planes.push(plane);
      }
      const decoded = { planes, sampleRate: sample.sampleRate, timestampSeconds: sample.timestamp };
      sample.close();
      yield decoded;
    }
  }

  close(): void {
    this.dispose();
  }
}

/** Decoded audio in the one representation both decoder paths agree on. */
export interface DecodedAudio {
  planes: Float32Array[];
  sampleRate: number;
  /** Presentation time in seconds. */
  timestampSeconds: number;
}

interface SoftwareSample {
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly sampleRate: number;
  /** Seconds, per mediabunny's own convention. */
  readonly timestamp: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: string }): void;
  close(): void;
}
