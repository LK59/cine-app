/**
 * Ce que dit la configuration d'une piste AAC (AudioSpecificConfig, ISO 14496-3 §1.6.2.1), et ce
 * qu'il faut en faire pour qu'un navigateur la joue avec tous ses canaux — DECISIONS.md §62.
 *
 * Né de « Elle s'appelle Ruby » sur une Fire TV (10/10/2026) : ses deux pistes AAC-LC 6 canaux
 * portent une `channelConfiguration` à 0, la disposition étant décrite par un élément PCE (Program
 * Config Element). Chromium répond oui à `isTypeSupported('audio/mp4; codecs="mp4a.40.2"')`, puis
 * refuse le segment d'initialisation : la MediaSource passe à `ended`, sans un son.
 *
 * Quatre couches, une seule décision (`aacPlan`) :
 * 1. le PCE relu entièrement, élément par élément, dans l'ordre du flux (`parseAacConfig`) ;
 * 2. un PCE qui décrit exactement une configuration standard, dans l'ordre de ses éléments, est
 *    réécrit en cette configuration et la piste copiée sans perte (`rewriteToStandard`) ;
 * 3. sinon la piste est décodée, et ses canaux rangés dans une disposition standard — tous, par une
 *    matrice qui place chacun là où il doit aller (`standardMatrix`) — quand l'ordre de sortie du
 *    décodeur pour ce PCE a été **mesuré** (`MEASURED_DECODED_ORDERS`) ; sinon L R C, la règle de
 *    toute disposition inconnue (CLAUDE.md : mesurer, jamais raisonner sur l'ordre d'un autre) ;
 * 4. un navigateur qui accepte un PCE tel quel dans MediaSource — demandé une fois, par un vrai
 *    envoi (`aacPceProbe.ts`) — reçoit la piste copiée, tous canaux, sans rien toucher.
 *
 * Ce que la mesure a appris (10/10/2026), et qui décide de « Ruby » : son PCE — avant [paire,
 * mono], côté [mono], arrière [paire], aucun caisson — est **octet pour octet** celui que l'encodeur
 * AAC de FFmpeg écrit pour un 5.1 ordinaire quand il passe par un PCE (`-aac_pce 1`, comparé
 * à 48 kHz : `11 80 04 c8 44 00 20 00 c4 0d "Lavc62…" 56 e5 00`). Le « mono de côté » y porte le
 * caisson : sur tout le film, le canal 4 de Ruby est entièrement sous 200 Hz (−77,5 dB brut,
 * −110 dB passé un passe-haut à 200 Hz, 20:00–30:00), les canaux 5 et 6 couvrent toute la bande. Et
 * les décodeurs le rendent bien comme un 5.1 : FFmpeg, l'AudioDecoder de Chromium, de Firefox et de
 * WebKitGTK sortent L R C LFE Ls Rs — mêmes niveaux par canal sur les vraies trames de Ruby, et des
 * tonalités marquées par canal ressortent au même rang qu'un 5.1 standard. Ruby se livre donc en
 * 5.1 entier, pas en 3.0.
 */

import { isWebKitEngine } from "@/lib/webkitEngine";
import { isChromiumEngine } from "./bufferBudget";

/** Un élément du PCE, dans l'ordre du flux : son rang, sa nature (mono ou paire), son étiquette. */
export interface PceElement {
  group: "front" | "side" | "back" | "lfe";
  /** SCE : un canal ; CPE : une paire ; LFE : le caisson. */
  kind: "SCE" | "CPE" | "LFE";
  tag: number;
}

/** La disposition décrite par un PCE : les éléments de chaque rang, et le total de canaux. */
export interface AacPce {
  /** Pour chaque élément avant, `true` s'il est stéréo (CPE), `false` s'il est mono (SCE). */
  front: boolean[];
  side: boolean[];
  back: boolean[];
  lfe: number;
  channels: number;
  /** Tous les éléments, dans l'ordre du flux : avant, côté, arrière, caissons. */
  elements: PceElement[];
}

