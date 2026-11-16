// L'index d'un fichier pour Lumen serveur : ce que toutes les requêtes d'une séance partagent.
//
// Calculé une fois par version du fichier, gardé par `indexCache.ts`, et assez petit pour être
// recopié d'un fil à l'autre : les pistes, les images clés **vérifiées**, la découpe, le délai de
// présentation D, les débits estimés, les init segments, et pour chaque piste ce qui l'empêche
// d'être servie. Rien n'y dépend d'un spectateur ni d'un navigateur.
//
// **Le lecteur d'index léger.** L'index d'un Matroska (Cues) ment parfois — 14 « clés » sur 193 d'un
// fichier étaient des TRAIL_R (`isRandomAccessPoint`) — et une liste sans état ne peut pas reculer au
// moment de servir un segment : la vérification se fait ici. Pour chaque point d'index vidéo : l'en-tête
// des blocs de sa grappe (`walkBlocks`) et la tête de la première image (`sketchPicture`, quelques
// dizaines d'octets), puis, pour une CRA ou une clé H.264 non IDR seulement, les en-têtes des images
// suivantes. Le prototype lisait 0,5 à 1,2 Mo par point ; ceci lit quelques Ko.
//
// **Une clé n'est un point de coupe que si un décodeur peut partir d'elle sans rien perdre** :
// - HEVC IDR et BLA ;
// - HEVC CRA **sans** image RASL derrière elle. Ses RASL se réfèrent à des images d'avant la clé :
//   coupées là, elles manqueraient de références après un saut — ce que Safari MSE n'a jamais su
//   écarter seul (*Ted Lasso* S02E01, « Media failed to decode », §RASL de CLAUDE.md) — ou, écartées
//   partout, laisseraient un trou de 125 ms en lecture continue (1-remuxeur.md §1.2, mesuré). Une
//   telle CRA reste à l'intérieur d'un segment, où ses RASL ont leurs références ;
// - H.264 IDR ; une image I derrière un point de reprise (`isRandomAccessPoint`) seulement si aucune
//   image ne la suit dans l'ordre de décodage en s'affichant avant elle : c'est l'équivalent H.264
//   d'une RASL, que rien dans le flux ne nomme.
// Apple écrit « Video segments MUST start with an IDR frame » (HLS Authoring Specification, 7.4) : une
// CRA sans RASL et une I à point de reprise sans images de tête produisent exactement les images d'un
// départ sur IDR (H.265 §8.1.3, H.264 §D.2.8) ; qu'AVPlayer les accepte en tête de segment reste à voir
// sur un appareil (README, « Inconnues »). S'il les refuse, la règle devient « IDR seulement »,
// `LUMEN_FORMAT_VERSION` monte, et les fichiers à CRA (*Ted Lasso*) deviennent `segment-trop-long`.
//
// **L'index des Cues** (découpe par défaut `cra`, format 2, DECISIONS.md §158). Sous `cra`, toute image clé
// de l'index ouvre un segment, RASL gardées : le banc Safari du 16/11/2026 (iPhone, 253 sauts) a montré
// que le HLS natif d'Apple les jette seul après un saut. Il n'y a donc plus rien à demander à chaque
// image clé — son type ne change plus la découpe —, et l'index se construit **depuis les Cues seules** :
// une coupe par grappe indexée au moins à la cible de la précédente, à l'instant que le Cue donne. Seule
// la première clé est lue (`trustedCuts`) : D se mesure sur son groupe, et un fichier qui commence sur
// une image non clé (*Gravity Falls* S02E14 : le premier Cue désigne un bloc non clé à 53 ms) aurait un
// premier segment introuvable. Ce que cela coûte, et pourquoi c'est accepté :
// - **un Cue qui ment** (RFC 9559 §22.1 : chaque clé vidéo « SHOULD » être indexée, une non-clé « NOT
//   RECOMMENDED » — pas interdit) : recensement du 16/11/2026, 3 fichiers sur 300 avaient des points d'index
//   sans image d'accès aléatoire. Sondés le 17/11 : 29 blocs sur deux épisodes de *La Petite Maison dans la
//   prairie* drapeautés clé par le Matroska mais TRAIL_R (NAL 1), et le premier Cue de *Gravity Falls*. Un
//   tel segment se recolle exactement en lecture continue (ses références sont au segment d'avant) ; après
//   un saut qui tombe dessus, quelques secondes d'image abîmée jusqu'à la clé suivante. Le constructeur le
//   voit à la lecture (`falseKey`, compté au relevé de la lecture) ; le repérer ici coûterait la lecture
//   par point que cet index supprime ;
// - **une I H.264 à images de tête** (GOP ouvert H.264, l'équivalent d'une CRA à RASL que rien ne nomme)
//   devient une coupe : en lecture continue rien ne change, après un saut ses images de tête n'ont pas leurs
//   références. Recensement : aucune sur 80 fichiers H.264 (tous les points lus) ;
// - **un index troué** (un Cue manquant sur des minutes : *Don't Look Up* 297 s, un H.264 136 s) : aucun
//   chemin ne le répare — la vérification ne cherche des clés qu'aux points d'index —, il est refusé
//   (`index-troue`, la raison dit pourquoi) ;
// - **sans Cues** : refusé (`pas-d-index`), comme avant ; aucun sur 300.
// La découpe d'essai `idr` garde la vérification point par point ci-dessus (`selectCuts`) ; `cra-leading`
// se construit comme `cra` (ses `is_leading` sont lus à la construction des segments, `segment.ts`).

import type { ByteSource } from "../webcodecs/byteSource";
import { openMediaFile } from "../webcodecs/mediaFile";
import type { MatroskaFile, MatroskaTrack } from "../webcodecs/matroska";
import { dolbyVisionInfo, isRandomAccessPoint, isRaslPicture, nalLengthSize } from "../webcodecs/codecConfig";
import { assignDecodeTimes, deriveDurations } from "../webcodecs/decodeOrder";
import { audioSampleEntryFor, parseAacConfig, videoSampleEntry } from "../webcodecs/mp4SampleEntries";
import { initSegment } from "../webcodecs/mp4Muxer";
import { AUDIO_LEAD_GAP_SECONDS, audioLeadGapSeconds } from "../webcodecs/audioLeadGap";
import { AAC_RATES, aacHlsPlan, silenceMayFollow, silentAacFrame, type AscFacts } from "./audio/aacStream";
import { dolbyFrameCount, dolbySilenceRefusal, readDolbyHeader, silentDolbyFrame, type DolbyHeader } from "./audio/dolbySilence";
import type { LumenSilence } from "./audio/silence";
import { CONVERT_CODECS, convertSourceOf } from "./audio/convertSource";
import { hlsAudioSignal, hlsVideoSignal } from "./hlsSignal";
import { readBlockSamples, sketchPicture, walkBlocks, type BlockHead, type PictureSketch } from "./mkvBlocks";
import { planSegments, type CutPoint } from "./plan";
import {
  AUDIO_TRACK_ID,
  DELAY_MARGIN_FRAMES,
  FALLBACK_FRAME_US,
  LUMEN_DEFAULT_CUT,
  LUMEN_FORMAT_VERSION,
  LUMEN_MAX_SEGMENT_BYTES,
  LUMEN_MAX_SEGMENT_US,
  LUMEN_TARGET_SEGMENT_US,
  LUMEN_TIMESCALE,
  VIDEO_TRACK_ID,
  identityKey,
  type FileIdentity,
  type KeyKind,
  type LumenAudioTrack,
  type LumenCutMode,
  type LumenIndex,
  type LumenKeyStats,
  type LumenRefusal,
  type LumenSegment,
  type LumenVideoTrack,
} from "./format";

