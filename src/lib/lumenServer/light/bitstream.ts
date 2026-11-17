// Les octets de la version allégée (`light/`), sans état et sans processus : ce que l'encodeur rend (un flux HEVC
// Annex B, sans horodatage), ce qu'il faut en tirer pour l'init (`hvcC` depuis ses jeux de paramètres), et ce que la
// vidéo d'origine dit des instants d'un segment (ses `moof`). Fonctions pures, testées par
// `lumenServer-light.test.ts` ; le banc `lumen-light-bench.spec.ts` les passe sur un vrai encodage.

import { unescapeRbsp } from "../../webcodecs/codecConfig";

/** Les types NAL HEVC que ce fichier nomme (ITU-T H.265 tableau 7-1). */
export const HEVC_NAL = { IDR_W_RADL: 19, IDR_N_LP: 20, CRA: 21, VPS: 32, SPS: 33, PPS: 34, AUD: 35, EOS: 36, EOB: 37, FD: 38, PREFIX_SEI: 39, SUFFIX_SEI: 40 } as const;

const nalType = (unit: Uint8Array) => (unit[0] >> 1) & 0x3f;

/** Les unités NAL d'un flux Annex B (codes de départ de 3 ou 4 octets), sans leur code de départ. */
export function annexBUnits(stream: Uint8Array): Uint8Array[] {
  const starts: { at: number; code: number }[] = [];
  for (let i = 0; i + 2 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) {
      const four = i > 0 && stream[i - 1] === 0;
      starts.push({ at: i + 3, code: four ? 4 : 3 });
      i += 2;
    }
  }
  const units: Uint8Array[] = [];
  starts.forEach((s, k) => {
    // La fin : le code suivant (et le zéro de tête d'un code à 4 octets, qui n'appartient pas à l'unité d'avant).
    const end = k + 1 < starts.length ? starts[k + 1].at - starts[k + 1].code : stream.length;
    let to = end;
    while (to > s.at && stream[to - 1] === 0 && k + 1 === starts.length) to -= 1; // zéros de fin de flux
    if (to > s.at) units.push(stream.subarray(s.at, to));
  });
  return units;
}

/**
 * Les images d'un flux HEVC : une image commence à la première tranche dont `first_slice_segment_in_pic_flag` vaut 1,
 * avec les unités non VCL qui la précèdent (jeux de paramètres, SEI préfixes, AUD). Les SEI suffixes restent avec
 * l'image d'avant. Rend chaque image en unités, AUD retirées (un `trun` n'en veut pas, et Safari s'en passe).
 */
export function hevcPictures(units: readonly Uint8Array[]): Uint8Array[][] {
  const pictures: Uint8Array[][] = [];
  let pending: Uint8Array[] = [];
  let current: Uint8Array[] | null = null;
  for (const unit of units) {
    if (unit.length < 3) continue;
    const type = nalType(unit);
    if (type === HEVC_NAL.AUD || type === HEVC_NAL.EOS || type === HEVC_NAL.EOB || type === HEVC_NAL.FD) continue;
    if (type < 32) {
      const firstSlice = (unit[2] & 0x80) !== 0;
      if (firstSlice || !current) {
        current = [...pending, unit];
        pending = [];
        pictures.push(current);
      } else current.push(unit);
      continue;
    }
    if (type === HEVC_NAL.SUFFIX_SEI && current && pending.length === 0) {
      current.push(unit);
      continue;
    }
    pending.push(unit);
  }
  return pictures;
}

/** Une image en échantillon MP4 : chaque unité préfixée de sa longueur sur 4 octets. */
export function lengthPrefixed(units: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(units.reduce((n, u) => n + 4 + u.length, 0));
  let at = 0;
  for (const u of units) {
    out[at] = (u.length >>> 24) & 0xff;
    out[at + 1] = (u.length >>> 16) & 0xff;
    out[at + 2] = (u.length >>> 8) & 0xff;
    out[at + 3] = u.length & 0xff;
    out.set(u, at + 4);
    at += 4 + u.length;
  }
  return out;
}

/** L'image est-elle une IDR (19, 20) ? Sa première tranche le dit. */
export function isIdrPicture(units: readonly Uint8Array[]): boolean {
  const slice = units.find((u) => nalType(u) < 32);
  return !!slice && (nalType(slice) === HEVC_NAL.IDR_W_RADL || nalType(slice) === HEVC_NAL.IDR_N_LP);
}