export interface AacConfig {
  objectType: number;
  frequencyIndex: number;
  channelConfiguration: number;
  pce: AacPce | null;
}

/** Où commence et finit chaque partie, en bits depuis le début de la configuration. */
interface AacLayout {
  /** Après l'en-tête et la GASpecificConfig, à l'endroit où commence le PCE. */
  pceStart: number;
  /** Après le PCE et son commentaire — aligné sur un octet par construction. */
  pceEnd: number;
  /** Les trois indicateurs de la GASpecificConfig (longueur de trame, codeur central, extension). */
  frameLengthFlag: number;
  dependsOnCoreCoder: number;
  coreCoderDelay: number;
  extensionFlag: number;
}

class Bits {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.pos >> 3];
      if (byte === undefined) throw new RangeError("configuration AAC tronquée");
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
}

class BitWriter {
  private readonly bits: number[] = [];
  put(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  bytes(): Uint8Array {
    const bits = [...this.bits];
    while (bits.length % 8) bits.push(0);
    return Uint8Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((v, b) => (v << 1) | b, 0));
  }
}

/** Les profils dont la GASpecificConfig précède le PCE — tous ceux d'une bibliothèque de films. */
const GA_OBJECT_TYPES = new Set([1, 2, 3, 4, 6, 7]);

function parse(asc: Uint8Array): { config: AacConfig; layout: AacLayout | null } {
  const b = new Bits(asc);
  let objectType = b.read(5);
  if (objectType === 31) objectType = 32 + b.read(6);
  const frequencyIndex = b.read(4);
  if (frequencyIndex === 15) b.read(24);
  const channelConfiguration = b.read(4);
  if (channelConfiguration !== 0 || !GA_OBJECT_TYPES.has(objectType)) {
    return { config: { objectType, frequencyIndex, channelConfiguration, pce: null }, layout: null };
  }
  // GASpecificConfig : frameLengthFlag, dependsOnCoreCoder (et son délai), extensionFlag — puis le
  // PCE, quand la configuration vaut 0 (ISO 14496-3 §4.4.1).
  const frameLengthFlag = b.read(1);
  const dependsOnCoreCoder = b.read(1);
  const coreCoderDelay = dependsOnCoreCoder ? b.read(14) : 0;
  const extensionFlag = b.read(1);
  const pceStart = b.pos;
  b.read(4); // element_instance_tag
  b.read(2); // object_type
  b.read(4); // sampling_frequency_index
  const nFront = b.read(4);
  const nSide = b.read(4);
  const nBack = b.read(4);
  const nLfe = b.read(2);
  const nAssoc = b.read(3);
  const nCc = b.read(4);
  if (b.read(1)) b.read(4); // mono_mixdown
  if (b.read(1)) b.read(4); // stereo_mixdown
  if (b.read(1)) b.read(3); // matrix_mixdown
  const elements: PceElement[] = [];
  const group = (n: number, name: "front" | "side" | "back") => {
    const list: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const cpe = b.read(1) === 1;
      elements.push({ group: name, kind: cpe ? "CPE" : "SCE", tag: b.read(4) });
      list.push(cpe);
    }
    return list;
  };
  const front = group(nFront, "front");
  const side = group(nSide, "side");
  const back = group(nBack, "back");
  for (let i = 0; i < nLfe; i++) elements.push({ group: "lfe", kind: "LFE", tag: b.read(4) });
  for (let i = 0; i < nAssoc; i++) b.read(4);
  for (let i = 0; i < nCc; i++) b.read(5);
  // byte_alignment() — compté depuis le début de l'AudioSpecificConfig, comme le fait FFmpeg — puis
  // le commentaire : la fin du PCE tombe donc sur un octet.
  b.read((8 - (b.pos % 8)) % 8);
  const commentBytes = b.read(8);
  for (let i = 0; i < commentBytes; i++) b.read(8);
  const count = (list: boolean[]) => list.reduce((n, cpe) => n + (cpe ? 2 : 1), 0);
  const channels = count(front) + count(side) + count(back) + nLfe;
  return {
    config: { objectType, frequencyIndex, channelConfiguration, pce: { front, side, back, lfe: nLfe, channels, elements } },
    layout: { pceStart, pceEnd: b.pos, frameLengthFlag, dependsOnCoreCoder, coreCoderDelay, extensionFlag },
  };
}