/** Les codecs que le remuxeur sait copier dans un HLS lisible par Apple (4-son-compat.md §4.1). */
const COPYABLE_AUDIO = new Set(["A_AAC", "A_AC3", "A_EAC3", "A_FLAC"]);

/** Combien d'images suivre derrière une clé pour y chercher des RASL ou des images de tête. */
const FOLLOW_PICTURES = 16;

/** Combien d'images lire au plus pour le premier groupe (le délai D) : un groupe de 25 s à 60 i/s. */
const FIRST_GROUP_PICTURES = 1500;

/**
 * Jusqu'où chercher le premier bloc de chaque piste audio au-delà de la première image : le seuil du
 * son en retard (§148) et une seconde de marge. Au-delà, la piste est en retard, et on sait assez.
 */
const AUDIO_PROBE_US = AUDIO_LEAD_GAP_SECONDS * 1_000_000 + 1_000_000;

export interface VerifiedKey {
  timeUs: number;
  at: number;
  kind: KeyKind;
  rasl: boolean;
  leading: boolean;
}

/** Le type NAL de la tranche d'une tête d'image, ou -1. */
function sliceType(sketch: Uint8Array, lengthSize: number, hevc: boolean): number {
  for (let at = 0; at + lengthSize + 1 <= sketch.length; ) {
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + sketch[at + i];
    if (length <= 0 || at + lengthSize + length > sketch.length) return -1;
    const header = sketch[at + lengthSize];
    const type = hevc ? (header >> 1) & 0x3f : header & 0x1f;
    if (hevc ? type <= 31 : type >= 1 && type <= 5) return type;
    at += lengthSize + length;
  }
  return -1;
}

function keyKind(type: number, hevc: boolean): KeyKind {
  if (hevc) {
    if (type === 19 || type === 20) return "idr";
    if (type >= 16 && type <= 18) return "bla";
    if (type === 21) return "cra";
    return "autre";
  }
  return type === 5 ? "idr" : "i-recovery";
}

/** Une image de tête HEVC : RADL (6, 7) ou RASL (8, 9). */
function isLeadingType(type: number): boolean {
  return type >= 6 && type <= 9;
}

/** La tête d'une image Matroska — lue entière pour un bloc lacé (jamais vu pour de la vidéo). */
async function sketchBlock(source: ByteSource, file: MatroskaFile, head: BlockHead, video: LumenVideoTrack): Promise<PictureSketch> {
  if (head.frameOffset !== null) return sketchPicture(source, head.frameOffset, head.frameSize, video.lengthSize, video.codecId);
  const [sample] = await readBlockSamples(source, file, head);
  const data = sample?.data ?? new Uint8Array(0);
  return { sketch: data, slice: sliceType(data, video.lengthSize, video.codecId === "V_MPEGH/ISO/HEVC") >= 0 };
}

// ── Vérification des clés ────────────────────────────────────────────────────

/** Un point d'index à vérifier : un instant annoncé, et où relire l'image. */
export interface Candidate {
  timeUs: number;
  /** Matroska : la grappe. MP4 : le rang de l'échantillon vidéo. */
  at: number;
}

/** Les points d'index vidéo, triés, un par grappe (Matroska) ou par échantillon synchrone (MP4). */
function candidatesOf(file: MatroskaFile, video: LumenVideoTrack): Candidate[] {
  if (file.mp4) {
    const t = file.mp4.tracks.find((track) => track.number === video.number);
    if (!t) return [];
    const out: Candidate[] = [];
    for (let i = 0; i < t.dtsUs.length; i++) if (!t.sync || t.sync[i]) out.push({ timeUs: t.dtsUs[i] + (t.ctsUs?.[i] ?? 0), at: i });
    return out.sort((a, b) => a.timeUs - b.timeUs || a.at - b.at);
  }
  // Plusieurs points pour la même grappe (un par piste, ou réécrits) : une seule lecture.
  const byCluster = new Map<number, number>();
  for (const cue of file.cues) {
    if (cue.track !== video.number) continue;
    const known = byCluster.get(cue.clusterOffset);
    if (known === undefined || cue.timeUs < known) byCluster.set(cue.clusterOffset, cue.timeUs);
  }
  return [...byCluster].map(([at, timeUs]) => ({ timeUs, at })).sort((a, b) => a.timeUs - b.timeUs || a.at - b.at);
}

/**
 * Matroska : la première image d'accès aléatoire de la grappe, et ce qui la suit. Null : la grappe n'en
 * a pas (le point d'index ment).
 */
async function verifyMatroskaKey(source: ByteSource, file: MatroskaFile, video: LumenVideoTrack, clusterOffset: number): Promise<VerifiedKey | null> {
  const hevc = video.codecId === "V_MPEGH/ISO/HEVC";
  let key: VerifiedKey | null = null;
  let following = 0;
  await walkBlocks(source, file, clusterOffset, async (head) => {
    if (head.track !== video.number) return "continue";
    if (!key) {
      // Le point d'index désigne une grappe : la clé est la première image d'accès aléatoire qu'on
      // y trouve. Hors de la grappe sans l'avoir trouvée, le point est refusé.
      if (head.clusterOffset !== clusterOffset) return "stop";
      const { sketch, slice } = await sketchBlock(source, file, head, video);
      if (!slice) return "continue"; // un bloc égaré (unités sans tranche) n'est pas une image
      if (!head.isKey || !isRandomAccessPoint(sketch, video.codecId, video.lengthSize)) return "continue";
      const kind = keyKind(sliceType(sketch, video.lengthSize, hevc), hevc);
      key = { timeUs: head.timeUs, at: clusterOffset, kind, rasl: false, leading: false };
      // Seules une CRA (RASL possibles) et une I à point de reprise (images de tête possibles)
      // demandent de regarder derrière elles ; une IDR ou une BLA s'arrête là.
      return kind === "cra" || kind === "i-recovery" ? "continue" : "stop";
    }
    if (++following > FOLLOW_PICTURES) return "stop";
    const found = key as VerifiedKey;
    if (hevc) {
      const { sketch, slice } = await sketchBlock(source, file, head, video);
      if (!slice) return "continue";
      // Les images de tête suivent leur clé dans l'ordre de décodage, avant toute image ordinaire
      // (H.265 §7.4.3.2) : la première qui n'en est pas une clôt la recherche.
      if (!isLeadingType(sliceType(sketch, video.lengthSize, true))) return "stop";
      if (isRaslPicture(sketch, video.codecId, video.lengthSize)) found.rasl = true;
      return found.rasl ? "stop" : "continue";
    }
    // H.264 : l'instant suffit, l'en-tête du bloc le donne.
    if (head.timeUs < found.timeUs) {
      found.leading = true;
      return "stop";
    }
    return "continue";
  });
  return key;
}

