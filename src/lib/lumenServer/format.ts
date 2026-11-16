// Ce que produit Lumen serveur, et sous quelle version (étape 2 du chantier, docs/remux-serveur/).
//
// Tout ce fichier tient en une promesse : **une adresse servie hier donne demain les mêmes octets**.
// Le conteneur est recréé plusieurs fois par jour ; une Apple TV qui joue garde l'init segment et la
// liste d'avant le déploiement et demande les segments suivants au code d'après. Si la découpe, le
// délai de présentation, les identifiants de piste ou l'ordre des boîtes changent entre les deux, les
// segments ne se recollent plus — sans erreur nette, une image qui saute ou un son décalé. La version
// du format est donc portée par chaque adresse (étape 3), et **toute règle qui change un octet produit
// ou une frontière de segment la fait monter** (DECISIONS.md §155).
//
// Code pur, sans Node : importé par le fil principal, le fil de calcul et les tests.

import type { HlsAudioSignal, HlsVideoSignal } from "./hlsSignal";
import type { TrackColour } from "../webcodecs/matroska";

/**
 * La version du format produit. À monter quand change : la règle de découpe (cible, points de coupe
 * admis), le calcul du délai D, la forme des init segments ou des fragments (identifiants de piste,
 * échelle de temps, numérotation `mfhd`, découpe en fragments), la règle d'appartenance des trames
 * audio à un segment. Ne la change pas : une correction de liste maître qui ne touche ni les
 * frontières ni les octets des segments (un attribut ajouté), un nouveau motif de refus d'éligibilité.
 */
export const LUMEN_FORMAT_VERSION = 1;

// ── La règle de découpe ──────────────────────────────────────────────────────

/**
 * La règle qui dit sur quelles images clés un segment peut commencer (DECISIONS.md §155, §157).
 *
 * - **`idr`** — la règle, la seule que sert un appelant qui ne demande rien : une clé dont un décodeur
 *   repart seul sans rien perdre (IDR, BLA, CRA *sans* RASL, I H.264 sans images de tête).
 * - **`cra`** — expérimentale (étape 3b) : une CRA suivie de RASL ouvre aussi un segment, et ses RASL
 *   sont **gardées** dans ce segment. En lecture continue, leurs références sont à la fin du segment
 *   précédent, déjà décodé ; après un saut, c'est au décodeur de les jeter (H.265 §8.1.3,
 *   `NoRaslOutputFlag` = 1 sur une CRA qui ouvre un accès aléatoire). Safari sous MediaSource ne l'a
 *   jamais fait (*Ted Lasso* S02E01, « Media failed to decode ») ; le HLS natif passe par AVFoundation,
 *   un autre chemin — c'est ce que la page `/lumen-test` doit montrer sur un appareil Apple. Recensement
 *   du 16/11/2026 (300 fichiers, extrapolé à la bibliothèque) : 40 % des fichiers sont à GOP ouvert, 93 %
 *   d'entre eux sont refusés sous `idr` (`segment-trop-long`) ; sous `cra`, 88 % de la bibliothèque est
 *   servable contre 57 %.
 * - **`cra-leading`** — `cra`, et chaque image non clé nommée dans ses `sample_flags` (`is_leading`,
 *   ISO/IEC 14496-12 §8.8.3.1) : RASL 1 (image de tête qui dépend d'avant la clé, non décodable après un
 *   accès aléatoire), RADL 3 (image de tête décodable), toute autre 2. L'indication qu'un démultiplexeur
 *   (AVFoundation) peut lire sans analyser le flux pour jeter les RASL après un saut — sans elle, le muxer
 *   écrit 0, « inconnu ». À comparer à `cra` sur les mêmes sauts.
 *
 * Les deux modes expérimentaux portent leur propre version de format (`lumenFormatTag`) : ils changent
 * des frontières de segment et des octets, et rien — cache d'index en mémoire ou sur le disque, segments
 * gardés, cache du navigateur — ne doit mélanger deux découpes du même fichier.
 */
export type LumenCutMode = "idr" | "cra" | "cra-leading";
export const LUMEN_CUT_MODES: readonly LumenCutMode[] = ["idr", "cra", "cra-leading"];

/**
 * La révision des modes expérimentaux : à monter quand leur règle change sans que la règle `idr` change
 * (sinon c'est `LUMEN_FORMAT_VERSION` qui monte, et elle les entraîne).
 */
export const LUMEN_CRA_REVISION = 1;

const CUT_LETTER: Record<Exclude<LumenCutMode, "idr">, string> = { cra: "c", "cra-leading": "l" };

