// La grille du son converti de Lumen serveur (phase 2, DECISIONS.md §161, docs/remux-serveur/5-conversion-son.md §5.4).
//
// Code pur, sans Node : importé par le fil principal, le fil de calcul, le banc et les tests.
//
// **Un segment converti est une fonction du fichier.** Le signal x d'une piste est défini sur toute la durée de
// l'image : les échantillons décodés placés par leur nombre sur la grille du codec source (`convertSource.ts`), des
// zéros partout ailleurs — avant le premier son, après la fin d'une piste plus courte —, replié vers la disposition
// cible par la règle de `fold` (le lecteur actuel). La cible, E-AC-3 à 48 kHz, a une trame fixe de N = 1 536
// échantillons ; la trame k porte l'instant k·N, sur une grille ancrée à 0, et appartient au segment n quand son
// instant tombe dans [Sₙ, Sₙ₊₁) — les frontières des segments vidéo, la règle de §155 pour le son copié.
//
// Pour fabriquer les trames [a, b), ffmpeg reçoit x sur [(a − P)·N + d, (b + T)·N + d) :
// - d = 256, le délai de l'encodeur E-AC-3 de FFmpeg (le recouvrement de sa MDCT) : l'entrée commençant à
//   T ≡ d (mod N), la trame j sortie porte l'instant T − d + j·N, pile sur la grille, et décodée elle rend x à
//   cet instant (mesuré : 0 échantillon d'écart) ;
// - P = 2 trames de pré-roulement de l'encodeur : avec au moins une, une trame encodée seule est **identique à
//   l'octet** à la même trame d'un encodage continu (1 877 sur 1 877, trois pistes, 5.1 et 2.0) — l'encodeur AC-3
//   de FFmpeg n'a ni commutation de blocs ni réservoir de bits, son seul état est ce recouvrement. Une de marge ;
// - T = 3 trames de queue : la dernière trame gardée a son recouvrement entier, et ffmpeg vide son encodeur au-delà.
// On garde les trames P … P + (b − a) − 1, on jette le reste. Aucune liste d'édition ni `iTunSMPB` : le délai
// tombe sur des trames jetées ; `tfdt` = k·N (en µs : k × 32 000) + D, le délai de présentation commun (§155).
//
// Ce qui en découle, et que le banc vérifie : une tâche d'avance de 60 s et dix segments construits chacun à froid
// après un saut donnent les mêmes octets ; le cache ne peut jamais servir deux versions d'un même segment.

import type { LumenIndex } from "../format";

/** La fréquence de toute cible : la bibliothèque n'a que du 48 kHz à convertir (recensement du 17/11/2026). */
export const CONVERT_RATE = 48_000;
/** Échantillons par trame E-AC-3 (6 blocs de 256). */
export const EAC3_FRAME = 1536;
/** La durée d'une trame cible en µs : exacte, 1 536 / 48 000 s. */
export const EAC3_FRAME_US = 32_000;
/** Le délai de l'encodeur E-AC-3 de FFmpeg (`initial_padding`, le recouvrement de la MDCT). */
export const ENCODER_DELAY = 256;
/** Trames de pré-roulement de l'encodeur (5-conversion-son.md §5.4 : identité dès 1 ; 2 pour la marge). */
export const ENCODER_PREROLL = 2;
/** Trames de queue après la dernière gardée. */
export const ENCODER_TAIL = 3;
/**
 * Le pré-roulement du décodeur, en échantillons (0,25 s). Mesuré au prototype : DTS et DTS-HD MA sont faux
 * pendant ~4 096 échantillons après un départ à froid (jusqu'à −23 dB d'erreur au départ — l'historique du banc
 * de filtres et de la prédiction ADPCM du cœur), exacts au bit au-delà ; TrueHD est exact dès sa synchronisation
 * majeure ; l'Opus et le MP3 se remettent en quelques trames (le réservoir de bits du MP3 remonte de 511 octets).
 * Un quart de seconde couvre tout, pour quelques millisecondes de décodage en plus.
 */