/** MP4 : l'échantillon synchrone `i`, et ce qui le suit dans l'ordre de décodage. */
async function verifyMp4Key(source: ByteSource, file: MatroskaFile, video: LumenVideoTrack, i: number): Promise<VerifiedKey | null> {
  const hevc = video.codecId === "V_MPEGH/ISO/HEVC";
  const t = file.mp4?.tracks.find((track) => track.number === video.number);
  if (!t) return null;
  const pts = (k: number) => t.dtsUs[k] + (t.ctsUs?.[k] ?? 0);
  const { sketch, slice } = await sketchPicture(source, t.offsets[i], t.sizes[i], video.lengthSize, video.codecId);
  if (!slice || !isRandomAccessPoint(sketch, video.codecId, video.lengthSize)) return null;
  const kind = keyKind(sliceType(sketch, video.lengthSize, hevc), hevc);
  const key: VerifiedKey = { timeUs: pts(i), at: i, kind, rasl: false, leading: false };
  if (kind === "cra") {
    for (let j = i + 1; j < Math.min(t.dtsUs.length, i + 1 + FOLLOW_PICTURES); j++) {
      const next = await sketchPicture(source, t.offsets[j], t.sizes[j], video.lengthSize, video.codecId);
      if (!next.slice) continue;
      if (!isLeadingType(sliceType(next.sketch, video.lengthSize, true))) break;
      if (isRaslPicture(next.sketch, video.codecId, video.lengthSize)) {
        key.rasl = true;
        break;
      }
    }
  } else if (kind === "i-recovery") {
    // L'index donne les instants : aucune lecture.
    for (let j = i + 1; j < Math.min(t.dtsUs.length, i + 1 + FOLLOW_PICTURES); j++) {
      if (pts(j) < key.timeUs) {
        key.leading = true;
        break;
      }
    }
  }
  return key;
}

/**
 * Une clé *lue* peut-elle ouvrir un segment ? Sous `idr`, jamais une CRA à RASL ; sous `cra`/`cra-leading`,
 * si : ses RASL restent dans le segment qu'elle ouvre. L'I H.264 à images de tête reste refusée partout où
 * elle est lue — rien dans un flux H.264 ne nomme ces images, aucun décodeur ne saura les jeter seul. (Sous
 * `cra`, seule la première clé est lue : voir « l'index des Cues » en tête.)
 */
export function isCut(key: VerifiedKey, cut: LumenCutMode): boolean {
  return key.kind !== "autre" && (!key.rasl || cut !== "idr") && !key.leading;
}

/** Combien de points d'index vérifier à la fois : des lectures en vol que le disque range lui-même. */
const VERIFY_BATCH = 16;

/**
 * Les points de coupe, choisis comme le ferait la découpe gloutonne sur toutes les clés vérifiées —
 * la première clé admise au moins `targetUs` après la coupe précédente —, mais en ne vérifiant que
 * les candidates dont elle a besoin. Le résultat est le même ; le coût, deux à trois fois moindre
 * (un point d'index sur deux est sauté à 4 s de cible quand les clés sont à 2 s). Mesuré au banc
 * (épisode H.264, 768 points, disque froid) : 5,6 s pour tout vérifier une lecture à la fois.
 *
 * Par lots, en parallèle : on suppose chaque candidate admise et l'on vérifie d'un coup la chaîne de
 * candidates qui en découle ; un refus (une CRA à RASL, un point qui ment) défait la chaîne à partir de
 * lui, et la suivante reprend de la candidate d'après. Les refus sont rares (23 sur 705 dans *Ted
 * Lasso*) : presque toutes les lectures d'un lot servent.
 *
 * Déterministe : la chaîne ne dépend que des instants lus dans le fichier, jamais de l'ordre dans
 * lequel les lectures reviennent.
 */
export async function selectCuts(
  candidates: Candidate[],
  targetUs: number,
  verify: (c: Candidate) => Promise<VerifiedKey | null>,
  stats: LumenKeyStats,
  cut: LumenCutMode
): Promise<VerifiedKey[]> {
  const cuts: VerifiedKey[] = [];
  let threshold = -Infinity;
  let from = 0;
  while (from < candidates.length) {
    const chain: number[] = [];
    let next = from;
    let th = threshold;
    while (chain.length < VERIFY_BATCH) {
      while (next < candidates.length && candidates[next].timeUs < th) next += 1;
      if (next >= candidates.length) break;
      chain.push(next);
      th = candidates[next].timeUs + targetUs;
      next += 1;
    }
    if (chain.length === 0) break;
    const results = await Promise.all(chain.map((k) => verify(candidates[k])));
    from = chain[chain.length - 1] + 1;
    for (let r = 0; r < chain.length; r++) {
      const key = results[r];
      countKey(stats, key);
      // Une clé lue avant la précédente coupe (un point d'index qui annonçait un autre instant) ne
      // rouvre rien : la découpe avance toujours.
      const last = cuts[cuts.length - 1];
      if (key && isCut(key, cut) && (!last || key.timeUs > last.timeUs)) {
        cuts.push(key);
        threshold = key.timeUs + targetUs;
        continue;
      }
      // Refusée : la chaîne supposée au-delà ne tient plus. On reprend juste après elle.
      from = chain[r] + 1;
      break;
    }
  }
  return cuts;
}

/** Combien de points d'index lire au plus, du début, pour trouver la première clé (sous `cra`). */
const FIRST_KEY_TRIES = 8;

/** Compte une clé lue dans les statistiques de l'index. */
function countKey(stats: LumenKeyStats, key: VerifiedKey | null): void {
  stats.verified += 1;
  if (!key) {
    stats.rejected += 1;
    return;
  }
  if (key.kind === "idr") stats.idr += 1;
  if (key.kind === "cra") stats.cra += 1;
  if (key.rasl) stats.craRasl += 1;
  if (key.leading) stats.leading += 1;
}