/** La configuration relue, ou `null` si les octets n'en sont pas une. */
export function parseAacConfig(asc: Uint8Array | null | undefined): AacConfig | null {
  if (!asc || asc.length < 2) return null;
  try {
    return parse(asc).config;
  } catch {
    return null;
  }
}

/**
 * Les éléments de chaque configuration standard, dans l'ordre où le flux les porte (ISO 14496-3,
 * tableau 1.19) — et les rangs que chacun peut occuper dans un PCE qui la décrirait.
 */
const STANDARD_ELEMENTS: Record<number, { kind: PceElement["kind"]; groups: PceElement["group"][] }[]> = {
  1: [{ kind: "SCE", groups: ["front"] }],
  2: [{ kind: "CPE", groups: ["front"] }],
  3: [
    { kind: "SCE", groups: ["front"] },
    { kind: "CPE", groups: ["front"] },
  ],
  4: [
    { kind: "SCE", groups: ["front"] },
    { kind: "CPE", groups: ["front"] },
    { kind: "SCE", groups: ["side", "back"] },
  ],
  5: [
    { kind: "SCE", groups: ["front"] },
    { kind: "CPE", groups: ["front"] },
    { kind: "CPE", groups: ["side", "back"] },
  ],
  6: [
    { kind: "SCE", groups: ["front"] },
    { kind: "CPE", groups: ["front"] },
    { kind: "CPE", groups: ["side", "back"] },
    { kind: "LFE", groups: ["lfe"] },
  ],
  7: [
    { kind: "SCE", groups: ["front"] },
    { kind: "CPE", groups: ["front"] },
    { kind: "CPE", groups: ["front"] },
    { kind: "CPE", groups: ["side", "back"] },
    { kind: "LFE", groups: ["lfe"] },
  ],
};

/**
 * La configuration standard que ce PCE décrit **exactement**, ou `null`.
 *
 * Trois conditions, et aucune n'est négociable : les mêmes éléments, dans le même ordre que la
 * configuration (les trames portent leurs éléments dans l'ordre du PCE — réécrire un PCE dont
 * l'ordre diffère ferait lire au décodeur la paire avant comme un centre) ; chacun à un rang que la
 * configuration lui permet ; et des étiquettes numérotées à partir de zéro par nature, dans l'ordre,
 * comme les écrit tout encodeur en configuration implicite — un décodeur strict associe un élément
 * à sa place par son étiquette.
 */
export function standardConfigOf(pce: AacPce): number | null {
  for (const [config, expected] of Object.entries(STANDARD_ELEMENTS)) {
    if (expected.length !== pce.elements.length) continue;
    const next: Record<string, number> = { SCE: 0, CPE: 0, LFE: 0 };
    const matches = expected.every((slot, i) => {
      const element = pce.elements[i];
      const ok = element.kind === slot.kind && slot.groups.includes(element.group) && element.tag === next[element.kind];
      next[element.kind]++;
      return ok;
    });
    if (matches) return Number(config);
  }
  return null;
}

/**
 * La même configuration, son PCE remplacé par `channelConfiguration` — ou `null` si elle ne s'y prête
 * pas (voir `standardConfigOf`).
 *
 * Seule la disposition change : profil, fréquence, indicateurs de la GASpecificConfig et tout ce qui
 * suit le PCE (l'extension de synchronisation 0x2b7 que FFmpeg ajoute, par exemple) sont recopiés
 * bit pour bit. Les trames, elles, ne changent pas : leur syntaxe est la même que la disposition
 * vienne d'un PCE ou de la configuration — c'est ce qui rend la copie sans perte.
 */
