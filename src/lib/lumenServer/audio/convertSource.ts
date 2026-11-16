// Ce qu'on sait d'une piste à convertir, et comment en placer chaque échantillon (DECISIONS.md §161).
//
// Code pur, sans Node. L'index (`lumenIndex.ts`) en tire les faits une fois (`convertSourceOf`) ; le fil de calcul
// en tire, pour une fenêtre, le flux élémentaire que ffmpeg décodera et la position exacte de son premier
// échantillon (`planFeed`).
//
// **Ne jamais placer les échantillons d'après les instants du conteneur** (5-conversion-son.md §5.4) : les blocs
// Matroska sont datés à la milliseconde, et `ffmpeg -ss` sur le MKV atterrit à 16–48 échantillons de l'instant
// voulu. Les échantillons se placent par leur **nombre**, sur la trame fixe du codec source, ancrée au premier bloc
// de la piste : la position d'un bloc est premier échantillon + arrondi((t − t₀) · 48 000 / F) · F, F étant la
// trame du codec (DTS 512, MP2/MP3 1 152, Opus une grille de 120 — 2,5 ms, la plus petite trame Opus), et les
// trames d'un même bloc se suivent. L'arrondi suffit tant que l'erreur de l'instant (une demi-milliseconde, une
// milliseconde si le multiplexeur tronque) reste sous F/2. **Pas pour TrueHD** : une unité d'accès dure 40
// échantillons (0,83 ms), moins de deux fois l'erreur — l'arrondi tomberait une unité à côté selon le bloc, et deux
// segments voisins ne se recolleraient plus. Chaque unité TrueHD porte son propre compteur (`input_timing`, 16 bits,
// modulo 65 536, +40 par unité à 48 kHz — relevé bloc par bloc sur *Braveheart*) : la position est celle du
// compteur, l'instant du bloc ne sert qu'à lever l'ambiguïté du modulo. Une discontinuité du compteur (un montage)
// retombe sur l'arrondi pour ce bloc seul.
//
// **La position d'une unité ne dépend que de son bloc** et des constantes de la piste : deux fenêtres qui se
// recouvrent placent le même bloc au même échantillon, quelle que soit celle qui l'a lu. C'est ce qui fait qu'un
// segment construit à froid après un saut et le même segment pris dans une tâche d'avance donnent les mêmes octets.

import { CONVERT_RATE, DECODER_PREROLL } from "./convertGrid";

/**
 * Le pré-roulement du décodeur d'un codec, en échantillons (voir `DECODER_PREROLL`). L'Opus demande plus : le décodeur
 * de FFmpeg (CELT et SILK, en flottants) garde des états de prédiction qui ne reviennent au bit près qu'après
 * plusieurs centaines de millisecondes — au banc du 17/11/2026, 0,25 s laissait différer une à deux trames E-AC-3 en
 * tête d'un segment sur deux (*House*, *JoJo*). Une seconde coûte peu : l'Opus se décode à plus de 300 fois le temps réel.
 */
export function decoderPrerollOf(codec: ConvertCodec): number {
  return codec === "opus" ? OPUS_PREROLL : DECODER_PREROLL;
}
const OPUS_PREROLL = 48_000;

/**
 * Le décodeur de FFmpeg pour un codec, quand le choix par défaut ne convient pas : pour le MP2 et le MP3, les décodeurs
 * **en flottants** (`mp2float`, `mp3float`). Les décodeurs en entiers de FFmpeg (`mp2`, `mp3`) tramaient leur sortie
 * (un « dither » dont l'état court d'une trame à l'autre) : au banc du 17/11/2026, aucune trame E-AC-3 d'un segment
 * fait seul n'était celle de la tâche longue (0 sur 669 en MP2, 0 sur 996 en MP3, quel que soit le pré-roulement),
 * contre toutes en flottants. Pour le MP2, FFmpeg choisit de lui-même le décodeur en entiers : il faut l'écarter
 * nommément. Null : le seul décodeur du codec.
 */
export function decoderOf(codec: ConvertCodec, codecId: string): string | null {
  if (codec === "mpeg") return codecId === "A_MPEG/L2" ? "mp2float" : "mp3float";
  return null;
}
import { readDolbyHeader } from "./dolbySilence";

/**
 * Les familles de codecs que Lumen serveur sait convertir, par le `CodecID` Matroska. `dolby` (AC-3/E-AC-3) n'est
 * jamais converti en service — ces pistes se copient — : il sert au banc, qui fait passer une piste copiable par la
 * chaîne de conversion pour comparer son décodage à celui de la copie (la synchronisation image-son, à
 * l'échantillon) et pour éprouver le silence devant une piste qui commence tard.
 */