class Bits {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.at >> 3];
      if (byte === undefined) throw new Error("SPS tronqué");
      v = v * 2 + ((byte >> (7 - (this.at & 7))) & 1);
      this.at += 1;
    }
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      if (++zeros > 31) throw new Error("SPS illisible");
    }
    return zeros === 0 ? 0 : 2 ** zeros - 1 + this.u(zeros);
  }
  get position(): number {
    return this.at;
  }
}

export interface HevcSpsFacts {
  /** Les 12 octets du `profile_tier_level` général, tels quels : ce que l'en-tête `hvcC` recopie. */
  generalPtl: Uint8Array;
  maxSubLayersMinus1: number;
  temporalIdNesting: boolean;
  chromaFormatIdc: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  /** La taille codée moins la fenêtre de conformité (les pixels montrés), en échantillons de luminance. */
  width: number;
  height: number;
}

/** Ce qu'un SPS HEVC dit pour un `hvcC` (ITU-T H.265 §7.3.2.2). `sps` : l'unité NAL entière, en-tête compris. */
export function readHevcSps(sps: Uint8Array): HevcSpsFacts {
  const rbsp = unescapeRbsp(sps.subarray(2));
  const r = new Bits(rbsp);
  r.u(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.u(3);
  const temporalIdNesting = r.u(1) === 1;
  const generalPtl = rbsp.slice(1, 13);
  for (let i = 0; i < 12 * 8; i++) r.u(1);
  const subProfile: boolean[] = [];
  const subLevel: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subProfile.push(r.u(1) === 1);
    subLevel.push(r.u(1) === 1);
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.u(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfile[i]) r.u(88);
    if (subLevel[i]) r.u(8);
  }
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormatIdc = r.ue();
  if (chromaFormatIdc === 3) r.u(1);
  let width = r.ue();
  let height = r.ue();
  if (r.u(1) === 1) {
    // La fenêtre de conformité, en unités de chrominance (×2 en 4:2:0 dans les deux sens, ×2 en largeur seule en 4:2:2).
    const subW = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
    const subH = chromaFormatIdc === 1 ? 2 : 1;
    const left = r.ue();
    const right = r.ue();
    const top = r.ue();
    const bottom = r.ue();
    width -= subW * (left + right);
    height -= subH * (top + bottom);
  }
  const bitDepthLuma = r.ue() + 8;
  const bitDepthChroma = r.ue() + 8;
  return { generalPtl, maxSubLayersMinus1, temporalIdNesting, chromaFormatIdc, bitDepthLuma, bitDepthChroma, width, height };
}

/**
 * Un `hvcC` complet (ISO/IEC 14496-15 §8.3.3.1) depuis les jeux de paramètres d'un flux : l'en-tête tiré du SPS
 * (profil, palier, niveau, contraintes recopiés octet pour octet ; format de chrominance et profondeurs), des
 * longueurs NAL sur 4 octets, puis un tableau par type (VPS, SPS, PPS), marqués complets. Une entrée `hvc1` le
 * demande : les paramètres doivent être dans l'en-tête — et le flux livré les répète en bande à chaque IDR.
 */
export function hvcCFromParameterSets(vps: Uint8Array, sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const f = readHevcSps(sps);
  const header = new Uint8Array(23);
  header[0] = 1;
  header.set(f.generalPtl, 1); // octets 1 à 12 : espace/palier/profil, compatibilités, contraintes, niveau
  header[13] = 0xf0;
  header[14] = 0x00; // min_spatial_segmentation_idc = 0
  header[15] = 0xfc; // parallelismType = 0
  header[16] = 0xfc | (f.chromaFormatIdc & 3);
  header[17] = 0xf8 | ((f.bitDepthLuma - 8) & 7);
  header[18] = 0xf8 | ((f.bitDepthChroma - 8) & 7);
  header[19] = 0;
  header[20] = 0; // avgFrameRate inconnu
  header[21] = (((f.maxSubLayersMinus1 + 1) & 7) << 3) | ((f.temporalIdNesting ? 1 : 0) << 2) | 3;
  const arrays: number[] = [];
  for (const unit of [vps, sps, pps]) arrays.push(0x80 | nalType(unit), 0, 1, unit.length >> 8, unit.length & 0xff, ...unit);
  const out = new Uint8Array(23 + arrays.length);
  out.set(header);
  out[22] = 3;
  out.set(arrays, 23);
  return out;
}

