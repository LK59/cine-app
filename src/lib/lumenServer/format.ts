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
import type { LumenSilence } from "./audio/silence";
import type { LumenConvertSource } from "./audio/convertSource";
import type { LumenDialogueMode } from "./audio/dialogue";

/**
 * La version du format produit. À monter quand change : la règle de découpe (cible, points de coupe
 * admis), le calcul du délai D, la forme des init segments ou des fragments (identifiants de piste,
 * échelle de temps, numérotation `mfhd`, découpe en fragments), la règle d'appartenance des trames
 * audio à un segment. Ne la change pas : une correction de liste maître qui ne touche ni les
 * frontières ni les octets des segments (un attribut ajouté), un nouveau motif de refus d'éligibilité.
 *
 * **2** (17/11/2026, DECISIONS §158) : la découpe par défaut devient `cra` — toute image clé de l'index,
 * RASL gardées —, construite depuis les Cues seules. La 1 coupait sous `idr`. Rien de la 1 (adresse,
 * index en mémoire ou sur le disque, segment gardé par le navigateur) ne se relit sous la 2.
 *
 * **3** (17/11/2026, DECISIONS §159) : le son copié réparé. Un HE-AAC à SBR implicite est servi avec sa
 * configuration réécrite en signalisation hiérarchique (une autre init, `CODECS` `mp4a.40.5`) ; une piste
 * qui commence après l'image ou finit avant elle est complétée de trames de silence (d'autres segments son) ;
 * l'AC-3/E-AC-3 à 32 et 44,1 kHz n'est plus refusé. Pour un fichier déjà servi, la liste maître peut gagner des
 * rendus (des pistes refusées hier), et une piste AAC-LC dont le flux porte un SBR que rien n'annonçait change
 * d'init : rien de la 2 ne se relit sous la 3, pour qu'aucun index gardé sur le disque ne serve l'ancienne règle.
 *
 * **4** (17/11/2026, DECISIONS §161) : la conversion du son. L'index porte, pour chaque piste DTS, TrueHD, Opus
 * ou MP2/MP3, de quoi la convertir (`convert` : codec, grille, premier échantillon, fin) ; option en service et
 * ffmpeg présent, la liste maître gagne ces rendus (`a{N}x{cid}`) et l'éligibilité ne les refuse plus. Un index de
 * la 3 n'a pas ces faits : rien de la 3 ne se relit sous la 4. Option coupée, les adresses changent de version
 * mais pas d'octets.
 *
 * **5** (17/11/2026, DECISIONS §185) : la liste maître d'un fichier dont les pistes servies ont plusieurs codecs
 * (AC-3 et E-AC-3, AAC et AC-3, une piste convertie à côté d'une AC-3 — 15 % de la bibliothèque) met toutes ses
 * pistes dans **un seul groupe audio**, au lieu d'un groupe et d'une variante par codec : un changement de piste
 * entre codecs devient un changement de rendu dans le groupe (`audioTracks`), sans rechargement. Aucun segment,
 * aucun init ne change d'un octet ; la liste maître d'un fichier à un seul codec non plus. La version monte quand
 * même, parce que la règle de §155 vaut pour toute adresse servie : la même adresse, les mêmes octets.
 *
 * **6** (17/11/2026, DECISIONS §191) : la liste maître sait porter un rendu de sous-titres WebVTT (`?st=N`, pour
 * AirPlay), avec ses listes et segments `s{N}h{empreinte}` (`subtitles.ts`). Sans `st`, la liste maître, les listes
 * média, les init et les segments sont ceux de la 5 à l'octet près ; la version monte pour que la nouvelle forme de
 * liste maître et les nouveaux noms ne vivent que sous une version qui les connaît. La découpe des sous-titres a sa
 * propre révision (`LUMEN_SUBTITLE_REVISION`), dans l'empreinte de leurs noms : elle ne fait pas monter celle-ci.
 *
 * **« Améliorer les dialogues » (§193) ne la fait pas monter (elle reste à 6).** Il n'ajoute que des adresses neuves (`a3d1x{cid}`,
 * `a3d2x{cid}`, leurs inits et segments, et la liste maître `?dialogue=on|strong`), dont l'identité `cid` porte
 * tout ce qui en fixe les octets (règles du traitement, cible, ffmpeg, moteur JavaScript) ; aucune adresse servie
 * avant ne change d'un octet — la liste maître sans `?dialogue=` comprise (un test le compare).
 */
export const LUMEN_FORMAT_VERSION = 6;

// ── La règle de découpe ──────────────────────────────────────────────────────

