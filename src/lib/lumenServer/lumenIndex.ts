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
// **Les découpes expérimentales `cra` et `cra-leading`** (étape 3b, DECISIONS.md §157, choisies par
// l'adresse, administrateur seul) admettent aussi une CRA suivie de RASL : la seule différence est dans
// `isCut`. Tout le reste — vérification des clés, D, son, poids — est le même code.

import type { ByteSource } from "../webcodecs/byteSource";
import { openMediaFile } from "../webcodecs/mediaFile";
import type { MatroskaFile, MatroskaTrack } from "../webcodecs/matroska";
import { dolbyVisionInfo, isRandomAccessPoint, isRaslPicture, nalLengthSize } from "../webcodecs/codecConfig";
import { assignDecodeTimes, deriveDurations } from "../webcodecs/decodeOrder";
import { audioSampleEntryFor, parseAacConfig, videoSampleEntry } from "../webcodecs/mp4SampleEntries";
import { initSegment } from "../webcodecs/mp4Muxer";
import { AUDIO_LEAD_GAP_SECONDS, audioLeadGapSeconds } from "../webcodecs/audioLeadGap";
import { hlsAudioSignal, hlsVideoSignal } from "./hlsSignal";
import { readBlockSamples, sketchPicture, walkBlocks, type BlockHead, type PictureSketch } from "./mkvBlocks";
import { planSegments, type CutPoint } from "./plan";
import {
  AUDIO_TRACK_ID,
  DELAY_MARGIN_FRAMES,
  FALLBACK_FRAME_US,
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
 * La clé peut-elle ouvrir un segment ? Sous `idr`, jamais une CRA à RASL ; sous `cra`/`cra-leading`, si :
 * ses RASL restent dans le segment qu'elle ouvre. L'I H.264 à images de tête reste refusée partout —
 * rien dans un flux H.264 ne nomme ces images, aucun décodeur ne saura les jeter seul.
 */
export function isCut(key: VerifiedKey, cut: LumenCutMode = "idr"): boolean {
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
  cut: LumenCutMode = "idr"
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
      stats.verified += 1;
      if (!key) stats.rejected += 1;
      else {
        if (key.kind === "idr") stats.idr += 1;
        if (key.kind === "cra") stats.cra += 1;
        if (key.rasl) stats.craRasl += 1;
        if (key.leading) stats.leading += 1;
      }
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

interface AudioFacts {
  firstUs: number | null;
  firstFrame: Uint8Array | null;
  /** L'instant du dernier bloc vu à partir du dernier segment, ou null. */
  lastUs: number | null;
}

/** Le premier bloc de chaque piste audio, en lisant les en-têtes depuis le début du film. */
async function probeAudioStarts(source: ByteSource, file: MatroskaFile, video: LumenVideoTrack, tracks: MatroskaTrack[]): Promise<Map<number, AudioFacts>> {
  const facts = new Map<number, AudioFacts>(tracks.map((t) => [t.number, { firstUs: null, firstFrame: null, lastUs: null }]));
  if (tracks.length === 0) return facts;
  if (file.mp4) {
    for (const t of tracks) {
      const index = file.mp4.tracks.find((x) => x.number === t.number);
      if (!index || index.dtsUs.length === 0) continue;
      facts.set(t.number, {
        firstUs: index.dtsUs[0] + (index.ctsUs?.[0] ?? 0),
        firstFrame: await source.read(index.offsets[0], index.sizes[0]),
        lastUs: index.dtsUs[index.dtsUs.length - 1] + (index.ctsUs?.[index.dtsUs.length - 1] ?? 0),
      });
    }
    return facts;
  }
  let missing = tracks.length;
  let firstVideoUs: number | null = null;
  await walkBlocks(source, file, file.firstClusterOffset ?? file.segmentDataStart, async (head) => {
    if (head.track === video.number) {
      firstVideoUs ??= head.timeUs;
      return firstVideoUs !== null && head.timeUs > firstVideoUs + AUDIO_PROBE_US ? "stop" : "continue";
    }
    const f = facts.get(head.track);
    if (!f || f.firstUs !== null) return "continue";
    // Le premier échantillon, comme `probeTrackStart` du remuxeur : c'est lui qui décrit l'AC-3/E-AC-3.
    const [sample] = await readBlockSamples(source, file, head);
    f.firstUs = head.timeUs;
    f.firstFrame = sample?.data ? new Uint8Array(sample.data) : null;
    return --missing === 0 ? "stop" : "continue";
  });
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
 * Pourquoi une piste audio ne peut pas être copiée dans le HLS, ou null.
 *
 * Copiables (4-son-compat.md §4.1, HLS Authoring Specification 2.2, 2.5, 2.25) : AAC-LC et HE-AAC à
 * SBR explicite (règle 2.24 : l'implicite est interdit en fMP4), AC-3 et E-AC-3 (Atmos compris, la
 * signalisation de l'étape 1), FLAC (cité par Apple en stéréo et multicanal, fMP4 obligatoire — ce
 * que le remuxeur écrit). Pas Opus (absent de la spécification), ni DTS, TrueHD, MP2, PCM.
 * Refusé par prudence, en attendant un banc sur appareil (« doute » du recensement) : un AAC dont la
 * disposition est un PCE (§62 : un 5.1 que CoreAudio refuse), un AC-3/E-AC-3 hors 48 kHz.
 */
function audioRefusal(track: MatroskaTrack, facts: AudioFacts | undefined, videoStartUs: number, lastStartUs: number | null): LumenRefusal | null {
  if (!COPYABLE_AUDIO.has(track.codecId)) return { reason: "son-codec", detail: track.codecId };
  const rate = track.audio?.sampleRate ?? 48000;
  if (track.codecId === "A_AAC") {
    const config = track.codecPrivate ? parseAacConfig(track.codecPrivate) : null;
    if (!config) return { reason: "son-codec", detail: "AAC sans configuration lisible" };
    if (![2, 5, 29].includes(config.objectType)) return { reason: "son-codec", detail: `AAC type ${config.objectType}` };
    if (config.channels === 0) return { reason: "son-aac-pce" };
    // Un LC dont la fréquence est la moitié de celle du conteneur : du HE-AAC à SBR implicite.
    if (config.objectType === 2 && Math.round(rate) === config.sampleRate * 2) return { reason: "son-aac-sbr-implicite" };
  }
  if ((track.codecId === "A_AC3" || track.codecId === "A_EAC3") && Math.round(rate) !== 48000) return { reason: "son-frequence", detail: `${rate} Hz` };
  if (!facts || facts.firstUs === null) {
    // Aucun bloc dans la fenêtre lue : la piste commence plus de AUDIO_PROBE_US après l'image.
    return { reason: "son-en-retard", detail: `> ${AUDIO_PROBE_US / 1e6} s` };
  }
  const gap = audioLeadGapSeconds(videoStartUs / 1e6, facts.firstUs / 1e6);
  // Une piste copiée qui commence tard n'a pas de trame pour ses premiers segments, et un rendu doit
  // couvrir toute la durée (règle 2.15) : du silence devant, c'est la phase 2 (conversion).
  if (gap !== null) return { reason: "son-en-retard", detail: `${gap.toFixed(2)} s` };
  if ((track.codecId === "A_AC3" || track.codecId === "A_EAC3") && !facts.firstFrame) return { reason: "son-sans-trame" };
  if (lastStartUs !== null && (facts.lastUs === null || facts.lastUs < lastStartUs)) {
    return { reason: "son-plus-court", detail: facts.lastUs === null ? "absente du dernier segment" : `finit à ${(facts.lastUs / 1e6).toFixed(1)} s` };
  }
  return null;
}

// ── L'index ──────────────────────────────────────────────────────────────────

export interface BuildIndexOptions {
  /** La clé sous laquelle `openMediaFile` garde l'en-tête : l'identité du fichier. */
  headerKey?: string;
  targetUs?: number;
  /** La règle de découpe (`idr` par défaut ; les deux autres sont expérimentales, §157). */
  cut?: LumenCutMode;
}

/** Ce qu'une source qui compte ses lectures expose (`FileByteSource.stats`). */
interface CountingSource extends ByteSource {
  stats?: { reads: number; bytes: number };
}

function emptyStats(): LumenKeyStats {
  return { cues: 0, verified: 0, rejected: 0, idr: 0, cra: 0, craRasl: 0, leading: 0, cuts: 0 };
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
  const cut = options.cut ?? "idr";
  const finish = (index: Omit<LumenIndex, "cost" | "format" | "cut" | "identity" | "keys">): LumenIndex => ({
    ...index,
    format: LUMEN_FORMAT_VERSION,
    cut,
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
  const targetUs = options.targetUs ?? LUMEN_TARGET_SEGMENT_US;
  const verify = (c: Candidate) => (file.mp4 ? verifyMp4Key(source, file, video, c.at) : verifyMatroskaKey(source, file, video, c.at));
  const chosen = await selectCuts(candidates, targetUs, verify, keys, cut);
  const cuts: CutPoint[] = chosen.map((k) => ({ timeUs: k.timeUs, at: k.at }));
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
  if (longest > LUMEN_MAX_SEGMENT_US) refusal = { reason: "segment-trop-long", detail: `${(longest / 1e6).toFixed(1)} s` };
  else if (heaviest > LUMEN_MAX_SEGMENT_BYTES) refusal = { reason: "segment-trop-lourd", detail: `${(heaviest / 1048576).toFixed(0)} Mo` };

  // ── Le son ──
  const audioTracks = file.tracks.filter((t) => t.type === "audio");
  const facts = await probeAudioStarts(source, file, video, audioTracks);
  const last = segments[segments.length - 1];
  await probeAudioEnds(source, file, last, facts);
  const audio: LumenAudioTrack[] = audioTracks.map((t) => {
    const f = facts.get(t.number);
    const trackRefusal = audioRefusal(t, f, segments[0].keyUs, segments.length > 1 ? last.startUs : null);
    const signal = trackRefusal ? null : hlsAudioSignal(t, f?.firstFrame ?? null);
    return {
      number: t.number,
      codecId: t.codecId,
      codecPrivate: t.codecPrivate,
      language: t.language,
      name: t.name,
      isDefault: t.isDefault,
      isForced: t.isForced,
      channels: t.audio?.channels ?? 2,
      sampleRate: t.audio?.sampleRate ?? 48000,
      firstFrame: f?.firstFrame ?? null,
      firstUs: f?.firstUs ?? null,
      signal,
      refusal: trackRefusal ?? (signal ? null : { reason: "son-codec", detail: "signalisation illisible" }),
    };
  });

  // ── Les init segments ──
  const durationSeconds = Math.max(durationUs, last.endUs) / 1e6;
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
            { codecId: a.codecId, codecPrivate: a.codecPrivate, channels: a.channels, sampleRate: a.sampleRate, firstFrame: a.firstFrame },
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
    durationUs: Math.max(durationUs, last.endUs),
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