export type ConvertCodec = "dts" | "truehd" | "opus" | "mpeg" | "dolby";

export const CONVERT_CODECS: Readonly<Record<string, ConvertCodec>> = {
  A_DTS: "dts",
  A_TRUEHD: "truehd",
  A_OPUS: "opus",
  "A_MPEG/L2": "mpeg",
  "A_MPEG/L3": "mpeg",
};

/** Le démultiplexeur de ffmpeg pour le flux élémentaire d'un codec (l'Opus est enveloppé en Ogg, `ogg.ts`). */
export const FFMPEG_INPUT_FORMAT: Readonly<Record<ConvertCodec, string>> = { dts: "dts", truehd: "truehd", opus: "ogg", mpeg: "mp3", dolby: "eac3" };

/** Ce que l'index garde d'une piste convertible. Sérialisable (clonage structuré, cache disque des index). */
export interface LumenConvertSource {
  codec: ConvertCodec;
  /** Les canaux de la source (le `Channels` du Matroska) : ils choisissent la cible et le repli. */
  channels: number;
  /** La trame de la grille, en échantillons à 48 kHz (TrueHD : 40, mais placé par son compteur). */
  grid: number;
  /** L'instant du premier bloc de la piste (µs) : l'ancre de la grille. */
  firstUs: number;
  /**
   * La position absolue (échantillons à 48 kHz depuis l'instant 0 du fichier) du premier échantillon décodé du
   * premier bloc. Pour l'Opus, moins le `pre-skip` : la norme Matroska dit que `CodecDelay` (le pré-roulement
   * de l'encodeur) se retranche de chaque instant de bloc — ces échantillons tombent avant le son.
   */
  firstSample: number;
  /** TrueHD : le compteur de la première unité d'accès de la piste. */
  timing0: number | null;
  /** Opus : l'en-tête (`CodecPrivate`), recopié dans l'Ogg avec un `pre-skip` nul. */
  opusHead: Uint8Array | null;
  /** Le décodeur de FFmpeg à imposer (`decoderOf`), ou absent : celui du codec. */
  decoder?: string;
  /**
   * Au-delà de cet instant (µs), la piste est certainement finie (dernier bloc + 1 s) : une fenêtre qui commence
   * après n'est faite que de zéros, sans rien lire. Null : la piste va jusqu'au bout de l'image.
   */
  quietFromUs: number | null;
}

/** Une unité que le décodeur reçoit : une trame DTS, MPEG, un paquet Opus, une unité d'accès TrueHD. */
export interface SourceUnit {
  data: Uint8Array;
  /** Échantillons qu'elle rend à 48 kHz. */
  samples: number;
  /** Un décodeur peut-il partir d'elle ? (TrueHD : seulement sur une synchronisation majeure.) */
  sync: boolean;
  /** TrueHD : son compteur `input_timing`. */
  timing?: number;
}

// ── Les unités ───────────────────────────────────────────────────────────────

/** La durée d'un paquet Opus en échantillons à 48 kHz, lue dans son octet TOC (RFC 6716 §3.1), ou null. */
export function opusPacketSamples(packet: Uint8Array): number | null {
  if (packet.length < 1) return null;
  const toc = packet[0];
  const config = toc >> 3;
  // SILK 10/20/40/60 ms ; hybride 10/20 ms ; CELT 2,5/5/10/20 ms — en unités de 2,5 ms (120 échantillons).
  const units = config < 12 ? [4, 8, 16, 24][config & 3] : config < 16 ? [4, 8][config & 1] : [1, 2, 4, 8][config & 3];
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    if (packet.length < 2) return null;
    frames = packet[1] & 0x3f;
    if (frames === 0) return null;
  }
  const samples = units * 120 * frames;
  return samples > 5760 ? null : samples; // 120 ms au plus par paquet
}

/** Échantillons d'une trame DTS, lus dans l'en-tête du cœur (NBLKS), ou null (pas de cœur, en-tête illisible). */
export function dtsFrameSamples(frame: Uint8Array): number | null {
  if (frame.length < 8) return null;
  const sync = ((frame[0] << 24) | (frame[1] << 16) | (frame[2] << 8) | frame[3]) >>> 0;
  if (sync !== 0x7ffe8001) return null; // un DTS-HD sans cœur (sous-flux d'extension seul) n'est pas pris
  // SYNC(32) FTYPE(1) SHORT(5) CPF(1) NBLKS(7) : NBLKS + 1 blocs de 32 échantillons.
  const nblks = ((frame[4] & 0x01) << 6) | (frame[5] >> 2);
  if (nblks < 5) return null; // ETSI TS 102 114 : 5 à 127
  return (nblks + 1) * 32;
}

