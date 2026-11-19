// Audio for the codecs no browser decodes — Lumen's own chain since 10.63 (DECISIONS.md §197).
//
// 72% of this library's files have no audio track a browser can decode from its own baseline —
// AC3 and E-AC3 above all — and on a device whose OS doesn't provide them either (an iPhone, as
// it turns out) that means a silent film. Every track here is read by the player's own container
// reader (audioDemux.ts — the one that already serves the picture, so nothing is read twice) and
// decoded by: FFmpeg 7.1.5 compiled here (AC-3, E-AC3, DTS: tools/ac3dts-wasm; TrueHD:
// tools/truehd-wasm), libFLAC, the AAC decoder of FFmpeg for a PCE (aac/), a plain conversion for
// PCM, and the browser's own AudioDecoder for Opus, AAC and MP3.
//
// mediabunny did this from 21/09 to 19/11/2026 — its demuxer and @mediabunny/ac3 and /dts. It was
// removed once its replacement had been proved identical to the sample on the library (§197).

import { aacDecoderRouteHere, aacPlan, remapPlanes } from "./aacConfig";
import { effectivePceAnswer } from "./aacPceProbe";
import type { ByteSource } from "./byteSource";
import type { MatroskaFile } from "./matroska";

export interface SoftwareAudioFormat {
  sampleRate: number;
  numberOfChannels: number;
}

/** Par quel décodeur le dernier AAC à PCE s'est ouvert — pour la ligne `start` (DECISIONS.md §62). */
let lastAacRoute: "wasm-decode" | "browser-decode" | null = null;

/** La dernière piste ouverte par nos paquets (essai demux-son) — pour le banc. */
let lastOwnDemux: import("./ownAudio").OwnAudioTrack | null = null;
export function takeOwnDemux(): import("./ownAudio").OwnAudioTrack | null {
  const own = lastOwnDemux;
  lastOwnDemux = null;
  return own;
}

/** Lu (et oublié) par qui écrit la ligne `start`. */
export function takeAacDecodeRoute(): "wasm-decode" | "browser-decode" | null {
  const route = lastAacRoute;
  lastAacRoute = null;
  return route;
}

/**
 * Où le dernier décodeur TrueHD s'est ouvert — le worker, ou le fil principal et pourquoi — pour la
 * ligne `start` (truehd/truehdDecoder.ts). Rien quand le pipeline n'a pas ouvert de TrueHD.
 */
let lastTrueHdThread: { thread: "worker" | "principal"; workerRefusal?: string } | null = null;

/** Lu (et oublié) par qui écrit la ligne `start`. */
export function takeTrueHdThread(): { thread: "worker" | "principal"; workerRefusal?: string } | null {
  const thread = lastTrueHdThread;
  lastTrueHdThread = null;
  return thread;
}

export class SoftwareAudioTrack {
  private constructor(
    /** Le décodé à partir d'un instant — par nos paquets (ownAudio.ts) ou nos décodeurs WebAssembly. */
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
    file?: MatroskaFile,
    /**
     * Décoder un AAC par le décodeur de FFmpeg en WebAssembly sur tous les navigateurs, Chromium
     * compris : c'est le seul dont l'ordre de sortie d'un 5.1 est mesuré ici (L R C LFE Ls Rs, à
     * 0,06 dB d'ffmpeg sur la VF de « Forrest Gump », 11/10/2026). Demandé par « Améliorer les
     * dialogues », qui remonte le rang 2 et ne doit pas parier sur l'ordre d'un autre décodeur.
     */
    options: { measuredAacDecoder?: boolean } = {}
  ): Promise<SoftwareAudioTrack> {
    // Le TrueHD : son propre lecteur de blocs et son décodeur (truehd/truehdAudio.ts), la même forme
    // de sortie.
    if (codecId === "A_TRUEHD" || codecId === "A_MLP") {
      let track;
      try {
        track = await (await import("./truehd/truehdAudio")).openTrueHdTrack(source, trackNumber, file);
      } catch (error) {
        throw new Error(`décodeur TrueHD non chargé (${error instanceof Error ? error.message : "import échoué"})`);
      }
      lastTrueHdThread = { thread: track.thread, ...(track.workerRefusal !== undefined ? { workerRefusal: track.workerRefusal } : {}) };
      return new SoftwareAudioTrack(track.samples, track.format, () => track.close());
    }
    // Un AAC à PCE hors Chromium : le décodeur AAC de FFmpeg en WebAssembly, jamais celui du
    // navigateur — celui de Safari (CoreAudio) échoue sur le PCE de « Ruby », et un décodeur qu'on
    // n'a pas mesuré pourrait ranger les canaux autrement. Sur Chromium, l'AudioDecoder du navigateur
    // (prouvé, mesuré), et le même décodeur WebAssembly s'il refuse la piste (DECISIONS.md §62).
    if (codecId === "A_AAC" && (aacDecoderRouteHere() === "wasm" || options.measuredAacDecoder)) return SoftwareAudioTrack.openWasmAac(source, trackNumber, file);
    if (codecId === "A_AAC") {
      try {
        return await SoftwareAudioTrack.openOwn(source, trackNumber, codecId, file);
      } catch (error) {
        try {
          return await SoftwareAudioTrack.openWasmAac(source, trackNumber, file);
        } catch {
          throw error;
        }
      }
    }
    return SoftwareAudioTrack.openOwn(source, trackNumber, codecId, file);
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

  /** Une piste ouverte par nos paquets (ownAudio.ts), rangée comme les autres — l'AAC à PCE compris. */
  private static fromOwn(own: import("./ownAudio").OwnAudioTrack, codecId: string | undefined, file: MatroskaFile, trackNumber: number): SoftwareAudioTrack {
    lastOwnDemux = own;
    const shape = codecId === "A_AAC" ? aacShaping(file, trackNumber, own.format.numberOfChannels) : null;
    if (codecId === "A_AAC") lastAacRoute = "browser-decode";
    const produce = shape?.rows
      ? (fromSeconds: number) => remapped(own.samples(fromSeconds), shape.rows!)
      : shape && shape.channels < own.format.numberOfChannels
        ? (fromSeconds: number) => firstPlanes(own.samples(fromSeconds), shape.channels)
        : (fromSeconds: number) => own.samples(fromSeconds);
    return new SoftwareAudioTrack(produce, { sampleRate: own.format.sampleRate, numberOfChannels: shape ? shape.channels : own.format.numberOfChannels }, () => {});
  }

  /**
   * Nos paquets et le décodeur du codec (ownAudio.ts). Le fichier déjà lu par le lecteur est
   * nécessaire : c'est son en-tête et son index qui servent — on ne les relit jamais.
   */
  private static async openOwn(source: ByteSource, trackNumber: number, codecId: string | undefined, file?: MatroskaFile): Promise<SoftwareAudioTrack> {
    if (!file) throw new Error("décodeur audio non chargé (fichier non lu)");
    let own;
    try {
      own = await (await import("./ownAudio")).openOwnAudioTrack(source, file, trackNumber);
    } catch (error) {
      throw new Error(`décodeur audio non chargé (${error instanceof Error ? error.message : "import échoué"})`);
    }
    return SoftwareAudioTrack.fromOwn(own, codecId, file, trackNumber);
  }

  /** Decoded audio from `fromSeconds` onwards, as plain float planes. */
  samples(fromSeconds: number): AsyncGenerator<DecodedAudio> {
    return this.produce(fromSeconds);
  }

  close(): void {
    this.dispose();
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