export function rewriteToStandard(asc: Uint8Array): Uint8Array | null {
  let parsed;
  try {
    parsed = parse(asc);
  } catch {
    return null;
  }
  const { config, layout } = parsed;
  if (!config.pce || !layout) return null;
  const standard = standardConfigOf(config.pce);
  if (standard === null) return null;
  const w = new BitWriter();
  if (config.objectType >= 32) {
    w.put(31, 5);
    w.put(config.objectType - 32, 6);
  } else {
    w.put(config.objectType, 5);
  }
  w.put(config.frequencyIndex, 4);
  if (config.frequencyIndex === 15) {
    // La fréquence explicite (24 bits) est relue telle quelle de l'original.
    const b = new Bits(asc);
    b.read(config.objectType >= 32 ? 11 : 5);
    b.read(4);
    w.put(b.read(24), 24);
  }
  w.put(standard, 4);
  w.put(layout.frameLengthFlag, 1);
  w.put(layout.dependsOnCoreCoder, 1);
  if (layout.dependsOnCoreCoder) w.put(layout.coreCoderDelay, 14);
  w.put(layout.extensionFlag, 1);
  // Ce qui suit le PCE, bit pour bit : la fin du PCE est alignée sur un octet (son commentaire),
  // et la suite se lit à partir de là.
  const tail = new Bits(asc);
  tail.pos = layout.pceEnd;
  const remaining = asc.length * 8 - layout.pceEnd;
  for (let i = 0; i < remaining; i++) w.put(tail.read(1), 1);
  return w.bytes();
}

/** Les rangs d'enceinte qu'un décodé peut porter. */
export type Speaker = "L" | "R" | "C" | "LFE" | "Ls" | "Rs" | "Lrs" | "Rrs" | "Cs" | "Lw" | "Rw";

/** L'ordre standard des dispositions connues : L R C LFE Ls Rs Lrs Rrs (voir `fold`, audioTranscode.ts). */
const STANDARD_ORDER: Speaker[] = ["L", "R", "C", "LFE", "Ls", "Rs", "Lrs", "Rrs"];

/** La forme d'un PCE, écrite pour servir de clé : rangs, natures et nombre de caissons. */
export function pceShape(pce: AacPce): string {
  const shape = (list: boolean[]) => list.map((cpe) => (cpe ? "P" : "M")).join("") || "-";
  return `${shape(pce.front)}/${shape(pce.side)}/${shape(pce.back)}/${pce.lfe}`;
}

/**
 * L'ordre dans lequel les décodeurs des navigateurs rendent un PCE donné — **mesuré**, jamais
 * déduit. Une forme absente d'ici n'est pas devinée : elle sort en L R C (voir `aacPlan`).
 *
 * « PM/M/P/0 » : avant [paire, mono], côté [mono], arrière [paire], sans caisson — la forme que
 * l'encodeur AAC de FFmpeg écrit pour un 5.1 passé par un PCE, celle de « Ruby ». Mesurée le
 * 10/10/2026 sur les vraies trames de Ruby (20 s à 20:00) par l'AudioDecoder de Chromium, de
 * Firefox et de WebKitGTK : −68,0 / −56,7 / −38,6 / −128,4 / −63,2 / −65,4 dB, le dialogue au
 * troisième rang, le caisson au quatrième ; et par des tonalités marquées par canal (FFmpeg,
 * `-aac_pce 1` contre un 5.1 standard) : rangs identiques. Les navigateurs d'Apple n'ont pas été
 * mesurés : Safari décode par AudioToolbox, dont l'ordre pour ce PCE reste inconnu — d'où la
 * question posée à part (`aacPceProbe.ts`), qui le fait copier plutôt que décoder s'il l'accepte.
 */
