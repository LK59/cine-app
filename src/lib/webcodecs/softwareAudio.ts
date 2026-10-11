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
// would fetch the file a second time; given a CustomSource backed by the player's own ByteSource
// it reads through the same 1 MiB chunk cache, so the bytes cross the network once and the
// second demux costs CPU only.

import { aacDecoderRouteHere, aacPlan, remapPlanes } from "./aacConfig";
import { effectivePceAnswer } from "./aacPceProbe";
import type { ByteSource } from "./byteSource";
import type { MatroskaFile } from "./matroska";

export interface SoftwareAudioFormat {
  sampleRate: number;
  numberOfChannels: number;
}

type Mediabunny = typeof import("mediabunny");
type MediabunnyInput = InstanceType<Mediabunny["Input"]>;

/**
 * Un lecteur de conteneur mediabunny par fichier, partagé par toutes ses pistes.
 *
 * Il en était créé un par ouverture de piste, et chacun relisait l'en-tête et l'index du fichier :
 * 1,6 s sur un iPhone pour ouvrir l'E-AC3 de Braveheart, à chaque changement de langue
 * (21/09/2026). Ce qui a été lu une fois pour une piste vaut pour les autres. La clé est la
 * source d'octets de la lecture — une par film ouvert — et l'entrée disparaît avec elle ; un
 * lecteur dont l'ouverture a échoué n'est pas gardé, pour que la piste suivante réessaie.
 */
const inputs = new WeakMap<ByteSource, Promise<MediabunnyInput>>();

function sharedInput(source: ByteSource, core: Mediabunny, iso: boolean): Promise<MediabunnyInput> {
  let input = inputs.get(source);
  if (!input) {
    const created = new core.Input({
      // The class is the format; mediabunny wants an instance. Le conteneur est celui que notre
      // propre lecture a reconnu (mediaFile.ts) — un MP4 lu comme un Matroska ne donnait aucune
      // piste, et un E-AC3 de MP4 restait muet sur Chrome faute de décodeur. Les numéros de piste
      // concordent : mediabunny nomme une piste MP4 par le `track_ID` de son `tkhd`, comme nous.
      formats: [iso ? new core.Mp4InputFormat() : new core.MatroskaInputFormat()],
      source: new core.CustomSource({
        getSize: () => source.size,
        // end is exclusive, and the player's source clamps at EOF on its own.
        read: (start, end) => source.read(start, end - start),
      }),
    });
    // Lire les pistes tout de suite : c'est ce qui coûte, et c'est ce qui échoue s'il doit échouer.
    input = created.getAudioTracks().then(() => created);
    inputs.set(source, input);
    input.catch(() => inputs.delete(source));
  }
  return input;
}

/** Par quel décodeur le dernier AAC à PCE s'est ouvert — pour la ligne `start` (DECISIONS.md §62). */
let lastAacRoute: "wasm-decode" | "browser-decode" | null = null;

/** Lu (et oublié) par qui écrit la ligne `start`. */
export function takeAacDecodeRoute(): "wasm-decode" | "browser-decode" | null {
  const route = lastAacRoute;
  lastAacRoute = null;
  return route;
}