/** Les jeux de paramètres d'une image (la première d'un flux), ou null s'il en manque un. */
export function parameterSetsOf(picture: readonly Uint8Array[]): { vps: Uint8Array; sps: Uint8Array; pps: Uint8Array } | null {
  const find = (type: number) => picture.find((u) => nalType(u) === type);
  const vps = find(HEVC_NAL.VPS);
  const sps = find(HEVC_NAL.SPS);
  const pps = find(HEVC_NAL.PPS);
  return vps && sps && pps ? { vps, sps, pps } : null;
}

// ── Les instants d'un segment de la vidéo d'origine ─────────────────────────

export interface OriginTimes {
  /** Les instants de présentation de ses images (temps du conteneur, µs), triés, sans doublon. */
  presentations: number[];
  /** Où son décodage finit : le début du segment suivant (`tfdt` de celui-ci), ou la fin du film. */
  endDecode: number;
  /** Où son décodage commence (`tfdt` de son premier fragment). */
  startDecode: number;
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
}

function boxesIn(b: Uint8Array, from: number, to: number): { type: string; start: number; end: number; body: number }[] {
  const out: { type: string; start: number; end: number; body: number }[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32(b, at);
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
    let body = at + 8;
    if (size === 1) {
      size = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12);
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < 8 || at + size > to) throw new Error(`Boîte ${type} mal formée à ${at}.`);
    out.push({ type, start: at, end: at + size, body });
    at += size;
  }
  return out;
}

/**
 * Ce que les `moof` d'un segment vidéo de Lumen serveur disent de ses images (une piste, `tfdt`, `trun` en version 0
 * ou 1) : les instants de présentation (décodage + décalage de composition) et la fin de son décodage. La version
 * allégée en tire les siens : les mêmes images, aux mêmes instants, et la même jointure avec le segment suivant.
 */
export function originTimes(segment: Uint8Array): OriginTimes {
  const presentations: number[] = [];
  let startDecode: number | null = null;
  let endDecode = 0;
  for (const top of boxesIn(segment, 0, segment.length)) {
    if (top.type !== "moof") continue;
    for (const traf of boxesIn(segment, top.body, top.end).filter((b) => b.type === "traf")) {
      const inner = boxesIn(segment, traf.body, traf.end);
      const tfhd = inner.find((b) => b.type === "tfhd");
      const tfdt = inner.find((b) => b.type === "tfdt");
      if (!tfhd || !tfdt) throw new Error("Fragment sans tfhd ni tfdt.");
      const tfhdFlags = u32(segment, tfhd.body) & 0xffffff;
      let at = tfhd.body + 8;
      if (tfhdFlags & 0x1) at += 8;
      if (tfhdFlags & 0x2) at += 4;
      const defaultDuration = tfhdFlags & 0x8 ? u32(segment, at) : 0;
      const tfdtVersion = segment[tfdt.body];
      let decode = tfdtVersion === 1 ? u32(segment, tfdt.body + 4) * 2 ** 32 + u32(segment, tfdt.body + 8) : u32(segment, tfdt.body + 4);
      startDecode ??= decode;
      for (const trun of inner.filter((b) => b.type === "trun")) {
        const version = segment[trun.body];
        const flags = u32(segment, trun.body) & 0xffffff;
        const count = u32(segment, trun.body + 4);
        let p = trun.body + 8;
        if (flags & 0x1) p += 4;
        if (flags & 0x4) p += 4;
        for (let i = 0; i < count; i++) {
          let duration = defaultDuration;
          let cts = 0;
          if (flags & 0x100) {
            duration = u32(segment, p);
            p += 4;
          }
          if (flags & 0x200) p += 4;
          if (flags & 0x400) p += 4;
          if (flags & 0x800) {
            const raw = u32(segment, p);
            cts = version === 1 ? raw | 0 : raw;
            p += 4;
          }
          presentations.push(decode + cts);
          decode += duration;
        }
      }
      endDecode = decode;
    }
  }
  if (startDecode === null || presentations.length === 0) throw new Error("Segment sans image.");
  const sorted = [...new Set(presentations)].sort((a, b) => a - b);
  return { presentations: sorted, endDecode, startDecode };
}
