// Le parcours des blocs d'un Matroska qui ne lit que ce qu'on lui demande.
//
// `SampleReader` (le lecteur du navigateur) lit chaque bloc en entier, de toutes les pistes : c'est ce
// qu'il faut pour jouer, et c'est ce qui rendait la vérification de l'index hors de prix au serveur —
// 0,5 à 1,2 Mo lus par point d'index, 872 Mo pour un épisode de *Ted Lasso* (1-remuxeur.md §1.2). Ici,
// l'en-tête de chaque bloc (piste, instant, drapeau de clé) suffit à décider ; la charge n'est lue que
// pour les pistes voulues, ou seulement sa tête (`sketchPicture`) quand il s'agit de savoir ce qu'est
// une image.
//
// Les octets d'un échantillon lu viennent de `parseBlock`, la fonction du lecteur : mêmes instants,
// même délaçage, mêmes données qu'un `SampleReader` aurait rendus pour cette piste.

import type { ByteSource } from "../webcodecs/byteSource";
import { forEachChild, readElementHeader, readUint, readVarSize, UNREADABLE } from "../webcodecs/ebml";
import { ID } from "../webcodecs/matroskaIds";
import { parseBlock, type MatroskaFile, type MediaSample } from "../webcodecs/matroska";

/** Ce que dit l'en-tête d'un bloc, sans sa charge. */
export interface BlockHead {
  track: number;
  /** Instant de présentation (µs), comme `parseBlock` le calcule. */
  timeUs: number;
  /** SimpleBlock : son drapeau ; Block : l'absence de ReferenceBlock dans son groupe. */
  isKey: boolean;
  simple: boolean;
  /** Le début de la charge du bloc (le numéro de piste) et sa taille — ce que `parseBlock` reçoit. */
  blockOffset: number;
  blockSize: number;
  /** Le début et la taille de la trame quand le bloc n'est pas lacé ; null s'il l'est. */
  frameOffset: number | null;
  frameSize: number;
  /** L'horodatage de la grappe, en tics — pour `parseBlock`. */
  clusterTicks: number;
  /** Durée du groupe (BlockDuration), en µs, ou null. */
  durationUs: number | null;
  /** Le début de la grappe qui contient ce bloc. */
  clusterOffset: number;
}

/** Les enfants du segment : aucun ne peut apparaître dans une grappe (même liste que `SampleReader`). */
const TOP_LEVEL = new Set<number>([ID.Cluster, ID.Cues, ID.SeekHead, ID.Info, ID.Tracks, 0x1254c367, 0x1043a770, 0x1941a469]);

/** Combien d'octets lire en tête d'un bloc : numéro de piste (≤ 8), instant (2), drapeaux (1). */
const BLOCK_HEAD = 12;

/**
 * Le visiteur rend « stop » pour arrêter, « skip-cluster » pour passer au début de la grappe suivante
 * sans lire le reste de celle-ci (une vérification d'index n'a besoin que du début d'une grappe).
 */
export type BlockVisit = (head: BlockHead) => unknown;

/**
 * Parcourt les blocs à partir de la grappe à `from`, dans l'ordre du fichier, jusqu'à ce que le
 * visiteur dise « stop », jusqu'à `until` (un décalage de grappe) ou jusqu'à la fin du segment.
 *
 * Une grappe de taille inconnue court jusqu'au prochain élément de premier niveau, comme dans
 * `SampleReader`. Un en-tête illisible arrête le parcours (le lecteur du navigateur s'arrêtait de
 * même, hors mode strict) : le segment qui en dépend le dira par une erreur nette.
 */
export async function walkBlocks(source: ByteSource, file: MatroskaFile, from: number, visit: BlockVisit, until?: number): Promise<void> {
  let cursor = from;
  const limit = Math.min(until ?? file.segmentEnd, file.segmentEnd);
  const usPerTick = file.timestampScaleNs / 1000;
  while (cursor < limit) {
    const element = await readElementHeader(source, cursor);
    if (!element || element === UNREADABLE) return;
    if (element.id !== ID.Cluster) {
      if (element.size === null) return;
      cursor = element.offset + element.size;
      continue;
    }
    const clusterOffset = cursor;
    const end = element.size === null ? file.segmentEnd : Math.min(element.offset + element.size, file.segmentEnd);
    let clusterTicks = 0;
    let nextTopLevel: number | null = null;
    let stopped = false;
    let skipCluster = false;

    const emit = async (head: BlockHead) => {
      const answer = await visit(head);
      if (answer === "stop") stopped = true;
      else if (answer === "skip-cluster") skipCluster = true;
      return stopped || skipCluster ? "stop" : "continue";
    };

    await forEachChild(source, element.offset, end, async (child) => {
      if (element.size === null && TOP_LEVEL.has(child.id)) {
        nextTopLevel = child.offset - child.headerSize;
        return "stop";
      }
      if (child.id === ID.Timestamp) {
        clusterTicks = readUint(await source.read(child.offset, child.size ?? 0));
        return "continue";
      }
      if (child.id === ID.SimpleBlock) {
        if (child.size === null) return "stop";
        const head = await blockHead(source, child.offset, child.size, clusterTicks, usPerTick, true, true, null, clusterOffset);
        return head ? emit(head) : "continue";
      }
      if (child.id === ID.BlockGroup) {
        if (child.size === null) return "stop";
        let block: { offset: number; size: number } | null = null;
        let hasReference = false;
        let durationTicks: number | null = null;
        await forEachChild(source, child.offset, child.offset + child.size, async (g) => {
          if (g.id === ID.Block && g.size !== null) block = { offset: g.offset, size: g.size };
          if (g.id === ID.ReferenceBlock) hasReference = true;
          if (g.id === ID.BlockDuration && g.size !== null) durationTicks = readUint(await source.read(g.offset, g.size));
          return "continue";
        });
        const found = block as { offset: number; size: number } | null;
        if (!found) return "continue";
        const duration = durationTicks === null ? null : Math.round((durationTicks as number) * usPerTick);
        const head = await blockHead(source, found.offset, found.size, clusterTicks, usPerTick, false, !hasReference, duration, clusterOffset);
        return head ? emit(head) : "continue";
      }
      return "continue";
    });
    if (stopped) return;
    cursor = element.size !== null ? element.offset + element.size : (nextTopLevel ?? file.segmentEnd);
  }
}