/** Échantillons d'une trame MPEG audio de couche II ou III, MPEG-1 seulement (48 kHz) : 1 152 ; sinon null. */
export function mpegFrameSamples(frame: Uint8Array): number | null {
  if (frame.length < 4 || frame[0] !== 0xff || (frame[1] & 0xe0) !== 0xe0) return null;
  const version = (frame[1] >> 3) & 3; // 3 = MPEG-1
  const layer = (frame[1] >> 1) & 3; // 2 = couche II, 1 = couche III
  if (version !== 3 || (layer !== 1 && layer !== 2)) return null;
  return 1152;
}

/** L'écart admis entre le compteur TrueHD et l'instant du bloc (échantillons) : un tiers de seconde. */
const TRUEHD_SKEW_LIMIT = 16_000;

const TRUEHD_SYNC = 0xf8726fba;
const MLP_SYNC = 0xf8726fbb;

/** Les unités d'accès TrueHD d'une trame Matroska (une ou plusieurs, collées), ou null si elles ne s'y découpent pas. */
export function truehdUnits(frame: Uint8Array): SourceUnit[] | null {
  const out: SourceUnit[] = [];
  for (let at = 0; at < frame.length; ) {
    if (at + 4 > frame.length) return null;
    const length = (((frame[at] & 0x0f) << 8) | frame[at + 1]) * 2;
    if (length < 4 || at + length > frame.length) return null;
    const sync =
      at + 8 <= frame.length &&
      (((frame[at + 4] << 24) | (frame[at + 5] << 16) | (frame[at + 6] << 8) | frame[at + 7]) >>> 0 === TRUEHD_SYNC ||
        ((frame[at + 4] << 24) | (frame[at + 5] << 16) | (frame[at + 6] << 8) | frame[at + 7]) >>> 0 === MLP_SYNC);
    out.push({ data: frame.subarray(at, at + length), samples: 40, sync, timing: (frame[at + 2] << 8) | frame[at + 3] });
    at += length;
  }
  return out;
}

/** Les unités d'une trame Matroska de la piste, ou null si elle ne se lit pas. */
export function unitsOf(codec: ConvertCodec, frame: Uint8Array): SourceUnit[] | null {
  switch (codec) {
    case "truehd":
      return truehdUnits(frame);
    case "dts": {
      const samples = dtsFrameSamples(frame);
      return samples ? [{ data: frame, samples, sync: true }] : null;
    }
    case "mpeg": {
      const samples = mpegFrameSamples(frame);
      return samples ? [{ data: frame, samples, sync: true }] : null;
    }
    case "opus": {
      const samples = opusPacketSamples(frame);
      return samples ? [{ data: frame, samples, sync: true }] : null;
    }
    case "dolby": {
      // Une trame indépendante et ses dépendantes, comme un bloc Matroska les porte : six blocs de 256 au plus.
      const head = readDolbyHeader(frame);
      return head ? [{ data: frame, samples: head.blocks * 256, sync: true }] : null;
    }
  }
}

// ── Les faits de l'index ─────────────────────────────────────────────────────

/** Le `pre-skip` d'un `OpusHead` (RFC 7845 §5.1), ou null si ce n'en est pas un. */
export function opusPreSkip(head: Uint8Array | null): number | null {
  if (!head || head.length < 19) return null;
  const magic = String.fromCharCode(...head.subarray(0, 8));
  if (magic !== "OpusHead") return null;
  return head[10] | (head[11] << 8);
}

/** Pourquoi une piste n'est pas convertible, ou ses faits. */
export type ConvertVerdict = { ok: true; source: LumenConvertSource } | { ok: false; detail: string };

/**
 * Les faits de conversion d'une piste (à l'index). `firstFrame` : la première trame de son premier bloc ;
 * `lastBlockUs` : son dernier bloc quand elle finit avant l'image, sinon null.
 */