/**
 * Les coupes de l'index des Cues (découpes `cra`, `cra-leading` — §158) : la première clé lue, puis
 * chaque point d'index au moins `targetUs` après la coupe précédente, **sans le lire** — à l'instant que
 * l'index donne, dans la grappe qu'il désigne. Le même glouton que `selectCuts`, dont chaque vérification
 * dirait oui : sur un fichier dont l'index ne ment pas, les mêmes coupes que `selectCuts` sous `cra` (un
 * test le vérifie), sans une lecture par point.
 *
 * La première clé est lue (au plus `FIRST_KEY_TRIES` points, du début) : D se mesure sur son groupe, et
 * un fichier qui commence sur une image non clé n'aurait pas de premier segment. Aucune trouvée : aucune
 * coupe (`index-invalide`).
 */
export async function trustedCuts(
  candidates: Candidate[],
  targetUs: number,
  verify: (c: Candidate) => Promise<VerifiedKey | null>,
  stats: LumenKeyStats,
  cut: LumenCutMode
): Promise<CutPoint[]> {
  let first: VerifiedKey | null = null;
  let from = 0;
  for (; from < Math.min(candidates.length, FIRST_KEY_TRIES); from++) {
    const key = await verify(candidates[from]);
    countKey(stats, key);
    if (key && isCut(key, cut)) {
      first = key;
      break;
    }
  }
  if (!first) return [];
  const cuts: CutPoint[] = [{ timeUs: first.timeUs, at: first.at }];
  let threshold = first.timeUs + targetUs;
  for (let i = from + 1; i < candidates.length; i++) {
    const c = candidates[i];
    // Un point d'avant la coupe précédente (un index dans le désordre) ne rouvre rien : la découpe avance.
    if (c.timeUs < threshold || c.timeUs <= cuts[cuts.length - 1].timeUs) continue;
    cuts.push({ timeUs: c.timeUs, at: c.at });
    threshold = c.timeUs + targetUs;
    stats.trusted += 1;
  }
  return cuts;
}

/** Le plus grand écart entre deux points d'index consécutifs (µs) : ce qu'un index troué laisse sans coupe. */
function largestCueGap(candidates: Candidate[], durationUs: number): number {
  let gap = 0;
  for (let i = 1; i < candidates.length; i++) gap = Math.max(gap, candidates[i].timeUs - candidates[i - 1].timeUs);
  if (candidates.length > 0) gap = Math.max(gap, durationUs - candidates[candidates.length - 1].timeUs);
  return gap;
}

// ── Le premier groupe : D ────────────────────────────────────────────────────

/**
 * Les instants de présentation du premier groupe d'images du premier segment, dans l'ordre de
 * décodage, sans les blocs égarés — exactement ce que le constructeur de segments passera à
 * `assignDecodeTimes` pour ce groupe.
 */
async function firstGroupPresentations(source: ByteSource, file: MatroskaFile, video: LumenVideoTrack, first: LumenSegment): Promise<number[]> {
  const out: number[] = [];
  if (file.mp4) {
    const t = file.mp4.tracks.find((track) => track.number === video.number);
    if (!t) return out;
    for (let i = first.at; i < t.dtsUs.length && out.length < FIRST_GROUP_PICTURES; i++) {
      const pts = t.dtsUs[i] + (t.ctsUs?.[i] ?? 0);
      if (i > first.at && (!t.sync || t.sync[i])) {
        const { sketch } = await sketchPicture(source, t.offsets[i], t.sizes[i], video.lengthSize, video.codecId);
        if (isRandomAccessPoint(sketch, video.codecId, video.lengthSize)) break;
      }
      out.push(pts);
    }
    return out;
  }
  let started = false;
  await walkBlocks(source, file, first.at, async (head) => {
    if (head.track !== video.number) return "continue";
    const { sketch, slice } = await sketchBlock(source, file, head, video);
    if (!slice) return "continue";
    if (!started) {
      if (head.timeUs !== first.keyUs || !head.isKey) return "continue";
      started = true;
      out.push(head.timeUs);
      return "continue";
    }
    if (head.isKey && isRandomAccessPoint(sketch, video.codecId, video.lengthSize)) return "stop";
    out.push(head.timeUs);
    return out.length >= FIRST_GROUP_PICTURES ? "stop" : "continue";
  });
  return out;
}

/**
 * D et la durée d'une image, par la formule du remuxeur (`buildVideo`) ; et la cadence moyenne du
 * groupe pour `FRAME-RATE`.
 */
export function presentationDelayOf(presentations: number[]): { delayUs: number; frameUs: number; frameRate: number } {
  if (presentations.length === 0) return { delayUs: DELAY_MARGIN_FRAMES * FALLBACK_FRAME_US, frameUs: FALLBACK_FRAME_US, frameRate: 1e6 / FALLBACK_FRAME_US };
  const durations = deriveDurations(presentations, FALLBACK_FRAME_US);
  const ordered = assignDecodeTimes(
    presentations.map((presentation, i) => ({ presentation, duration: durations[i] })),
    Math.min(...presentations)
  );
  const frameUs = durations[0] || FALLBACK_FRAME_US;
  const span = Math.max(...presentations) - Math.min(...presentations);
  const frameRate = presentations.length > 1 && span > 0 ? (1e6 * (presentations.length - 1)) / span : 1e6 / frameUs;
  return { delayUs: ordered.presentationDelay + DELAY_MARGIN_FRAMES * frameUs, frameUs, frameRate };
}

// ── Le son ───────────────────────────────────────────────────────────────────

/** Combien de trames AAC lire en tête de piste pour juger le SBR (la première décide, les suivantes confirment). */
const AAC_PROBE_FRAMES = 8;

/**
 * Jusqu'où chercher le premier bloc d'une piste que la première fenêtre n'a pas trouvé (§159 : on le complète
 * de silence, encore faut-il savoir où le son commence). *The Circle* : 30 s, le plus long des 63 pistes de §148.
 */
const AUDIO_LATE_PROBE_US = 180_000_000;

/** Jusqu'où remonter depuis la fin pour trouver le dernier bloc d'une piste plus courte que l'image. */
const AUDIO_TAIL_PROBE_US = 20 * 60_000_000;

interface AudioFacts {
  firstUs: number | null;
  firstFrame: Uint8Array | null;
  /** AAC : les premières trames de la piste, pour `aacHlsPlan`. */
  firstFrames: Uint8Array[];
  /** L'instant du dernier bloc vu à partir du dernier segment, ou null. */
  lastUs: number | null;
  /** Une piste absente du dernier segment : son dernier bloc (instant, trames, la dernière trame). */
  tail: { timeUs: number; frames: number; lastFrame: Uint8Array } | null;
}

function emptyFacts(): AudioFacts {
  return { firstUs: null, firstFrame: null, firstFrames: [], lastUs: null, tail: null };
}

