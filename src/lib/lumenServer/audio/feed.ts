// Le flux élémentaire d'une fenêtre de son à convertir, lu dans le fichier par le fil de calcul (DECISIONS.md §161).
//
// Ce que ffmpeg reçoit sur son entrée standard : les unités de la piste (trames DTS ou MPEG, unités d'accès
// TrueHD, paquets Opus enveloppés en Ogg) à partir de la dernière d'où un décodeur peut partir au moins 0,25 s
// avant la fenêtre (`planFeed`), et la position exacte du premier échantillon qu'il rendra. Lu comme un segment son
// copié (`buildAudio`, `segment.ts`) : les en-têtes de tous les blocs qui passent, la charge de la seule piste
// voulue. Le fil principal n'en reçoit que les octets à donner à ffmpeg, transférés.

import type { ByteSource } from "../../webcodecs/byteSource";
import type { MatroskaFile } from "../../webcodecs/matroska";
import { readBlockSamples, walkBlocks } from "../mkvBlocks";
import { concatUnits, decoderPrerollOf, FeedError, FFMPEG_INPUT_FORMAT, planFeed, type LumenConvertSource, type SourceBlock } from "./convertSource";
import { oggOpus } from "./ogg";
import { samplesToUs } from "./convertGrid";

/** Ce que le fil de calcul reçoit : la piste, la fenêtre, et où commencer à lire. */
export interface AudioFeedSpec {
  path: string;
  key: string;
  track: number;
  source: LumenConvertSource;
  /** La fenêtre d'entrée de l'encodeur, en échantillons absolus. */
  start: number;
  end: number;
  /**
   * Les grappes où lire : à partir de `fromAt` (une coupe de segment au moins 2 s avant la fenêtre et son
   * pré-roulement — le son d'un instant est rangé près de l'image du même instant, à une fraction de seconde
   * près selon le multiplexeur), jusqu'à `untilAt` (une coupe au moins 2 s après), ou la fin du fichier.
   * `retryAt` : une coupe plus tôt encore, si la première lecture ne remonte pas assez loin.
   */
  fromAt: number;
  untilAt: number | null;
  retryAt: number | null;
}

export interface AudioFeed {
  /** Le démultiplexeur de ffmpeg (`-f`). */
  format: string;
  /** Le décodeur à imposer (`-c:a`), ou absent. */
  decoder?: string;
  bytes: Uint8Array;
  startSample: number;
  endSample: number;
  units: number;
}

/** La marge de lecture autour de la fenêtre, en µs : l'arrondi de la grille et l'écart entre deux synchros TrueHD. */
const MARGIN_US = 500_000;

async function readBlocks(source: ByteSource, file: MatroskaFile, spec: AudioFeedSpec, fromAt: number): Promise<SourceBlock[]> {
  const lowUs = samplesToUs(spec.start - decoderPrerollOf(spec.source.codec)) - MARGIN_US;
  const highUs = samplesToUs(spec.end) + MARGIN_US;
  const blocks: SourceBlock[] = [];
  await walkBlocks(
    source,
    file,
    fromAt,
    async (head) => {
      if (head.track !== spec.track) return "continue";
      if (head.timeUs >= highUs) return "stop";
      if (head.timeUs < lowUs) return "continue";
      const samples = await readBlockSamples(source, file, head);
      blocks.push({ timeUs: head.timeUs, frames: samples.map((s) => new Uint8Array(s.data)) });
      return "continue";
    },
    spec.untilAt ?? undefined
  );
  return blocks;
}

/** Le flux d'une fenêtre, ou null si elle ne contient aucune unité (une fenêtre dans le silence). */
export async function readAudioFeed(source: ByteSource, file: MatroskaFile, spec: AudioFeedSpec): Promise<AudioFeed | null> {
  let blocks = await readBlocks(source, file, spec, spec.fromAt);
  let feed;
  try {
    feed = planFeed(spec.source, blocks, spec.start, spec.end);
  } catch (error) {
    if (!(error instanceof FeedError) || spec.retryAt === null || spec.retryAt >= spec.fromAt) throw error;
    blocks = await readBlocks(source, file, spec, spec.retryAt);
    feed = planFeed(spec.source, blocks, spec.start, spec.end);
  }
  if (!feed) return null;
  const bytes = spec.source.codec === "opus" ? oggOpus(spec.source.opusHead as Uint8Array, feed.units) : concatUnits(feed.units);
  return { format: FFMPEG_INPUT_FORMAT[spec.source.codec], ...(spec.source.decoder ? { decoder: spec.source.decoder } : {}), bytes, startSample: feed.startSample, endSample: feed.endSample, units: feed.units.length };
}