/**
 * La version de format d'une découpe, telle que l'adresse et les clés de cache la portent : `"1"` pour
 * `idr` — exactement l'ancienne, pour qu'aucune adresse servie ni aucun index gardé ne change —, `"1c1"`
 * pour `cra`, `"1l1"` pour `cra-leading`.
 */
export function lumenFormatTag(cut: LumenCutMode): string {
  return cut === "idr" ? `${LUMEN_FORMAT_VERSION}` : `${LUMEN_FORMAT_VERSION}${CUT_LETTER[cut]}${LUMEN_CRA_REVISION}`;
}

/** Le pendant : la découpe que nomme une version de format, ou null (une autre version, un autre format). */
export function cutModeOfTag(tag: string): LumenCutMode | null {
  for (const cut of LUMEN_CUT_MODES) if (lumenFormatTag(cut) === tag) return cut;
  return null;
}

/** `?cut=` tel qu'une adresse le porte : un mode connu, `undefined` (la règle), ou null (mal formé). */
export function parseCutMode(raw: string | null | undefined): LumenCutMode | undefined | null {
  if (raw === null || raw === undefined || raw === "") return undefined;
  return (LUMEN_CUT_MODES as readonly string[]).includes(raw) ? (raw as LumenCutMode) : null;
}

/**
 * La durée visée pour un segment. Recommandation de l'étude (1-remuxeur.md §1.2, mesurée sur quatre
 * fichiers à 2, 4 et 6 s) : 4 s donne une médiane de 5 à 9 s sur les fichiers à groupes d'images
 * longs et garde les sauts bon marché ailleurs. Apple conseille 6 s (règle 7.5, un « SHOULD ») :
 * plus court, c'est un saut moins cher, et une liste de 1 800 segments pour deux heures.
 */
export const LUMEN_TARGET_SEGMENT_US = 4_000_000;

/**
 * Au-delà, le fichier n'est pas servi par Lumen serveur (`segment-trop-long`). Un segment ne descend
 * pas sous un groupe d'images, et un groupe tenu en mémoire pendant sa construction coûte environ deux
 * fois sa taille dans un conteneur de 2 Gio (2-serveur.md §2.4). *The Exorcist* (un groupe toutes les
 * 10,4 s) culmine à 14,4 s ; 30 s laisse passer ces fichiers et arrête le cas pathologique — un H.264
 * à une seule IDR par épisode dont les autres clés auraient des images de tête.
 */
export const LUMEN_MAX_SEGMENT_US = 30_000_000;

/**
 * Au-delà de ce poids estimé (octets entre deux grappes de coupe), même refus (`segment-trop-lourd`),
 * pour la même raison : la mémoire d'une construction. 160 Mo, c'est 30 s à plus de 40 Mb/s — un 4K
 * sur un groupe d'images très long ; le pire mesuré à l'étude était 19,9 Mo.
 */
export const LUMEN_MAX_SEGMENT_BYTES = 160 * 1024 * 1024;

/** Le délai ajouté au délai de réordonnancement mesuré, en images — `DELAY_MARGIN_FRAMES` du remuxeur. */
export const DELAY_MARGIN_FRAMES = 3;

/** La durée d'une image quand rien ne la donne : 24 i/s — `FALLBACK_FRAME_US` du remuxeur. */
export const FALLBACK_FRAME_US = 41_667;

/** La durée d'une trame audio quand rien ne la mesure : 1536 échantillons à 48 kHz — `FALLBACK_AUDIO_FRAME_US`. */
export const FALLBACK_AUDIO_FRAME_US = 32_000;

/**
 * Les bornes d'un fragment (moof+mdat) dans un segment : celles du remuxeur (`FRAGMENT_BYTES`,
 * `FRAGMENT_SAMPLES`, `remuxer.ts`). Elles venaient d'un refus de Safari MSE (un fragment de 5,5 Mo
 * fermait la MediaSource) ; inutile de découvrir si le démultiplexeur HLS a la même limite. Un test
 * compare `fragmentRanges` à `planFragments` du remuxeur sur les mêmes formes.
 */
export const FRAGMENT_BYTES = 1_200_000;
export const FRAGMENT_SAMPLES = 60;

/** L'échelle de temps de toutes les pistes : la microseconde, celle du remuxeur et du Matroska. */
export const LUMEN_TIMESCALE = 1_000_000;

/** Les identifiants de piste écrits dans les init segments — ceux du remuxeur, vidéo 1, son 2. */
export const VIDEO_TRACK_ID = 1;
export const AUDIO_TRACK_ID = 2;