/**
 * Le premier bloc de chaque piste audio, en lisant les en-têtes depuis le début du film ; pour l'AAC, les
 * premières trames. Une piste que la première fenêtre (le seuil de §148 et une seconde) ne trouve pas est
 * cherchée plus loin, jusqu'à `AUDIO_LATE_PROBE_US` — seules les pistes en retard paient cette lecture.
 */
async function probeAudioStarts(source: ByteSource, file: MatroskaFile, video: LumenVideoTrack, tracks: MatroskaTrack[]): Promise<Map<number, AudioFacts>> {
  const facts = new Map<number, AudioFacts>(tracks.map((t) => [t.number, emptyFacts()]));
  if (tracks.length === 0) return facts;
  const isAac = new Set(tracks.filter((t) => t.codecId === "A_AAC").map((t) => t.number));
  if (file.mp4) {
    for (const t of tracks) {
      const index = file.mp4.tracks.find((x) => x.number === t.number);
      if (!index || index.dtsUs.length === 0) continue;
      const f = facts.get(t.number) as AudioFacts;
      f.firstUs = index.dtsUs[0] + (index.ctsUs?.[0] ?? 0);
      f.firstFrame = await source.read(index.offsets[0], index.sizes[0]);
      f.lastUs = index.dtsUs[index.dtsUs.length - 1] + (index.ctsUs?.[index.dtsUs.length - 1] ?? 0);
      if (isAac.has(t.number)) {
        for (let i = 0; i < Math.min(AAC_PROBE_FRAMES, index.dtsUs.length); i++) f.firstFrames.push(await source.read(index.offsets[i], index.sizes[i]));
      }
    }
    return facts;
  }
  const done = (number: number) => {
    const f = facts.get(number) as AudioFacts;
    return f.firstUs !== null && (!isAac.has(number) || f.firstFrames.length >= AAC_PROBE_FRAMES);
  };
  let missing = tracks.length;
  let firstVideoUs: number | null = null;
  let horizon = AUDIO_PROBE_US;
  const walk = () =>
    walkBlocks(source, file, file.firstClusterOffset ?? file.segmentDataStart, async (head) => {
      if (head.track === video.number) {
        firstVideoUs ??= head.timeUs;
        return firstVideoUs !== null && head.timeUs > firstVideoUs + horizon ? "stop" : "continue";
      }
      const f = facts.get(head.track);
      if (!f || done(head.track)) return "continue";
      const samples = await readBlockSamples(source, file, head);
      if (f.firstUs === null) {
        // Le premier échantillon, comme `probeTrackStart` du remuxeur : c'est lui qui décrit l'AC-3/E-AC-3.
        f.firstUs = head.timeUs;
        f.firstFrame = samples[0]?.data ? new Uint8Array(samples[0].data) : null;
      }
      if (isAac.has(head.track)) for (const s of samples) if (f.firstFrames.length < AAC_PROBE_FRAMES) f.firstFrames.push(new Uint8Array(s.data));
      if (done(head.track)) missing -= 1;
      return missing === 0 ? "stop" : "continue";
    });
  await walk();
  if (tracks.some((t) => facts.get(t.number)?.firstUs === null)) {
    // Une seconde passe, plus longue, seulement pour une piste qui commence tard : les autres sont faites.
    missing = tracks.filter((t) => !done(t.number)).length;
    horizon = AUDIO_LATE_PROBE_US;
    firstVideoUs = null;
    await walk();
  }
  return facts;
}

/** L'instant du dernier bloc de chaque piste audio dans le dernier segment (Matroska). */
async function probeAudioEnds(source: ByteSource, file: MatroskaFile, last: LumenSegment, facts: Map<number, AudioFacts>): Promise<void> {
  if (file.mp4) return; // l'index MP4 l'a déjà dit
  await walkBlocks(source, file, last.at, (head) => {
    const f = facts.get(head.track);
    if (f && (f.lastUs === null || head.timeUs > f.lastUs)) f.lastUs = head.timeUs;
    return "continue";
  });
}

/**
 * Le dernier bloc d'une piste absente du dernier segment : en remontant segment par segment depuis la fin,
 * jusqu'à `AUDIO_TAIL_PROBE_US`. Les en-têtes seulement, puis le bloc trouvé (ses trames : la fin du son).
 */
async function probeAudioTail(source: ByteSource, file: MatroskaFile, segments: LumenSegment[], track: number, facts: AudioFacts): Promise<void> {
  if (file.mp4) {
    const index = file.mp4.tracks.find((x) => x.number === track);
    if (!index || index.dtsUs.length === 0) return;
    const i = index.dtsUs.length - 1;
    facts.tail = { timeUs: index.dtsUs[i] + (index.ctsUs?.[i] ?? 0), frames: 1, lastFrame: await source.read(index.offsets[i], index.sizes[i]) };
    return;
  }
  const endUs = segments[segments.length - 1].startUs;
  for (let k = segments.length - 2; k >= 0 && endUs - segments[k].startUs <= AUDIO_TAIL_PROBE_US; k--) {
    let found: BlockHead | null = null;
    await walkBlocks(
      source,
      file,
      segments[k].at,
      (head) => {
        if (head.track === track && (found === null || head.timeUs >= found.timeUs)) found = head;
        return "continue";
      },
      segments[k + 1].at
    );
    if (found) {
      const samples = await readBlockSamples(source, file, found);
      const last = samples[samples.length - 1];
      // La fin du son : autant de trames que l'échantillon en porte (un bloc AC-3 peut en mettre plusieurs
      // à la suite sans laçage ; une E-AC-3 dépendante ne dure rien de plus que son indépendante).
      const dolby = file.tracks.find((t) => t.number === track && (t.codecId === "A_AC3" || t.codecId === "A_EAC3"));
      const frames = samples.reduce((sum, s) => sum + ((dolby ? dolbyFrameCount(new Uint8Array(s.data)) : null) ?? 1), 0);
      if (last) facts.tail = { timeUs: (found as BlockHead).timeUs, frames, lastFrame: new Uint8Array(last.data) };
      return;
    }
  }
}

/** Ce que l'index décide pour une piste audio : servie telle quelle, réparée, ou refusée. */
interface AudioPlan {
  refusal: LumenRefusal | null;
  configuration: Uint8Array | null;
  channels: number;
  sampleRate: number;
  silence: LumenSilence | null;
}

/** Les fréquences de l'AC-3 et de l'E-AC-3 servies (A/52 : fscod 0, 1, 2). */
const DOLBY_RATES = new Set([48000, 44100, 32000]);

