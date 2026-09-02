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

  /** Decoded audio from `fromSeconds` onwards, as the WebCodecs type the output stage expects. */
  async *samples(fromSeconds: number): AsyncGenerator<AudioData> {
    for await (const sample of this.sink.samples(fromSeconds)) {
      // toAudioData() hands over an AudioData that owns its own memory, so the sample itself can
      // be released immediately — otherwise the decoder's buffers pile up behind the playhead.
      const data = sample.toAudioData();
      sample.close();
      yield data;
    }
  }

  close(): void {
    this.dispose();
  }
}

interface SoftwareSample {
  toAudioData(): AudioData;
  close(): void;
}