/**
 * `mfhd` sans état : `N × 1000 + rang du fragment + 1`. Strictement croissant d'un segment à l'autre
 * et calculable pour un segment produit seul. Mille fragments par segment au plus : à 1,2 Mo, c'est
 * 1,2 Go — bien au-delà de `LUMEN_MAX_SEGMENT_BYTES`.
 */
export const SEQUENCE_STRIDE = 1000;

// ── Identité d'un fichier ────────────────────────────────────────────────────

/**
 * Ce qui nomme une version d'un fichier sur le disque. Un fichier remplacé par Radarr, Sonarr ou
 * FileFlows change au moins de `mtime` (et d'inode : ils écrivent à côté puis renomment) ; l'index
 * gardé est alors relu. Vérifié par un `stat` à chaque requête (2-serveur.md §2.1).
 */
export interface FileIdentity {
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

export function identityKey(identity: FileIdentity): string {
  return `${identity.path}|${identity.size}|${identity.mtimeMs}|${identity.ino}`;
}

// ── L'index d'un fichier ─────────────────────────────────────────────────────

/** Ce qu'est une image clé de l'index, lue dans ses unités NAL. */
export type KeyKind = "idr" | "bla" | "cra" | "i-recovery" | "autre";

/** Un segment de la liste. Les bornes nominales sont celles des listes (EXTINF) et du son. */
export interface LumenSegment {
  /** Début nominal (µs, temps du fichier) : 0 pour le premier, l'instant de sa clé ensuite. */
  startUs: number;
  /** Fin nominale : le début du suivant, la durée du fichier pour le dernier. */
  endUs: number;
  /** L'instant de présentation de l'image clé qui ouvre le segment. */
  keyUs: number;
  /** Matroska : la grappe de cette clé. MP4 : le rang de cette clé parmi les échantillons vidéo. */
  at: number;
  /** Octets estimés (toutes pistes en Matroska, d'une grappe de coupe à la suivante). */
  bytes: number;
}

/** Un motif de refus, stable : l'étape 4 le journalise et laisse le lecteur actuel prendre le fichier. */
export type LumenRefusalReason =
  | "lecture-impossible"
  | "pas-de-video"
  | "video-codec"
  | "dolby-vision-5"
  | "dolby-vision-7"
  | "pas-d-index"
  | "index-invalide"
  | "segment-trop-long"
  | "segment-trop-lourd"
  | "son-codec"
  | "son-aac-pce"
  | "son-aac-sbr-implicite"
  | "son-frequence"
  | "son-sans-trame"
  | "son-en-retard"
  | "son-plus-court"
  | "piste-inconnue";

export interface LumenRefusal {
  reason: LumenRefusalReason;
  /** Le détail lisible (codec, durée…), pour le journal. Jamais comparé : seul `reason` l'est. */
  detail?: string;
}

export interface LumenVideoTrack {
  number: number;
  codecId: string;
  /** L'enregistrement écrit dans l'init — `hvcC` complété depuis le flux s'il le fallait. */
  codecPrivate: Uint8Array;
  width: number;
  height: number;
  colour?: TrackColour;
  dolbyVision?: { type: string; record: Uint8Array };
  /** Taille des préfixes de longueur NAL. */
  lengthSize: number;
  signal: HlsVideoSignal | null;
}

export interface LumenAudioTrack {
  number: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
  language: string | null;
  name: string | null;
  isDefault: boolean;
  isForced: boolean;
  channels: number;
  sampleRate: number;
  /** Le premier échantillon de la piste dans le fichier — celui qui décrit `dac3`/`dec3`. */
  firstFrame: Uint8Array | null;
  /** L'instant de ce premier échantillon (µs), ou null s'il n'a pas été trouvé dans la fenêtre lue. */
  firstUs: number | null;
  signal: HlsAudioSignal | null;
  /** Pourquoi cette piste ne peut pas être servie, ou null. */
  refusal: LumenRefusal | null;
}

export interface LumenKeyStats {
  /** Points d'index vidéo (Matroska : un par grappe ; MP4 : échantillons synchrones). */
  cues: number;
  /**
   * Points vérifiés : seulement ceux dont la découpe a eu besoin (`selectCuts`), pas tous. Les
   * compteurs qui suivent portent sur eux.
   */
  verified: number;
  /** Points sans image d'accès aléatoire dans leur grappe (l'index ment). */
  rejected: number;
  idr: number;
  cra: number;
  /** CRA suivies d'images RASL : jamais une coupe. */
  craRasl: number;
  /** Clés H.264 non IDR (point de reprise) suivies d'images de tête : jamais une coupe. */
  leading: number;
  /** Points de coupe admis. */
  cuts: number;
}

/** Ce que l'index d'un fichier dit, une fois pour toutes les requêtes. Sérialisable (clonage structuré). */
export interface LumenIndex {
  format: number;
  /** La règle de découpe qui a produit `segments` (`idr` sauf demande expresse). */
  cut: LumenCutMode;
  identity: FileIdentity;
  container: "matroska" | "mp4";
  durationUs: number;
  video: LumenVideoTrack | null;
  audio: LumenAudioTrack[];
  /** Le délai de présentation D (µs), le même pour tout le fichier et toutes les pistes. */
  delayUs: number;
  /** La durée d'une image (µs) selon la formule du remuxeur (la première du premier groupe) : D et repli. */
  frameUs: number;
  /**
   * Images par seconde, moyennées sur le premier groupe — `FRAME-RATE`. Pas `1 / frameUs` : un
   * Matroska à la milliseconde alterne 41 et 42 ms pour du 23,976, et une seule durée dirait 23,810.
   */
  frameRate: number;
  segments: LumenSegment[];
  keys: LumenKeyStats;
  /** Débit de crête et moyen (bit/s), estimés depuis l'index : BANDWIDTH et AVERAGE-BANDWIDTH. */
  bandwidth: { peak: number; average: number };
  /** Pourquoi la vidéo ne peut pas être servie (et donc le fichier), ou null. */
  refusal: LumenRefusal | null;
  /** Les init segments, déjà construits : quelques Ko. */
  inits: { video: Uint8Array | null; audio: Record<number, Uint8Array> };
  /** Ce qu'a coûté la construction de l'index, pour le journal. */
  cost: { ms: number; reads: number; bytes: number };
}

// ── Les noms servis ──────────────────────────────────────────────────────────

/** Une piste servie : la vidéo, ou une piste audio par son numéro dans le fichier. */
export type LumenRendition = { kind: "video" } | { kind: "audio"; track: number };

/**
 * Le nom d'un fichier servi, relatif à la liste maître : `v.m3u8`, `init-v.mp4`, `v/12.m4s`, et pour
 * la piste audio 3 `a3.m3u8`, `init-a3.mp4`, `a3/12.m4s`. Les noms naturels, sans détour pour
 * CrowdSec : décision du 16/11/2026, contre la décision 4 de la conception.
 */
export function renditionTag(rendition: LumenRendition): string {
  return rendition.kind === "video" ? "v" : `a${rendition.track}`;
}

export function playlistName(rendition: LumenRendition): string {
  return `${renditionTag(rendition)}.m3u8`;
}

export function initName(rendition: LumenRendition): string {
  return `init-${renditionTag(rendition)}.mp4`;
}

export function segmentName(rendition: LumenRendition, n: number): string {
  return `${renditionTag(rendition)}/${n}.m4s`;
}

export type LumenPath =
  | { kind: "master" }
  | { kind: "playlist"; rendition: LumenRendition }
  | { kind: "init"; rendition: LumenRendition }
  | { kind: "segment"; rendition: LumenRendition; n: number };

/**
 * Le pendant de ces noms : ce que demande une adresse, ou null. Strict — un nom qui n'a pas
 * exactement cette forme n'est rien (pas de zéros en tête, pas de signe), pour que deux adresses ne
 * désignent jamais le même segment.
 */
export function parseLumenPath(path: string): LumenPath | null {
  if (path === "master.m3u8") return { kind: "master" };
  const tag = (raw: string): LumenRendition | null => {
    if (raw === "v") return { kind: "video" };
    const m = /^a([1-9]\d{0,3})$/.exec(raw);
    return m ? { kind: "audio", track: Number(m[1]) } : null;
  };
  let m = /^([a-z0-9]+)\.m3u8$/.exec(path);
  if (m) {
    const rendition = tag(m[1]);
    return rendition ? { kind: "playlist", rendition } : null;
  }
  m = /^init-([a-z0-9]+)\.mp4$/.exec(path);
  if (m) {
    const rendition = tag(m[1]);
    return rendition ? { kind: "init", rendition } : null;
  }
  m = /^([a-z0-9]+)\/(0|[1-9]\d{0,5})\.m4s$/.exec(path);
  if (m) {
    const rendition = tag(m[1]);
    return rendition ? { kind: "segment", rendition, n: Number(m[2]) } : null;
  }
  return null;
}

/** Une erreur nette d'un segment demandé : l'étape 3 la traduit en réponse, jamais en octets faux. */
export class LumenError extends Error {
  constructor(
    readonly code: "fichier-change" | "segment-inconnu" | "piste-inconnue" | "cle-introuvable" | "segment-vide" | "occupe" | "non-eligible",
    message: string
  ) {
    super(message);
    this.name = "LumenError";
  }
}
