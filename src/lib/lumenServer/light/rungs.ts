// Les échelons de la version allégée de Lumen serveur : quand une source en a, lesquels, à quelle taille, à quel débit,
// sous quelle identité. Fonctions pures (`lumenServer-light.test.ts`).
//
// Pourquoi deux échelons et ces chiffres (mesures du 17/11/2026, *Ghosted* 4K Dolby Vision HEVC 10 bits, iGPU UHD 630
// en VAAPI, X-Ray en marche, charge 7 à 11) : un segment de 4 s réencodé en 1080p HEVC Main10 à 8 Mb/s prend 1,4 à
// 1,9 s, en 720p à 3 Mb/s 1,4 s, 10 s de film en 4,4 s — ~2,3 à 2,8 fois le temps réel pour un encodage : de quoi
// rester devant la lecture et rattraper un retard, à deux encodages au plus (le iGPU sert aussi Jellyfin et X-Ray).
// - **l1** : au plus 1920×1080, 8 Mb/s en moyenne, 12 en crête (10 bits) — 6 et 9 en 8 bits ;
// - **l2** : au plus 1280×720, 3 Mb/s, 4,5 en crête (10 bits) — 2,5 et 3,75 en 8 bits.
// Un échelon n'existe que si la source pèse assez plus que lui (`sourceRatio`) : le double pour l1 (une source 1080p à
// 10 Mb/s n'a que l2) ; 1,5 fois pour l2 depuis le 17/11/2026 (Louis : « autoriser plus bas, des trucs à 4,5 Mb/s ») —
// une série à ~5,6 Mb/s comme *Ted Lasso* gagne une 720p à 3 Mb/s, qui tient sur une 4G faible ou un Wi-Fi d'hôtel où
// l'original s'arrête. En dessous de 720p, pas d'échelon : une connexion qui ne tient pas 3 Mb/s reçoit le message
// « connexion trop faible » de la page (`LumenServerHost`), pas une image floue.
// HEVC partout : tout appareil qui lit Lumen serveur (WebKit avec HLS natif) le décode, et le Chromecast n'y passe
// pas (sa vue `castView` n'a pas d'échelon). 10 bits et PQ gardés pour une source HDR ou Dolby Vision (la couche de
// base HDR10 d'un DV 8.1 : le RPU ne survit pas au réencodage), 8 bits sinon. Pas d'image B (`-bf 0`) : l'ordre de
// décodage est celui de présentation, chaque image garde l'instant de son image d'origine, et un segment commence et
// finit exactement là où celui de la vidéo d'origine commence et finit.

import { createHash } from "node:crypto";
import type { LumenIndex, LumenLightRung } from "../format";

/** À monter quand une règle de ce fichier ou de l'encodage change des octets : c'est dans l'identité (`cid`). */
export const LIGHT_RULES_VERSION = 1;

export interface RungShape {
  rung: 1 | 2;
  maxWidth: number;
  maxHeight: number;
  /** Débits visés (b/s) en 10 bits, puis en 8 bits. */
  average10: number;
  peak10: number;
  average8: number;
  peak8: number;
  /** `general_level_idc` imposé à l'encodeur (`-level`) : 123 = 4.1, 93 = 3.1. */
  level: number;
  /** L'échelon n'existe que si la source pèse au moins tant de fois sa moyenne. */
  sourceRatio: number;
}

export const RUNG_SHAPES: readonly RungShape[] = [
  { rung: 1, maxWidth: 1920, maxHeight: 1080, average10: 8_000_000, peak10: 12_000_000, average8: 6_000_000, peak8: 9_000_000, level: 123, sourceRatio: 2 },
  { rung: 2, maxWidth: 1280, maxHeight: 720, average10: 3_000_000, peak10: 4_500_000, average8: 2_500_000, peak8: 3_750_000, level: 93, sourceRatio: 1.5 },
];

/** Les codecs vidéo que le iGPU sait décoder ici (VAAPI, UHD 630) : HEVC et H.264. Ni AV1 ni VP9. */
const DECODABLE = new Set(["V_MPEGH/ISO/HEVC", "V_MPEG4/ISO/AVC"]);

/** Ce que l'encodeur détecté apporte à l'identité d'un échelon. */
export interface EncoderFacts {
  version: string;
  driver: string;
}

/** La taille d'un échelon : la source réduite pour tenir dans la boîte, proportions gardées, en nombres pairs. */
export function rungSize(width: number, height: number, shape: Pick<RungShape, "maxWidth" | "maxHeight">): { width: number; height: number } {
  const scale = Math.min(1, shape.maxWidth / width, shape.maxHeight / height);
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** CODECS d'une variante HEVC au profil et au niveau imposés (`hvc1.2.4.L123.B0` en Main10, `hvc1.1.6.L93.B0` en Main). */
export function rungCodecs(tenBit: boolean, level: number): string {
  return tenBit ? `hvc1.2.4.L${level}.B0` : `hvc1.1.6.L${level}.B0`;
}

/** La source est-elle HDR (PQ ou HLG, Dolby Vision compris) ? Ce que dit sa signalisation HLS. */
function isHdr(index: Pick<LumenIndex, "video">): boolean {
  const range = index.video?.signal?.videoRange;
  return range === "PQ" || range === "HLG";
}

/**
 * Les échelons d'une source, ou une liste vide : une vidéo servie, Matroska (les instants que l'encodeur reçoit sont
 * ceux du conteneur, `-seek_timestamp` ; un MP4 a ses listes d'édition), un codec que le iGPU décode, et assez lourde.
 */
export function lightRungs(index: Pick<LumenIndex, "video" | "container" | "bandwidth" | "refusal" | "segments" | "identity">, encoder: EncoderFacts): LumenLightRung[] {
  const video = index.video;
  if (!video?.signal || index.refusal || index.container !== "matroska" || index.segments.length === 0 || !DECODABLE.has(video.codecId)) return [];
  const tenBit = isHdr(index);
  const out: LumenLightRung[] = [];
  for (const shape of RUNG_SHAPES) {
    const average = tenBit ? shape.average10 : shape.average8;
    const peak = tenBit ? shape.peak10 : shape.peak8;
    if (index.bandwidth.average < shape.sourceRatio * average) continue;
    const size = rungSize(video.width, video.height, shape);
    const cid = createHash("sha256")
      .update(JSON.stringify({ rules: LIGHT_RULES_VERSION, ffmpeg: encoder.version, driver: encoder.driver, rung: shape.rung, size, tenBit, average, peak, level: shape.level, range: video.signal.videoRange }))
      .digest("hex")
      .slice(0, 8);
    out.push({ rung: shape.rung, cid, width: size.width, height: size.height, tenBit, averageBps: average, peakBps: peak, codecs: rungCodecs(tenBit, shape.level) });
  }
  return out;
}

/** La forme d'un échelon (ses réglages d'encodeur). */
export function shapeOf(rung: 1 | 2): RungShape {
  return RUNG_SHAPES.find((s) => s.rung === rung)!;
}