async function blockHead(
  source: ByteSource,
  offset: number,
  size: number,
  clusterTicks: number,
  usPerTick: number,
  simple: boolean,
  groupIsKey: boolean,
  durationUs: number | null,
  clusterOffset: number
): Promise<BlockHead | null> {
  const bytes = await source.read(offset, Math.min(size, BLOCK_HEAD));
  const track = readVarSize(bytes, 0);
  if (!track || track.value === null || track.width + 3 > bytes.length) return null;
  const relative = (bytes[track.width] << 24) >> 16 | bytes[track.width + 1]; // int16 signé
  const flags = bytes[track.width + 2];
  const laced = ((flags >> 1) & 0x03) !== 0;
  const frameOffset = offset + track.width + 3;
  return {
    track: track.value,
    // Le même calcul que `parseBlock` : arrondi de (grappe + relatif) × tic.
    timeUs: Math.round((clusterTicks + relative) * usPerTick),
    isKey: simple ? (flags & 0x80) !== 0 : groupIsKey,
    simple,
    blockOffset: offset,
    blockSize: size,
    frameOffset: laced ? null : frameOffset,
    frameSize: laced ? 0 : size - (track.width + 3),
    clusterTicks,
    durationUs,
    clusterOffset,
  };
}

/** Les échantillons d'un bloc, lus en entier — exactement ce que `SampleReader` aurait rendu. */
export async function readBlockSamples(source: ByteSource, file: MatroskaFile, head: BlockHead): Promise<MediaSample[]> {
  const data = await source.read(head.blockOffset, head.blockSize);
  const samples = parseBlock(data, head.clusterTicks, file.timestampScaleNs, head.simple, head.isKey);
  if (head.durationUs !== null) for (const sample of samples) sample.durationUs = head.durationUs;
  return samples;
}

// ── La tête d'une image ──────────────────────────────────────────────────────

/** Combien garder d'une tranche : son en-tête NAL et le début de l'en-tête de tranche (H.264 : 16 octets lus). */
const SLICE_KEEP = 32;
/** Un SEI H.264 est gardé entier jusqu'à cette taille : le point de reprise y est lu (`avcRecoveryPoint`). */
const AVC_SEI_KEEP = 16 * 1024;
/** Les autres unités : leur en-tête suffit (le type). */
const OTHER_KEEP = 4;

export interface PictureSketch {
  /**
   * Les unités NAL de l'image jusqu'à sa première tranche comprise, chacune tronquée et son préfixe
   * de longueur réécrit : une « image » que `isRandomAccessPoint`, `isRaslPicture` et `strayUnits`
   * lisent comme l'image entière, puisqu'ils ne regardent que les types et le début de la tranche.
   */
  sketch: Uint8Array;
  /** Une tranche a été trouvée : c'est une image (sinon un bloc égaré, *Dirty Dancing*). */
  slice: boolean;
}

/**
 * La tête d'une image, sans la lire : on suit les préfixes de longueur NAL jusqu'à la première
 * tranche. Deux ou trois petites lectures au lieu d'une image 4K de 300 Ko.
 *
 * Fidèle aux prédicats du lecteur sur l'image entière, par construction : une longueur invalide
 * arrête la marche au même endroit qu'eux (et ils retombent sur la parole du conteneur), et les
 * unités qui précèdent la tranche sont toutes là, dans l'ordre.
 */
export async function sketchPicture(source: ByteSource, offset: number, size: number, lengthSize: number, codecId: string): Promise<PictureSketch> {
  const hevc = codecId === "V_MPEGH/ISO/HEVC";
  const parts: Uint8Array[] = [];
  let at = offset;
  const end = offset + size;
  let slice = false;
  while (at + lengthSize + 1 <= end) {
    const head = await source.read(at, lengthSize + 1);
    if (head.length < lengthSize + 1) break;
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + head[i];
    if (length <= 0 || at + lengthSize + length > end) {
      // Une longueur fausse : gardée telle quelle pour que les prédicats s'arrêtent au même endroit.
      parts.push(head);
      break;
    }
    const header = head[lengthSize];
    const type = hevc ? (header >> 1) & 0x3f : header & 0x1f;
    const isSlice = hevc ? type <= 31 : type >= 1 && type <= 5;
    const keep = Math.min(length, isSlice ? SLICE_KEEP : !hevc && type === 6 ? AVC_SEI_KEEP : OTHER_KEEP);
    const unit = await source.read(at + lengthSize, keep);
    const prefixed = new Uint8Array(lengthSize + unit.length);
    let n = unit.length;
    for (let i = lengthSize - 1; i >= 0; i--) {
      prefixed[i] = n & 0xff;
      n = Math.floor(n / 256);
    }
    prefixed.set(unit, lengthSize);
    parts.push(prefixed);
    at += lengthSize + length;
    if (isSlice) {
      slice = true;
      break;
    }
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const sketch = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    sketch.set(part, o);
    o += part.length;
  }
  return { sketch, slice };
}