/**
 * Ce qu'on fait d'une piste audio dans le HLS (DECISIONS.md §155, §159).
 *
 * Copiables (4-son-compat.md §4.1, HLS Authoring Specification 2.2, 2.5, 2.25) : AAC-LC et HE-AAC (le
 * SBR implicite rendu explicite, règle 2.24, `aacHlsPlan`), AC-3 et E-AC-3 (Atmos compris, la
 * signalisation de l'étape 1) à 48, 44,1 et 32 kHz, FLAC (cité par Apple en stéréo et multicanal, fMP4
 * obligatoire — ce que le remuxeur écrit). Pas Opus (absent de la spécification), ni DTS, TrueHD, MP2, PCM.
 * Une piste qui commence après l'image ou finit avant elle est complétée de silence (`audio/silence.ts`)
 * quand on sait en construire la trame. Refusé par prudence : un AAC dont la disposition est un PCE (§62 :
 * un 5.1 que CoreAudio refuse), un cœur mono à SBR implicite (HE-AAC v2 possible).
 */
function audioPlan(track: MatroskaTrack, facts: AudioFacts, videoStartUs: number, lastStartUs: number | null, endUs: number): AudioPlan {
  const plan: AudioPlan = { refusal: null, configuration: null, channels: track.audio?.channels ?? 2, sampleRate: track.audio?.sampleRate ?? 48000, silence: null };
  const refuse = (refusal: LumenRefusal): AudioPlan => ({ ...plan, refusal });
  if (!COPYABLE_AUDIO.has(track.codecId)) return refuse({ reason: "son-codec", detail: track.codecId });
  const rate = track.audio?.sampleRate ?? 48000;
  const dolby = track.codecId === "A_AC3" || track.codecId === "A_EAC3";
  let aacCore: AscFacts | null = null;
  let sbrRewritten = false;
  if (track.codecId === "A_AAC") {
    const config = track.codecPrivate ? parseAacConfig(track.codecPrivate) : null;
    if (!config) return refuse({ reason: "son-codec", detail: "AAC sans configuration lisible" });
    if (![2, 5, 29].includes(config.objectType)) return refuse({ reason: "son-codec", detail: `AAC type ${config.objectType}` });
    if (config.channels === 0) return refuse({ reason: "son-aac-pce" });
    const aac = aacHlsPlan(track.codecPrivate as Uint8Array, facts.firstFrames, rate);
    if (aac.kind === "refus") return refuse({ reason: aac.reason, detail: aac.detail });
    if (aac.kind === "sbr-explicite") {
      plan.configuration = aac.configuration;
      plan.sampleRate = aac.sampleRate;
      plan.channels = aac.channels;
      sbrRewritten = true;
    }
    aacCore = aac.core;
  }
  if (dolby) {
    // A/52 définit 48, 44,1 et 32 kHz, et la HLS Authoring Specification ne restreint aucune fréquence (elle
    // n'en nomme aucune) : seule la trame fait foi, et elle doit dire ce que dit le conteneur.
    if (!DOLBY_RATES.has(Math.round(rate))) return refuse({ reason: "son-frequence", detail: `${rate} Hz` });
    const head = facts.firstFrame ? readDolbyHeader(facts.firstFrame) : null;
    if (head && head.sampleRate !== Math.round(rate)) return refuse({ reason: "son-frequence", detail: `conteneur ${rate} Hz, trame ${head.sampleRate} Hz` });
  }
  if (facts.firstUs === null) {
    // Aucun bloc dans la fenêtre lue : la piste commence plus de AUDIO_LATE_PROBE_US après l'image.
    return refuse({ reason: "son-en-retard", detail: `> ${AUDIO_LATE_PROBE_US / 1e6} s` });
  }
  if (dolby && !facts.firstFrame) return refuse({ reason: "son-sans-trame" });
  const gap = audioLeadGapSeconds(videoStartUs / 1e6, facts.firstUs / 1e6);
  const short = lastStartUs !== null && (facts.lastUs === null || facts.lastUs < lastStartUs);
  if (gap === null && !short) return plan;

  // Le silence : la trame d'abord, puis où elle va. Une piste copiée qui commence tard n'a pas de trame pour
  // ses premiers segments, une piste courte pour son dernier, et un rendu doit couvrir toute la durée (2.15).
  const lateReason = (detail: string): LumenRefusal => ({ reason: "son-en-retard", detail: gap !== null ? `${gap.toFixed(2)} s, ${detail}` : detail });
  const shortReason = (detail: string): LumenRefusal => ({ reason: "son-plus-court", detail });
  const refuseSilence = (detail: string) => refuse(gap !== null ? lateReason(`silence impossible : ${detail}`) : shortReason(`silence impossible : ${detail}`));
  let frame: Uint8Array | null = null;
  let frameUs = 0;
  if (dolby) {
    const why = dolbySilenceRefusal(facts.firstFrame as Uint8Array);
    if (why) return refuseSilence(why);
    const head = readDolbyHeader(facts.firstFrame as Uint8Array) as DolbyHeader;
    frame = silentDolbyFrame(facts.firstFrame as Uint8Array);
    frameUs = ((head.blocks * 256) / head.sampleRate) * 1e6;
  } else if (track.codecId === "A_AAC") {
    if (sbrRewritten) return refuseSilence("HE-AAC (trame SBR silencieuse non construite)");
    // « absent » : l'extension de synchronisation dit « pas de SBR » (ce qu'écrit l'encodeur AAC de FFmpeg).
    if (!aacCore || aacCore.coreObjectType !== 2 || (aacCore.sbr !== "non-dit" && aacCore.sbr !== "absent") || aacCore.frameLengthFlag) return refuseSilence("AAC hors AAC-LC 1024");
    frame = silentAacFrame(aacCore.channelConfiguration);
    frameUs = (1024 / AAC_RATES[aacCore.frequencyIndex]) * 1e6;
  } else return refuseSilence(track.codecId);
  if (!frame) return refuseSilence("trame trop petite");

  let tailFromUs: number | null = null;
  if (short) {
    if (!facts.tail) return refuse(shortReason(facts.lastUs === null ? "fin introuvable" : `finit à ${(facts.lastUs / 1e6).toFixed(1)} s`));
    // Après une fenêtre LONG_START ou courte, l'AAC attend des fenêtres courtes ; la trame de silence est longue.
    if (aacCore && silenceMayFollow(facts.tail.lastFrame, aacCore.frequencyIndex) !== true) return refuse(shortReason("dernière trame AAC en fenêtres courtes"));
    tailFromUs = facts.tail.timeUs + facts.tail.frames * frameUs;
  }
  plan.silence = { frame, frameUs, leadUntilUs: gap !== null ? facts.firstUs : null, tailFromUs, endUs };
  return plan;
}

// ── L'index ──────────────────────────────────────────────────────────────────

export interface BuildIndexOptions {
  /** La clé sous laquelle `openMediaFile` garde l'en-tête : l'identité du fichier. */
  headerKey?: string;
  targetUs?: number;
  /** La règle de découpe (`cra` par défaut, depuis les Cues ; `idr` et `cra-leading` sont des essais, §157, §158). */
  cut?: LumenCutMode;
}

/** Ce qu'une source qui compte ses lectures expose (`FileByteSource.stats`). */
interface CountingSource extends ByteSource {
  stats?: { reads: number; bytes: number };
}