export const MEASURED_DECODED_ORDERS: Record<string, Speaker[]> = {
  "PM/M/P/0": ["L", "R", "C", "LFE", "Ls", "Rs"],
};

/** Le coefficient de demi-puissance (ITU-R BS.775), écrit exactement — voir `HALF_POWER`, audioTranscode.ts. */
const HALF = Math.SQRT1_2;

/**
 * La matrice qui range des canaux décodés dans la disposition standard la plus proche, chaque canal
 * là où il doit aller : `rows[sortie][entrée]`, gains ITU-R BS.775.
 *
 * Cible : 5.1 dès qu'il y a de l'ambiance ou un caisson (L R C LFE Ls Rs), 3.0 sinon (L R C), 2.0
 * pour une simple paire, 1.0 pour un mono. Un canal sans place à lui est réparti : un centre arrière
 * (Cs) va dans les deux ambiances à −3 dB, une paire arrière se replie dans les ambiances à −3 dB
 * chacune (comme le repli 7.1 → 5.1 du transcodeur), des avant larges (Lw/Rw) dans L et R à −3 dB.
 * Un 5.1 ou un 7.1 déjà dans l'ordre standard ressort tel quel (`identity`).
 */
export function standardMatrix(speakers: Speaker[]): { channels: number; rows: number[][]; identity: boolean } {
  const has = (s: Speaker) => speakers.includes(s);
  const surround = has("Ls") || has("Rs") || has("Lrs") || has("Rrs") || has("Cs") || has("LFE");
  // Déjà dans l'ordre standard d'une disposition connue (1, 2, 3, 6, 8 canaux) : rien à changer.
  for (const count of [8, 6, 3, 2]) {
    if (speakers.length === count && speakers.every((s, i) => s === STANDARD_ORDER[i])) {
      return { channels: count, rows: [], identity: true };
    }
  }
  if (speakers.length === 1) return { channels: 1, rows: [], identity: true };
  const target: Speaker[] = surround ? ["L", "R", "C", "LFE", "Ls", "Rs"] : has("C") ? ["L", "R", "C"] : ["L", "R"];
  const rows = target.map(() => speakers.map(() => 0));
  const add = (out: Speaker, input: number, gain: number) => {
    const row = target.indexOf(out);
    if (row >= 0) rows[row][input] += gain;
  };
  speakers.forEach((speaker, i) => {
    switch (speaker) {
      case "L":
      case "R":
      case "C":
      case "LFE":
        if (target.includes(speaker)) add(speaker, i, 1);
        else if (speaker === "C") {
          add("L", i, HALF);
          add("R", i, HALF);
        }
        break;
      case "Ls":
      case "Rs":
        add(speaker, i, has("Lrs") || has("Rrs") || has("Cs") ? HALF : 1);
        break;
      case "Lrs":
        add("Ls", i, has("Ls") ? HALF : 1);
        break;
      case "Rrs":
        add("Rs", i, has("Rs") ? HALF : 1);
        break;
      case "Cs":
        add("Ls", i, HALF);
        add("Rs", i, HALF);
        break;
      case "Lw":
        add("L", i, HALF);
        break;
      case "Rw":
        add("R", i, HALF);
        break;
    }
  });
  return { channels: target.length, rows, identity: false };
}

/** Applique `standardMatrix` à des plans décodés — en double précision, rangée en simple. */
export function remapPlanes(planes: Float32Array[], rows: number[][]): Float32Array[] {
  const frames = planes[0]?.length ?? 0;
  return rows.map((row) => {
    const out = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let c = 0; c < row.length; c++) if (row[c] && planes[c]) sum += planes[c][f] * row[c];
      out[f] = sum;
    }
    return out;
  });
}