export function convertSourceOf(
  track: { codecId: string; codecPrivate: Uint8Array | null; channels: number; sampleRate: number },
  facts: { firstUs: number | null; firstFrame: Uint8Array | null; lastBlockUs: number | null },
  container: "matroska" | "mp4",
  /** Le banc seul : accepter une piste AC-3/E-AC-3 (voir `ConvertCodec`). */
  options: { bench?: boolean } = {}
): ConvertVerdict {
  const codec: ConvertCodec | undefined = CONVERT_CODECS[track.codecId] ?? (options.bench && (track.codecId === "A_EAC3" || track.codecId === "A_AC3") ? "dolby" : undefined);
  if (!codec) return { ok: false, detail: `codec ${track.codecId}` };
  // Le placement par blocs suppose les Cues et les grappes du Matroska (99,8 % de la bibliothèque) : un MP4 a ses
  // instants exacts mais rien ici ne les lit encore.
  if (container !== "matroska") return { ok: false, detail: "conversion : Matroska seulement" };
  // Toute la bibliothèque à convertir est à 48 kHz (recensement du 17/11/2026) : rien n'est rééchantillonné.
  if (Math.round(track.sampleRate) !== CONVERT_RATE) return { ok: false, detail: `conversion : ${track.sampleRate} Hz (48 kHz seulement)` };
  if (track.channels < 1 || track.channels > 8) return { ok: false, detail: `conversion : ${track.channels} canaux` };
  if (facts.firstUs === null || !facts.firstFrame) return { ok: false, detail: "conversion : premier bloc introuvable" };
  const units = unitsOf(codec, facts.firstFrame);
  if (!units || units.length === 0) return { ok: false, detail: `conversion : première trame ${codec} illisible` };
  let grid: number;
  let preSkip = 0;
  let opusHead: Uint8Array | null = null;
  let timing0: number | null = null;
  switch (codec) {
    case "truehd":
      if (!units[0].sync) return { ok: false, detail: "conversion : TrueHD sans synchronisation majeure en tête" };
      grid = 40;
      timing0 = units[0].timing ?? null;
      break;
    case "opus": {
      const skip = opusPreSkip(track.codecPrivate);
      if (skip === null) return { ok: false, detail: "conversion : OpusHead illisible" };
      preSkip = skip;
      opusHead = track.codecPrivate;
      grid = 120;
      break;
    }
    default:
      grid = units[0].samples;
  }
  const firstSample = Math.round((facts.firstUs * CONVERT_RATE) / 1e6) - preSkip;
  return {
    ok: true,
    source: {
      codec,
      channels: track.channels,
      grid,
      firstUs: facts.firstUs,
      firstSample,
      timing0,
      opusHead,
      quietFromUs: facts.lastBlockUs === null ? null : facts.lastBlockUs + 1_000_000,
      ...(decoderOf(codec, track.codecId) ? { decoder: decoderOf(codec, track.codecId) as string } : {}),
    },
  };
}

// ── Le placement ─────────────────────────────────────────────────────────────

/**
 * La position absolue du premier échantillon d'une unité, dans un bloc daté `timeUs`. `unit` : l'unité elle-même
 * (TrueHD : son compteur), `offset` : les échantillons des unités qui la précèdent dans le même bloc.
 */
export function unitPosition(source: LumenConvertSource, timeUs: number, unit: SourceUnit, offset: number): number {
  const coarse = source.firstSample + ((timeUs - source.firstUs) * CONVERT_RATE) / 1e6 + offset;
  if (source.codec === "truehd" && source.timing0 !== null && unit.timing !== undefined) {
    const modular = (((unit.timing - source.timing0) % 65536) + 65536) % 65536;
    // Le tour du modulo, choisi par l'instant du bloc.
    const turns = Math.round((coarse - source.firstSample - modular) / 65536);
    const delta = modular + 65536 * turns;
    // Le compteur fait foi : il compte les échantillons depuis la première unité, ce que la conception demande
    // (« par leur nombre »). L'instant du bloc peut s'en écarter de dizaines de millisecondes — *Braveheart* : ses
    // 200 premières unités (40 échantillons chacune) sont datées de milliseconde en milliseconde, et toute la
    // suite garde 55 ms d'avance sur le compte —, il ne sert qu'à choisir le tour du modulo. Au-delà d'un tiers de
    // seconde d'écart, le compteur a sauté (un montage) : l'arrondi de l'instant reprend, pour ce bloc seul.
    if (Math.abs(source.firstSample + delta - coarse) <= TRUEHD_SKEW_LIMIT) {
      // Mais le compteur n'avance pas de 40 à chaque unité : relevé sur *Braveheart*, il prend du retard sur les
      // trois unités qui précèdent chaque synchronisation majeure (+29, +27, +28, puis +76 : quatre unités, 160)
      // — c'est l'instant d'**entrée** de l'unité dans l'encodeur, pas celui de son premier échantillon. L'écart
      // est toujours négatif et d'une unité au plus ; aux synchronisations majeures (−33 à −36, comme la toute
      // première unité de la piste, elle aussi une synchronisation), il est le même à 3 échantillons près. Une
      // synchronisation se place donc exactement en arrondissant son écart à la première au multiple de 40 —
      // c'est la seule position qui compte, celle d'où le décodeur part (`planFeed`). Les autres unités gardent
      // le compteur brut : il ne sert qu'à choisir les unités de la fenêtre, et ne s'écarte jamais d'une unité.
      return source.firstSample + (unit.sync ? 40 * Math.round(delta / 40) : delta);
    }
  }
  return source.firstSample + Math.round((coarse - source.firstSample) / source.grid) * source.grid;
}