function emptyStats(): LumenKeyStats {
  return { cues: 0, verified: 0, rejected: 0, idr: 0, cra: 0, craRasl: 0, leading: 0, cuts: 0, trusted: 0 };
}

/**
 * Construit l'index de `source`. Ne lève pas pour un fichier que Lumen serveur ne sait pas servir :
 * l'index le dit (`refusal`), et `lumenEligibility` le rend. Lève pour une lecture qui échoue (disque).
 */
export async function buildLumenIndex(source: CountingSource, identity: FileIdentity, options: BuildIndexOptions = {}): Promise<LumenIndex> {
  const began = performance.now();
  const reads0 = source.stats?.reads ?? 0;
  const bytes0 = source.stats?.bytes ?? 0;
  const keys = emptyStats();
  const cut = options.cut ?? LUMEN_DEFAULT_CUT;
  const targetUs = options.targetUs ?? LUMEN_TARGET_SEGMENT_US;
  const finish = (index: Omit<LumenIndex, "cost" | "format" | "cut" | "targetUs" | "identity" | "keys">): LumenIndex => ({
    ...index,
    format: LUMEN_FORMAT_VERSION,
    cut,
    targetUs,
    identity,
    keys,
    cost: {
      ms: Math.round(performance.now() - began),
      reads: (source.stats?.reads ?? 0) - reads0,
      bytes: (source.stats?.bytes ?? 0) - bytes0,
    },
  });
  const refused = (container: LumenIndex["container"], durationUs: number, refusal: LumenRefusal, video: LumenVideoTrack | null = null): LumenIndex =>
    finish({ container, durationUs, video, audio: [], delayUs: 0, frameUs: FALLBACK_FRAME_US, frameRate: 0, segments: [], bandwidth: { peak: 0, average: 0 }, refusal, inits: { video: null, audio: {} } });

  let file: MatroskaFile;
  try {
    file = await openMediaFile(source, options.headerKey ?? identityKey(identity));
  } catch (error) {
    return refused("matroska", 0, { reason: "lecture-impossible", detail: error instanceof Error ? error.message : String(error) });
  }
  const container = file.mp4 ? "mp4" : "matroska";
  const durationUs = Math.round((file.durationSeconds ?? 0) * 1e6);

  // ── La vidéo ──
  const videoTracks = file.tracks.filter((t) => t.type === "video");
  const vTrack = videoTracks.find((t) => t.codecId === "V_MPEGH/ISO/HEVC" || t.codecId === "V_MPEG4/ISO/AVC");
  if (!vTrack) {
    return videoTracks.length === 0
      ? refused(container, durationUs, { reason: "pas-de-video" })
      : refused(container, durationUs, { reason: "video-codec", detail: videoTracks[0].codecId });
  }
  if (!vTrack.codecPrivate) return refused(container, durationUs, { reason: "video-codec", detail: "sans configuration" });
  const video: LumenVideoTrack = {
    number: vTrack.number,
    codecId: vTrack.codecId,
    codecPrivate: vTrack.codecPrivate,
    width: vTrack.video?.width ?? 1920,
    height: vTrack.video?.height ?? 1080,
    colour: vTrack.video?.colour,
    dolbyVision: vTrack.dolbyVision,
    lengthSize: nalLengthSize(vTrack.codecId, vTrack.codecPrivate),
    signal: hlsVideoSignal(vTrack),
  };
  if (!video.signal) return refused(container, durationUs, { reason: "video-codec", detail: "enregistrement illisible" }, video);
  const dv = vTrack.dolbyVision ? dolbyVisionInfo(vTrack.dolbyVision.record) : null;
  // Profil 5 : aucune base lisible sans Dolby Vision, donc aucun repli sur un appareil qui ne l'a pas.
  // Profil 7 : couche d'amélioration dans le flux, qu'aucun appareil Apple ne lit, et que rien ici ne
  // retire encore. Aucun des deux n'est sûr ; ils restent au lecteur actuel (2 fichiers et 0 ici).
  if (dv?.profile === 5) return refused(container, durationUs, { reason: "dolby-vision-5" }, video);
  if (dv?.profile === 7) return refused(container, durationUs, { reason: "dolby-vision-7" }, video);

  // ── Les clés ──
  if (!file.mp4 && !file.cues.some((c) => c.track === video.number)) {
    return refused(container, durationUs, { reason: "pas-d-index", detail: file.cues.length ? "index sans la piste vidéo" : "aucun Cues" }, video);
  }
  const candidates = candidatesOf(file, video);
  keys.cues = candidates.length;
  const verify = (c: Candidate) => (file.mp4 ? verifyMp4Key(source, file, video, c.at) : verifyMatroskaKey(source, file, video, c.at));
  // `idr` : chaque point dont la découpe a besoin est lu ; `cra` et `cra-leading` : l'index des Cues.
  const cuts: CutPoint[] =
    cut === "idr" ? (await selectCuts(candidates, targetUs, verify, keys, cut)).map((k) => ({ timeUs: k.timeUs, at: k.at })) : await trustedCuts(candidates, targetUs, verify, keys, cut);
  keys.cuts = cuts.length;
  if (cuts.length === 0) return refused(container, durationUs, { reason: "index-invalide", detail: `${keys.cues} points, aucun admis` }, video);

  // ── La découpe et D ──
  // D se mesure sur le premier groupe, et la découpe a besoin de la durée d'une image pour finir le
  // dernier segment : le premier groupe est lu d'abord, sur la première coupe.
  // Les coupes sont déjà espacées d'au moins la cible : `planSegments` les prend toutes (cible 0).
  const provisional = planSegments(cuts, durationUs, FALLBACK_FRAME_US, 0);
  const { delayUs, frameUs, frameRate } = presentationDelayOf(await firstGroupPresentations(source, file, video, provisional[0]));
  const segments = planSegments(cuts, durationUs, frameUs, 0);
  fillBytes(segments, file, video);

  let refusal: LumenRefusal | null = null;
  const longest = segments.reduce((m, s) => Math.max(m, s.endUs - s.startUs), 0);
  const heaviest = segments.reduce((m, s) => Math.max(m, s.bytes), 0);
  // Sous l'index des Cues, un segment trop long ne peut venir que d'un trou dans l'index (toute clé
  // indexée est une coupe) : la raison le dit, la vérification point par point n'y changerait rien.
  const gap = cut === "idr" ? 0 : largestCueGap(candidates, durationUs);
  if (longest > LUMEN_MAX_SEGMENT_US && gap > LUMEN_MAX_SEGMENT_US - targetUs) refusal = { reason: "index-troue", detail: `${(gap / 1e6).toFixed(1)} s sans point d'index` };
  else if (longest > LUMEN_MAX_SEGMENT_US) refusal = { reason: "segment-trop-long", detail: `${(longest / 1e6).toFixed(1)} s` };
  else if (heaviest > LUMEN_MAX_SEGMENT_BYTES) refusal = { reason: "segment-trop-lourd", detail: `${(heaviest / 1048576).toFixed(0)} Mo` };

  // ── Le son ──
  const audioTracks = file.tracks.filter((t) => t.type === "audio");
  const facts = await probeAudioStarts(source, file, video, audioTracks);
  const last = segments[segments.length - 1];
  await probeAudioEnds(source, file, last, facts);
  const endUs = Math.max(durationUs, last.endUs);
  const lastStartUs = segments.length > 1 ? last.startUs : null;
  // Une piste absente du dernier segment : son dernier bloc, en remontant (seulement pour elle).
  for (const t of audioTracks) {
    const f = facts.get(t.number) as AudioFacts;
    if (lastStartUs !== null && (COPYABLE_AUDIO.has(t.codecId) || CONVERT_CODECS[t.codecId]) && (f.lastUs === null || f.lastUs < lastStartUs)) await probeAudioTail(source, file, segments, t.number, f);
  }
  const audio: LumenAudioTrack[] = audioTracks.map((t) => {
    const f = facts.get(t.number) as AudioFacts;
    const plan = audioPlan(t, f, segments[0].keyUs, lastStartUs, endUs);
    const signal = plan.refusal ? null : hlsAudioSignal(t, f.firstFrame, plan.configuration);
    // Une piste non copiable : ses faits de conversion (§161), gardés par l'index quelle que soit l'option — la vue
    // `withConversion` décide à chaque requête. Le refus `son-codec` reste celui de l'index.
    const short = lastStartUs !== null && (f.lastUs === null || f.lastUs < lastStartUs);
    const conversion =
      plan.refusal?.reason === "son-codec" && CONVERT_CODECS[t.codecId]
        ? convertSourceOf(
            { codecId: t.codecId, codecPrivate: t.codecPrivate, channels: t.audio?.channels ?? 2, sampleRate: t.audio?.sampleRate ?? 48000 },
            { firstUs: f.firstUs, firstFrame: f.firstFrame, lastBlockUs: short ? (f.tail?.timeUs ?? null) : null },
            container
          )
        : null;
    return {
      number: t.number,
      codecId: t.codecId,
      codecPrivate: t.codecPrivate,
      language: t.language,
      name: t.name,
      isDefault: t.isDefault,
      isForced: t.isForced,
      channels: plan.channels,
      sampleRate: plan.sampleRate,
      firstFrame: f.firstFrame,
      firstUs: f.firstUs,
      // Seulement quand il y a quelque chose à dire : une piste servie comme avant garde la forme d'avant.
      ...(plan.configuration ? { configuration: plan.configuration } : {}),
      ...(plan.silence ? { silence: plan.silence } : {}),
      ...(conversion?.ok ? { convert: conversion.source } : conversion ? { convertRefusal: conversion.detail } : {}),
      signal,
      refusal: plan.refusal ?? (signal ? null : { reason: "son-codec", detail: "signalisation illisible" }),
    };
  });

  // ── Les init segments ──
  const durationSeconds = endUs / 1e6;
  const videoInit = initSegment(
    {
      id: VIDEO_TRACK_ID,
      kind: "video",
      timescale: LUMEN_TIMESCALE,
      sampleEntry: videoSampleEntry(video.codecId, video.codecPrivate, video.width, video.height, video.dolbyVision ?? null, video.colour, { signalling: "hls" }),
      width: video.width,
      height: video.height,
      language: "und",
    },
    durationSeconds
  );
  const audioInits: Record<number, Uint8Array> = {};
  for (const a of audio) {
    if (a.refusal) continue;
    try {
      audioInits[a.number] = initSegment(
        {
          id: AUDIO_TRACK_ID,
          kind: "audio",
          timescale: LUMEN_TIMESCALE,
          sampleEntry: audioSampleEntryFor(
            { codecId: a.codecId, codecPrivate: a.configuration ?? a.codecPrivate, channels: a.channels, sampleRate: a.sampleRate, firstFrame: a.firstFrame },
            { signalling: "hls" }
          ),
          width: 0,
          height: 0,
          language: a.language ?? "und",
        },
        durationSeconds
      );
    } catch (error) {
      a.refusal = { reason: "son-codec", detail: error instanceof Error ? error.message : String(error) };
      a.signal = null;
    }
  }

  const totalBytes = segments.reduce((sum, s) => sum + s.bytes, 0);
  const totalUs = segments.reduce((sum, s) => sum + (s.endUs - s.startUs), 0);
  const peak = segments.reduce((m, s) => Math.max(m, (s.bytes * 8) / Math.max(0.001, (s.endUs - s.startUs) / 1e6)), 0);
  return finish({
    container,
    durationUs: endUs,
    video,
    audio,
    delayUs,
    frameUs,
    // La durée par défaut du Matroska (à la nanoseconde) quand le fichier la donne : la moyenne d'un
    // groupe d'une seconde à la milliseconde ne sépare pas 23,976 de 24 (±0,1 %).
    frameRate: vTrack.defaultDurationNs ? 1e9 / vTrack.defaultDurationNs : frameRate,
    segments,
    bandwidth: { peak: Math.round(peak), average: Math.round((totalBytes * 8) / Math.max(0.001, totalUs / 1e6)) },
    refusal,
    inits: { video: videoInit, audio: audioInits },
  });
}