/**
 * Ce qu'il faut faire d'une piste AAC pour la livrer avec tous ses canaux — la seule décision, que
 * le remultiplexeur, le transcodeur, le décodeur logiciel et le classement des pistes lisent tous.
 *
 * - `copy` : configuration standard (presque toute la bibliothèque), illisible (le comportement
 *   d'avant : rien ne permet de refuser), ou PCE qu'un navigateur a prouvé accepter (`pceAccepted`).
 * - `rewrite` : PCE équivalent à une configuration standard — copiée sans perte avec `asc` réécrite.
 * - `decode` : décodée par le navigateur et ré-encodée ; `channels` est ce qui est livré, dans
 *   l'ordre standard, et `rows` la matrice à appliquer au décodé (absente : à prendre tel quel, ou
 *   — `keep` — n'en garder que les premiers canaux).
 */
export type AacPlan =
  | { action: "copy" }
  | { action: "rewrite"; asc: Uint8Array; channels: number }
  | { action: "decode"; channels: number; rows: number[][] | null; keep: number | null; measured: boolean };

/**
 * Le décodeur AAC de ce navigateur est-il de ceux dont l'ordre de sortie a été mesuré ? Non sur un
 * système Apple avec WebKit (Safari, tout navigateur iOS) : il décode par AudioToolbox, jamais
 * mesuré pour un PCE. Chromium — Chrome sur Mac compris — et Firefox décodent l'AAC par FFmpeg,
 * mesuré (voir `MEASURED_DECODED_ORDERS`).
 */
//
// Oui partout depuis le 11/10/2026 : un AAC à PCE n'est plus jamais décodé par AudioToolbox. Hors
// Chromium, il passe par le décodeur AAC de FFmpeg compilé en WebAssembly (aac/aacWasmAudio.ts) —
// celui dont l'ordre a été mesuré — parce que l'AudioDecoder de Safari échouait sur le PCE de
// « Ruby » (« InternalAudioDecoderCocoa decoding failed »). Chromium décode par FFmpeg, mesuré.
export function decodedOrderMeasuredHere(): boolean {
  return aacDecoderRouteHere() === "wasm" || !appleWebKit();
}

function appleWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const agent = navigator.userAgent ?? "";
  const apple = /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(agent) && !/Android/.test(agent);
  return apple && isWebKitEngine(agent);
}

/**
 * Quel décodeur décode un AAC à PCE ici : celui du navigateur sur Chromium (Chrome, Edge, Silk) —
 * prouvé et mesuré —, celui de FFmpeg en WebAssembly partout ailleurs (DECISIONS.md §62).
 */
export function aacDecoderRouteHere(): "wasm" | "browser" {
  if (typeof navigator === "undefined") return "wasm";
  return isChromiumEngine(navigator.userAgent ?? "") ? "browser" : "wasm";
}

export function aacPlan(
  asc: Uint8Array | null | undefined,
  options: { pceAccepted?: boolean | null; orderMeasured?: boolean } = {}
): AacPlan {
  const config = parseAacConfig(asc);
  if (!config?.pce || !asc) return { action: "copy" };
  const pce = config.pce;
  // Le navigateur le prend tel quel (prouvé, ou présumé hors Chromium — `effectivePceAnswer`) :
  // copié comme avant le 10/10/2026, tous les canaux, sans rien réécrire.
  if (options.pceAccepted === true) return { action: "copy" };
  const rewritten = rewriteToStandard(asc);
  if (rewritten) return { action: "rewrite", asc: rewritten, channels: pce.channels };
  const order = MEASURED_DECODED_ORDERS[pceShape(pce)];
  if (order && order.length === pce.channels && (options.orderMeasured ?? decodedOrderMeasuredHere())) {
    const matrix = standardMatrix(order);
    return { action: "decode", channels: matrix.channels, rows: matrix.identity ? null : matrix.rows, keep: null, measured: true };
  }
  // Ordre de sortie jamais mesuré pour cette forme : ses trois premiers canaux, L R C, les seuls
  // rangs sur lesquels toutes les dispositions s'accordent (voir `frontOnly`, audioTranscode.ts).
  const keep = Math.min(3, pce.channels);
  return { action: "decode", channels: keep, rows: null, keep, measured: false };
}