/**
 * La règle qui dit sur quelles images clés un segment peut commencer (DECISIONS.md §155, §157, §158).
 *
 * - **`cra`** — **la règle**, celle que sert un appelant qui ne demande rien (depuis le format 2) :
 *   toute image clé de l'index (IDR ou CRA) ouvre un segment, et les RASL d'une CRA restent dans le
 *   segment qu'elle ouvre. En lecture continue, leurs références sont à la fin du segment précédent ;
 *   après un saut, c'est au décodeur de les jeter (H.265 §8.1.3, `NoRaslOutputFlag` = 1 sur une CRA qui
 *   ouvre un accès aléatoire). Safari sous MediaSource ne l'a jamais fait (*Ted Lasso* S02E01) ; le HLS
 *   natif d'Apple, si : banc de Louis du 16/11/2026 (iPhone, 14 essais, 253 sauts, 0 erreur, 0 gel,
 *   0 image corrompue, *Ghosted* et *Pearl Harbor* à GOP ouvert compris). L'index se construit **depuis
 *   les Cues seules** (`lumenIndex.ts`, « l'index des Cues ») : seule la première clé est lue.
 * - **`idr`** — essai (l'ancienne règle, §155) : une clé dont un décodeur repart seul sans rien perdre
 *   (IDR, BLA, CRA *sans* RASL, I H.264 sans images de tête), chaque point d'index vérifié dans l'image.
 *   Recensement du 16/11/2026 : 57 % de la bibliothèque servable, contre 88 % sous `cra`.
 * - **`cra-leading`** — essai : `cra`, et chaque image non clé nommée dans ses `sample_flags`
 *   (`is_leading`, ISO/IEC 14496-12 §8.8.3.1) : RASL 1, RADL 3, toute autre 2. Le banc du 16/11/2026 n'y a
 *   vu aucune différence avec `cra` : le HLS d'Apple jette les RASL sans cette indication.
 *
 * Les essais portent leur propre version de format (`lumenFormatTag`) : ils changent des frontières de
 * segment et des octets, et rien — cache d'index en mémoire ou sur le disque, segments gardés, cache du
 * navigateur — ne doit mélanger deux découpes du même fichier.
 */
export type LumenCutMode = "idr" | "cra" | "cra-leading";
export const LUMEN_CUT_MODES: readonly LumenCutMode[] = ["cra", "idr", "cra-leading"];
/** La découpe que sert un appelant qui ne demande rien. */
export const LUMEN_DEFAULT_CUT: LumenCutMode = "cra";

/**
 * La révision des essais (une découpe autre que la règle, une cible autre que 4 s) : à monter quand
 * leur règle change sans que la règle par défaut change (sinon c'est `LUMEN_FORMAT_VERSION` qui monte,
 * et elle les entraîne).
 */
export const LUMEN_TRIAL_REVISION = 1;

const CUT_LETTER: Record<Exclude<LumenCutMode, "cra">, string> = { idr: "i", "cra-leading": "l" };

/**
 * La durée visée pour un segment. Recommandation de l'étude (1-remuxeur.md §1.2, mesurée sur quatre
 * fichiers à 2, 4 et 6 s) : 4 s donne une médiane de 5 à 9 s sur les fichiers à groupes d'images
 * longs et garde les sauts bon marché ailleurs. Apple conseille 6 s (règle 7.5, un « SHOULD ») :
 * plus court, c'est un saut moins cher, et une liste de 1 800 segments pour deux heures.
 */
export const LUMEN_TARGET_SEGMENT_US = 4_000_000;

/**
 * Les cibles d'essai, en secondes (`?target=`, page `/lumen-test`, étape 3c) : une coupe à la première
 * image clé au moins à la cible de la précédente. 2 s : la question du banc de Louis — un saut revoit
 * l'image en 0,6 s mais ne repart qu'en 1,5 s ; Safari attend-il un segment, ou une réserve en secondes ?
 * Une autre cible change toutes les frontières : elle est dans la version de format (`t2`).
 */
export const LUMEN_TRIAL_TARGETS_S: readonly number[] = [2, 3, 6];

/** Une découpe et sa cible : ce qui fixe les frontières des segments d'un fichier. */
export interface LumenCutting {
  cut: LumenCutMode;
  /** La cible en µs (`LUMEN_TARGET_SEGMENT_US` par défaut). */
  targetUs: number;
}

export const LUMEN_DEFAULT_CUTTING: LumenCutting = { cut: LUMEN_DEFAULT_CUT, targetUs: LUMEN_TARGET_SEGMENT_US };