export class SoftwareAudioTrack {
  private constructor(
    /** Le décodé à partir d'un instant — par mediabunny, ou par notre décodeur TrueHD. */
    private readonly produce: (fromSeconds: number) => AsyncGenerator<DecodedAudio>,
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
  static async open(
    source: ByteSource,
    trackNumber: number,
    codecId?: string,
    /** Le fichier déjà lu par l'appelant, pour ne pas relire son en-tête — voir le TrueHD. */
    file?: MatroskaFile
  ): Promise<SoftwareAudioTrack> {
    // Le TrueHD ne passe pas par mediabunny, qui ne le connaît pas : notre propre décodeur, et
    // la même forme de sortie — voir truehd/truehdAudio.ts.
    if (codecId === "A_TRUEHD" || codecId === "A_MLP") {
      let track;
      try {
        track = await (await import("./truehd/truehdAudio")).openTrueHdTrack(source, trackNumber, file);
      } catch (error) {
        throw new Error(`décodeur TrueHD non chargé (${error instanceof Error ? error.message : "import échoué"})`);
      }
      return new SoftwareAudioTrack(track.samples, track.format, () => track.close());
    }
    // Un AAC à PCE hors Chromium : le décodeur AAC de FFmpeg en WebAssembly, jamais celui du
    // navigateur — celui de Safari (CoreAudio) échoue sur le PCE de « Ruby », et un décodeur qu'on
    // n'a pas mesuré pourrait ranger les canaux autrement. Sur Chromium, l'AudioDecoder du navigateur
    // (prouvé, mesuré), et le même décodeur WebAssembly s'il refuse la piste (DECISIONS.md §62).
    if (codecId === "A_AAC" && aacDecoderRouteHere() === "wasm") return SoftwareAudioTrack.openWasmAac(source, trackNumber, file);
    if (codecId === "A_AAC") {
      try {
        return await SoftwareAudioTrack.openWithMediabunny(source, trackNumber, codecId, file);
      } catch (error) {
        try {
          return await SoftwareAudioTrack.openWasmAac(source, trackNumber, file);
        } catch {
          throw error;
        }
      }
    }
    return SoftwareAudioTrack.openWithMediabunny(source, trackNumber, codecId, file);
  }

  /** Un AAC à PCE par le décodeur de FFmpeg en WebAssembly — voir aac/aacWasmAudio.ts. */
  private static async openWasmAac(source: ByteSource, trackNumber: number, file?: MatroskaFile): Promise<SoftwareAudioTrack> {
    let track;
    try {
      track = await (await import("./aac/aacWasmAudio")).openWasmAacTrack(source, trackNumber, file);
    } catch (error) {
      throw new Error(`décodeur AAC non chargé (${error instanceof Error ? error.message : "import échoué"})`);
    }
    lastAacRoute = "wasm-decode";
    const { channels, rows } = aacShaping(file, trackNumber, track.format.numberOfChannels, true) ?? { channels: track.format.numberOfChannels, rows: null };
    const produce = rows
      ? (fromSeconds: number) => remapped(track.samples(fromSeconds), rows)
      : channels < track.format.numberOfChannels
        ? (fromSeconds: number) => firstPlanes(track.samples(fromSeconds), channels)
        : (fromSeconds: number) => track.samples(fromSeconds);
    return new SoftwareAudioTrack(produce, { sampleRate: track.format.sampleRate, numberOfChannels: channels }, () => track.close());
  }

  private static async openWithMediabunny(
    source: ByteSource,
    trackNumber: number,
    codecId?: string,
    file?: MatroskaFile
  ): Promise<SoftwareAudioTrack> {
    // Dynamic, and only the extension this file actually needs: the two are a megabyte and a
    // half each, and a file whose audio the browser already decodes never pays for either.
    let core;
    try {
      core = await import("mediabunny");
      if (codecId === "A_DTS" || codecId?.startsWith("A_DTS/")) {
        (await import("@mediabunny/dts")).registerDtsDecoder();
      } else if (codecId === "A_FLAC") {
        (await import("./flacDecoder")).registerFlacDecoder();
      } else if (codecId === "A_OPUS" || codecId === "A_AAC") {
        // Rien à charger : mediabunny décode l'Opus — et l'AAC à PCE (voir aacConfig.ts) — par
        // l'AudioDecoder du navigateur. Charger ici le décodeur AC-3, c'était un mégaoctet pour rien.
      } else {
        (await import("@mediabunny/ac3")).registerAc3Decoder();
      }
    } catch (error) {
      throw new Error(`décodeur audio non chargé (${error instanceof Error ? error.message : "import échoué"})`);
    }
    const { AudioSampleSink } = core;
    const input = await sharedInput(source, core, file?.mp4 !== undefined);

    const tracks = await input.getAudioTracks();
    const track = tracks.find((t) => t.id === trackNumber) ?? tracks[0];
    if (!track) throw new Error("aucune piste audio trouvée par le décodeur logiciel");
    if (!(await track.canDecode())) throw new Error(`le décodeur logiciel refuse ${track.codec ?? "cette piste"}`);

    const sink = new AudioSampleSink(track) as unknown as { samples(from: number): AsyncIterable<SoftwareSample> };
    // Un AAC à PCE : le décodeur n'en rend que le compte, jamais la disposition. `aacPlan` dit
    // comment le ranger (DECISIONS.md §62) — tel quel pour une forme dont l'ordre de sortie a été
    // mesuré (« Ruby » : un 5.1), par une matrice pour une disposition à replier, L R C sinon.
    const shape = codecId === "A_AAC" ? aacShaping(file, trackNumber, track.numberOfChannels) : null;
    if (codecId === "A_AAC") lastAacRoute = "browser-decode";
    const produce = shape?.rows
      ? (fromSeconds: number) => remapped(planesFrom(sink, fromSeconds), shape.rows!)
      : shape && shape.channels < track.numberOfChannels
        ? (fromSeconds: number) => firstPlanes(planesFrom(sink, fromSeconds), shape.channels)
        : (fromSeconds: number) => planesFrom(sink, fromSeconds);
    return new SoftwareAudioTrack(
      produce,
      { sampleRate: track.sampleRate, numberOfChannels: shape ? shape.channels : track.numberOfChannels },
      // Rien à libérer ici : le lecteur de conteneur est partagé par les pistes du fichier, et
      // part avec la source quand la lecture s'arrête (voir sharedInput).
      () => {}
    );
  }

  /** Decoded audio from `fromSeconds` onwards, as plain float planes. See planesFrom. */
  samples(fromSeconds: number): AsyncGenerator<DecodedAudio> {
    return this.produce(fromSeconds);
  }

  close(): void {
    this.dispose();
  }
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
async function* planesFrom(
  sink: { samples(from: number): AsyncIterable<SoftwareSample> },
  fromSeconds: number
): AsyncGenerator<DecodedAudio> {
  for await (const sample of sink.samples(fromSeconds)) {
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

/**
 * Comment ranger le décodé d'un AAC : `channels` livrés dans l'ordre standard, et la matrice à
 * appliquer quand il y en a une. Sans la description de la piste, pour un AAC ordinaire, ou quand
 * le décodeur ne rend pas le compte attendu, `null` : le décodé tel quel, comme avant.
 */
export function aacShaping(
  file: MatroskaFile | undefined,
  trackNumber: number,
  decoded: number,
  /** Le décodeur AAC de FFmpeg en WebAssembly : l'ordre mesuré, quel que soit le navigateur. */
  ffmpegDecoder = false
): { channels: number; rows: number[][] | null } | null {
  const asc = file?.tracks.find((t) => t.number === trackNumber)?.codecPrivate;
  if (!asc) return null;
  // Décodé ici, il l'est de toute façon : la copie n'est plus en jeu (refusée, ou Chromium).
  const plan = ffmpegDecoder
    ? aacPlan(asc, { pceAccepted: false, orderMeasured: true })
    : aacPlan(asc, { pceAccepted: effectivePceAnswer(asc) });
  if (plan.action !== "decode") return null;
  if (plan.rows) return plan.rows[0]?.length === decoded ? { channels: plan.channels, rows: plan.rows } : { channels: Math.min(3, decoded), rows: null };
  return { channels: Math.min(plan.channels, decoded), rows: null };
}

/** Le décodé, rangé par `remapPlanes`. */
async function* remapped(source: AsyncGenerator<DecodedAudio>, rows: number[][]): AsyncGenerator<DecodedAudio> {
  for await (const decoded of source) yield { ...decoded, planes: remapPlanes(decoded.planes, rows) };
}

/** Le décodé, réduit à ses `count` premiers canaux. */
async function* firstPlanes(source: AsyncGenerator<DecodedAudio>, count: number): AsyncGenerator<DecodedAudio> {
  for await (const decoded of source) yield { ...decoded, planes: decoded.planes.slice(0, count) };
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