export const DECODER_PREROLL = 12_000;

/**
 * La version des règles de conversion : grille, placement, pré-roulements, repli des canaux, réglages de
 * l'encodeur. À monter quand l'une change : elle entre dans le nom des rendus convertis (`cid`) et dans la clé
 * du cache, donc rien de l'ancienne règle n'est relu ni servi sous la nouvelle.
 */
export const LUMEN_AUDIO_VERSION = 1;

// ── La cible ─────────────────────────────────────────────────────────────────

/**
 * La cible d'une conversion (décision de Louis du 16/11/2026) : **E-AC-3 partout** — 640 kb/s en 5.1 pour une
 * source multicanal, 256 kb/s en 2.0 pour la stéréo et le mono. L'E-AC-3 est la seule cible mesurée qui se
 * découpe sans jointure, elle coûte un pour cent d'un cœur, et elle partage le groupe `ec-3` de 79 % des pistes
 * copiées. Le FLAC sans perte (qui garderait un 7.1) viendra plus tard : un `codec: "flac"` ici, son propre
 * découpage de trames et son entrée d'échantillon ; rien ailleurs ne suppose l'E-AC-3 sans passer par ce type.
 */
export interface ConvertTarget {
  id: "eac3-640-51" | "eac3-256-20";
  codec: "eac3";
  bitrate: number;
  channels: 6 | 2;
  /** La disposition donnée à l'encodeur (et au `pan` qui la produit). */
  layout: "5.1(side)" | "stereo";
  /** `acmod` et `lfeon` attendus dans chaque trame produite. */
  acmod: number;
  lfeon: number;
}

export const TARGET_51: ConvertTarget = { id: "eac3-640-51", codec: "eac3", bitrate: 640_000, channels: 6, layout: "5.1(side)", acmod: 7, lfeon: 1 };
export const TARGET_20: ConvertTarget = { id: "eac3-256-20", codec: "eac3", bitrate: 256_000, channels: 2, layout: "stereo", acmod: 2, lfeon: 0 };
export const CONVERT_TARGETS: readonly ConvertTarget[] = [TARGET_51, TARGET_20];

/** La cible d'une source : multicanal (trois canaux ou plus) en 5.1, le reste en 2.0. */
export function targetFor(sourceChannels: number): ConvertTarget {
  return sourceChannels >= 3 ? TARGET_51 : TARGET_20;
}

/**
 * Ce qui fixe les octets d'une cible, en clair : le cache et le nom des rendus le portent.
 * `eac3-640-51-p2`.
 */
export function targetTag(target: ConvertTarget): string {
  // Le pré-roulement du décodeur dépend du codec source (`decoderPrerollOf`) : il est une règle de
  // `LUMEN_AUDIO_VERSION`, pas un réglage de la cible.
  return `${target.id}-p${ENCODER_PREROLL}`;
}

const HALF_POWER = "0.7071067811865476"; // Math.SQRT1_2, écrit exactement comme `fold`

/**
 * Le repli des canaux, en `pan` positionnel : **la règle de `fold`** (`src/lib/webcodecs/audioTranscode.ts`),
 * celle du lecteur actuel, pour que passer du serveur à l'appareil (§5.7) ne change pas le mélange.
 * - Les rangs sont ceux de l'ordre natif de FFmpeg, celui que ses décodeurs rendent (L R C LFE, puis les
 *   ambiances, puis les arrières) — l'ordre que lit `fold` : L R C LFE Ls Rs Lrs Rrs.
 * - 7.1 → 5.1 : les rangs 4+6 et 5+7 à −3 dB chacun (`Math.SQRT1_2`), le reste tel quel. Le tableau du prototype
 *   (tonalités marquées, 5-conversion-son.md §5.2) : FL 300, FR 400, FC 500, LFE 60, SL 700+900, SR 800+1000.
 * - 5.1 → 5.1 : tel quel, étiqueté `5.1(side)` (l'encodeur E-AC-3 écrit `acmod` 7 + LFE dans les deux cas ; le
 *   piège du PCE ne touche que l'encodeur AAC, vérifié par le banc et par `checkTargetFrame`).
 * - 3 canaux : L R C, le reste silencieux (le complément vers le haut de `fold`).
 * - 4, 5 et 7 canaux : le nombre ne dit pas la disposition (5.0 ou 4.1, 6.1 à arrière central) ; on garde les
 *   trois premiers rangs, les seuls que toutes partagent (`frontOnly` de `fold`). FFmpeg connaît ici la
 *   disposition, mais le repli vers l'appareil ne la connaîtrait pas : la même règle des deux côtés.
 * - 2 → 2 tel quel ; 1 → 2 copié dans les deux canaux avant à niveau égal (le mono de `fold`).
 * Un canal de sortie que le `pan` ne nomme pas est silencieux.
 */