/** Un bloc de la piste, tel que le fil de calcul le lit : son instant et ses trames (délacées). */
export interface SourceBlock {
  timeUs: number;
  frames: Uint8Array[];
}

/** Ce que ffmpeg reçoit pour une fenêtre : les unités, dans l'ordre, et la position du premier échantillon décodé. */
export interface Feed {
  units: SourceUnit[];
  /** Position absolue du premier échantillon que le décodeur rendra. */
  startSample: number;
  /** Position juste après le dernier échantillon fourni. */
  endSample: number;
}

export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedError";
  }
}

/**
 * Les unités à fournir pour couvrir [start, end) avec le pré-roulement du décodeur : à partir de la dernière unité
 * d'où un décodeur peut partir (TrueHD : une synchronisation majeure) placée au plus à `start − DECODER_PREROLL`,
 * ou de la toute première de la piste ; jusqu'à la dernière qui commence avant `end`. Null : aucune unité dans la
 * fenêtre (elle est dans le silence). Lève si les blocs lus ne remontent pas assez loin (la lecture doit partir
 * plus tôt) ou si une trame ne se lit pas.
 */
export function planFeed(source: LumenConvertSource, blocks: readonly SourceBlock[], start: number, end: number): Feed | null {
  const placed: { unit: SourceUnit; at: number }[] = [];
  for (const block of blocks) {
    let offset = 0;
    for (const frame of block.frames) {
      const units = unitsOf(source.codec, frame);
      if (!units) throw new FeedError(`trame ${source.codec} illisible à ${block.timeUs} µs`);
      for (const unit of units) {
        placed.push({ unit, at: unitPosition(source, block.timeUs, unit, offset) });
        offset += unit.samples;
      }
    }
  }
  placed.sort((x, y) => x.at - y.at);
  const wanted = start - decoderPrerollOf(source.codec);
  let from = -1;
  for (let i = 0; i < placed.length && placed[i].at <= wanted; i++) if (placed[i].unit.sync) from = i;
  if (from < 0) {
    // Pas d'unité assez tôt : seulement admis si la première lue est celle qui ouvre la piste.
    const first = placed.findIndex((p) => p.unit.sync);
    if (first < 0 || placed.length === 0) return null;
    if (placed[first].at !== source.firstSample) {
      if (placed[first].at >= end) return null;
      throw new FeedError(`lecture trop courte : première unité à ${placed[first].at}, voulue avant ${wanted}`);
    }
    from = first;
  }
  const units: SourceUnit[] = [];
  let expected = placed[from].at;
  for (let i = from; i < placed.length && placed[i].at < end; i++) {
    // Deux unités au même instant (un doublon du multiplexeur) : la seconde est écartée ; un trou ou un
    // chevauchement ailleurs se décode tel quel, comme dans le décodage continu qui sert de référence.
    if (i > from && placed[i].at === placed[i - 1].at) continue;
    units.push(placed[i].unit);
    expected = placed[i].at + placed[i].unit.samples;
  }
  // Aucune unité, ou toutes finies avant la fenêtre (la piste s'est arrêtée) : la fenêtre est dans le silence.
  if (units.length === 0 || expected <= start) return null;
  return { units, startSample: placed[from].at, endSample: expected };
}

/** Les octets d'un flux élémentaire : les unités bout à bout (DTS, TrueHD, MPEG). */
export function concatUnits(units: readonly SourceUnit[]): Uint8Array {
  const total = units.reduce((n, u) => n + u.data.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const u of units) {
    out.set(u.data, at);
    at += u.data.length;
  }
  return out;
}