/**
 * Le poids de chaque segment, sans lire un octet de média. Matroska : d'une grappe de coupe à la
 * suivante — toutes pistes comprises, donc un majorant du débit d'une variante. MP4 : la somme exacte
 * des échantillons vidéo et audio de la plage, depuis l'index.
 */
function fillBytes(segments: LumenSegment[], file: MatroskaFile, video: LumenVideoTrack): void {
  if (!file.mp4) {
    segments.forEach((s, i) => (s.bytes = (i + 1 < segments.length ? segments[i + 1].at : file.segmentEnd) - s.at));
    return;
  }
  const v = file.mp4.tracks.find((t) => t.number === video.number);
  if (!v) return;
  segments.forEach((s, i) => {
    const to = i + 1 < segments.length ? segments[i + 1].at : v.sizes.length;
    let bytes = 0;
    for (let k = s.at; k < to; k++) bytes += v.sizes[k];
    s.bytes = bytes;
  });
  // Le son : chaque piste, à sa place dans le temps (une seule sera servie, mais on ne sait pas laquelle).
  for (const t of file.mp4.tracks) {
    if (t.number === video.number) continue;
    let k = 0;
    for (const s of segments) {
      const endUs = s === segments[segments.length - 1] ? Infinity : s.endUs;
      while (k < t.dtsUs.length && t.dtsUs[k] < endUs) s.bytes += t.sizes[k++];
    }
  }
}