export function panFor(sourceChannels: number, target: ConvertTarget): string {
  if (target.channels === 2) {
    if (sourceChannels === 1) return "pan=stereo|c0=c0|c1=c0";
    // Une source multicanal n'est jamais repliée en stéréo ici (`targetFor`) : ce cas ne sert qu'à la stéréo.
    return "pan=stereo|c0=c0|c1=c1";
  }
  if (sourceChannels === 8) {
    return `pan=5.1(side)|c0=c0|c1=c1|c2=c2|c3=c3|c4=${HALF_POWER}*c4+${HALF_POWER}*c6|c5=${HALF_POWER}*c5+${HALF_POWER}*c7`;
  }
  if (sourceChannels === 6) return "pan=5.1(side)|c0=c0|c1=c1|c2=c2|c3=c3|c4=c4|c5=c5";
  // 3, et la règle des dispositions inconnues (4, 5, 7) : les trois premiers rangs.
  return "pan=5.1(side)|c0=c0|c1=c1|c2=c2";
}

// ── Les trames d'un segment ──────────────────────────────────────────────────

/** La première trame cible dont l'instant est à `us` ou après. */
export function frameAtOrAfter(us: number): number {
  return Math.max(0, Math.ceil(us / EAC3_FRAME_US));
}

/**
 * Les trames cibles [a, b) des segments [n0, n1) : celles dont l'instant tombe dans [Sₙ₀, Sₙ₁). Le premier
 * segment commence à la trame 0 (aucune trame d'avant l'origine, §155) ; le dernier finit à la fin de l'image.
 */
export function segmentFrames(index: Pick<LumenIndex, "segments" | "durationUs">, n0: number, n1: number = n0 + 1): [number, number] {
  const segs = index.segments;
  const a = n0 === 0 ? 0 : frameAtOrAfter(segs[n0].startUs);
  const b = n1 < segs.length ? frameAtOrAfter(segs[n1].startUs) : frameAtOrAfter(index.durationUs);
  return [a, Math.max(a, b)];
}

/** La fenêtre d'entrée de l'encodeur pour les trames [a, b), en échantillons absolus (48 kHz, origine 0). */
export function inputWindow(a: number, b: number): { start: number; end: number } {
  return { start: (a - ENCODER_PREROLL) * EAC3_FRAME + ENCODER_DELAY, end: (b + ENCODER_TAIL) * EAC3_FRAME + ENCODER_DELAY };
}

/** Le rang, dans la sortie de l'encodeur, de la trame cible `k` d'une conversion qui a commencé à la trame `a`. */
export function outputRank(k: number, a: number): number {
  return k - a + ENCODER_PREROLL;
}

/** L'instant de décodage (`tfdt`, µs) de la trame cible `k`. */
export function frameDecodeUs(k: number, delayUs: number): number {
  return k * EAC3_FRAME_US + delayUs;
}

/** Échantillons ↔ µs à 48 kHz. */
export function samplesToUs(samples: number): number {
  return (samples * 1e6) / CONVERT_RATE;
}
export function usToSamples(us: number): number {
  return (us * CONVERT_RATE) / 1e6;
}