/** Une découpe complétée de ses valeurs par défaut. */
export function cuttingOf(cut?: LumenCutMode | null, targetUs?: number | null): LumenCutting {
  return { cut: cut ?? LUMEN_DEFAULT_CUT, targetUs: targetUs ?? LUMEN_TARGET_SEGMENT_US };
}

/** La règle telle quelle : aucun essai (découpe par défaut, 4 s). */
export function isDefaultCutting(c: LumenCutting): boolean {
  return c.cut === LUMEN_DEFAULT_CUT && c.targetUs === LUMEN_TARGET_SEGMENT_US;
}

/**
 * La version de format d'une découpe, telle que l'adresse et les clés de cache la portent : `"2"` pour la
 * règle (`cra`, 4 s), puis pour un essai la lettre de sa découpe et la révision des essais (`"2i1"` pour
 * `idr`, `"2l1"` pour `cra-leading`), et sa cible quand elle n'est pas 4 s (`"2t2"`, `"2i1t2"`).
 */
export function lumenFormatTag(cut: LumenCutMode = LUMEN_DEFAULT_CUT, targetUs: number = LUMEN_TARGET_SEGMENT_US): string {
  const letter = cut === "cra" ? "" : `${CUT_LETTER[cut]}${LUMEN_TRIAL_REVISION}`;
  const target = targetUs === LUMEN_TARGET_SEGMENT_US ? "" : `t${Math.round(targetUs / 1e6)}`;
  return `${LUMEN_FORMAT_VERSION}${letter}${target}`;
}

/** Le pendant : la découpe que nomme une version de format, ou null (une autre version, un autre format). */
export function cuttingOfTag(tag: string): LumenCutting | null {
  for (const cut of LUMEN_CUT_MODES) {
    for (const s of [LUMEN_TARGET_SEGMENT_US / 1e6, ...LUMEN_TRIAL_TARGETS_S]) {
      if (lumenFormatTag(cut, s * 1e6) === tag) return { cut, targetUs: s * 1e6 };
    }
  }
  return null;
}

/** `?cut=` tel qu'une adresse le porte : un mode connu, `undefined` (la règle), ou null (mal formé). */
export function parseCutMode(raw: string | null | undefined): LumenCutMode | undefined | null {
  if (raw === null || raw === undefined || raw === "") return undefined;
  return (LUMEN_CUT_MODES as readonly string[]).includes(raw) ? (raw as LumenCutMode) : null;
}

/**
 * `?target=` (secondes) : la cible en µs, `undefined` (4 s), ou null (mal formé, ou pas une cible
 * d'essai — une cible libre ferait autant de versions d'index que de valeurs essayées).
 */
export function parseTargetSeconds(raw: string | number | null | undefined): number | undefined | null {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const s = typeof raw === "number" ? raw : /^[1-9]\d?$/.test(raw) ? Number(raw) : NaN;
  if (s === LUMEN_TARGET_SEGMENT_US / 1e6) return LUMEN_TARGET_SEGMENT_US;
  return LUMEN_TRIAL_TARGETS_S.includes(s) ? s * 1e6 : null;
}

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
  | "index-troue"
  | "segment-trop-lourd"
  | "son-codec"
  | "son-aac-pce"
  | "son-aac-sbr-implicite"
  | "son-aac-ps-implicite"
  | "son-frequence"
  | "son-sans-trame"
  | "son-en-retard"
  | "son-plus-court"
  /**
   * La piste demande une conversion (option en service, ffmpeg présent) mais le serveur n'admet pas de nouvelle
   * lecture qui convertit (trop de lectures, file trop lente, machine trop chargée, §163) : le lecteur actuel prend
   * le titre et convertit dans la page. Les lectures en cours ne sont jamais dégradées pour en admettre une autre.
   */
  | "son-serveur-occupe"
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
  /**
   * La configuration AAC écrite dans l'init quand elle n'est pas le `CodecPrivate` : un SBR implicite rendu
   * explicite (§159, `aacHlsPlan`). `channels` et `sampleRate` disent alors ce qu'elle dit (48 000, pas 24 000).
   */
  configuration?: Uint8Array | null;
  /** Le silence qui complète la piste devant ou derrière (§159), ou null : la piste couvre l'image. */
  silence?: LumenSilence | null;
  /**
   * Une piste non copiable que le serveur sait convertir (§161) : ses faits, gardés par l'index. Sa `refusal`
   * reste `son-codec` dans l'index — la vue `withConversion` (`audio/view.ts`) la lève quand l'option est en
   * service pour le compte et que ffmpeg est là. Absent : piste copiable, ou non convertible (`convertRefusal`).
   */
  convert?: LumenConvertSource;
  /** Pourquoi une piste non copiable ne se convertit pas (48 kHz seulement, MP4, DTS sans cœur…), pour la page de banc. */
  convertRefusal?: string;
  /**
   * Posé par la vue seulement, jamais par l'index : la piste est servie convertie, vers cette cible, sous cette
   * identité de conversion (`cid`, dans le nom de ses rendus), avec ces canaux.
   */
  converted?: { target: string; cid: string; channels: number };
  /**
   * Posé par la vue seulement (`withDialogue`, §193) : les rendus « Améliorer les dialogues » de la piste — le
   * traitement du lecteur actuel fait par le serveur, encodé vers la cible de la conversion. Absent : la piste n'en a
   * pas (option coupée, ffmpeg absent, AAC, FLAC, PCM, MP4…).
   */
  dialogue?: LumenDialogueRenditions;
  signal: HlsAudioSignal | null;
  /** Pourquoi cette piste ne peut pas être servie, ou null. */
  refusal: LumenRefusal | null;
}

/** Les deux rendus « dialogues » d'une piste (§193) : une cible, une init, une identité par force. */
export interface LumenDialogueRenditions {
  /** La cible (`eac3-640-51`, `eac3-256-20`) et ses canaux. */
  target: string;
  channels: number;
  /** La signalisation de ce qui est servi (E-AC-3, la trame de référence de la cible). */
  signal: HlsAudioSignal;
  /** Ce qu'il faut pour décoder la piste (la conversion de §161, ou une AC-3/E-AC-3 copiée lue comme telle). */
  source: LumenConvertSource;
  /** L'identité de chaque force, dans le nom de son rendu (`a3d1x{cid}`). */
  cids: Record<LumenDialogueMode, string>;
  init: Uint8Array;
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
  /**
   * Coupes prises des Cues sans lire l'image (découpe `cra`, l'index des Cues, §158) : tout sauf la
   * première. Les compteurs de types (`idr`, `cra`, `craRasl`) ne portent que sur les points lus.
   */
  trusted: number;
}

/** Ce que l'index d'un fichier dit, une fois pour toutes les requêtes. Sérialisable (clonage structuré). */
export interface LumenIndex {
  format: number;
  /** La règle de découpe qui a produit `segments` (`cra` sauf essai, §158). */
  cut: LumenCutMode;
  /** La cible de la découpe (µs) : `LUMEN_TARGET_SEGMENT_US` sauf essai (étape 3c). */
  targetUs: number;
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

/**
 * Une piste servie : la vidéo, ou une piste audio par son numéro dans le fichier. `conv` : l'identité de la
 * conversion d'une piste convertie (§161) — dans le nom, pour qu'une autre conversion (autre ffmpeg, autre règle)
 * soit une autre adresse et jamais d'autres octets sous la même.
 */
export type LumenRendition =
  | { kind: "video" }
  /**
   * `dialogue` (§193) : le rendu « Améliorer les dialogues » de la piste, à cette force — toujours avec `conv`,
   * l'identité de son traitement (`a3d1x{cid}` : `d1` améliorer, `d2` davantage).
   */
  | { kind: "audio"; track: number; conv?: string; dialogue?: LumenDialogueMode };

/**
 * Le nom d'un fichier servi, relatif à la liste maître : `v.m3u8`, `init-v.mp4`, `v/12.m4s`, et pour
 * la piste audio 3 `a3.m3u8`, `init-a3.mp4`, `a3/12.m4s` ; convertie, `a3x1a2b3c4d.m3u8`… Les noms naturels,
 * sans détour pour CrowdSec : décision du 16/11/2026, contre la décision 4 de la conception.
 */
export function renditionTag(rendition: LumenRendition): string {
  if (rendition.kind === "video") return "v";
  const dialogue = rendition.dialogue && rendition.conv ? (rendition.dialogue === "strong" ? "d2" : "d1") : "";
  return `a${rendition.track}${dialogue}${rendition.conv ? `x${rendition.conv}` : ""}`;
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
    // `a3`, `a3x{cid}` (convertie, §161), `a3d1x{cid}` / `a3d2x{cid}` (dialogues, §193 — jamais sans identité).
    const m = /^a([1-9]\d{0,3})(?:(?:d([12]))?x([0-9a-f]{8}))?$/.exec(raw);
    if (!m) return null;
    if (!m[3]) return { kind: "audio", track: Number(m[1]) };
    return m[2] ? { kind: "audio", track: Number(m[1]), conv: m[3], dialogue: m[2] === "2" ? "strong" : "on" } : { kind: "audio", track: Number(m[1]), conv: m[3] };
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
