// « Améliorer les dialogues » dans Lumen serveur : le traitement du lecteur actuel, fait par le serveur, segment par
// segment, sans que les segments cessent d'être des fonctions du fichier (DECISIONS.md §191).
//
// Code pur, sans Node : importé par le fil principal, le fil de calcul (`jobs.ts`, travail `dialogue`), le banc et
// les tests.
//
// **Le traitement est `DialogueEnhancer` lui-même** (`src/lib/webcodecs/dialogueEnhance.ts`, la v2 validée à l'oreille,
// §68), exécuté par Node sur le PCM que ffmpeg décode — pas une traduction en filtres ffmpeg. Deux raisons, chacune
// suffisante :
// - le ffmpeg de l'image (`tools/ffmpeg-lumen/`) n'a que 31 filtres : ni égaliseur, ni compresseur, ni chaîne
//   latérale (`equalizer`, `acompressor`, `sidechaincompress` absents) — il faudrait un autre binaire, donc une autre
//   identité de conversion pour tout le son converti ;
// - même avec eux, trois étapes n'ont pas d'équivalent : le détecteur de parole (rapport d'énergie 300–3400 Hz contre
//   pleine bande, lissé 40/450 ms) qui pilote le retrait du fond, le plafond du fond **relatif au niveau de la voix
//   mise en forme**, et le niveleur qui ne fait que remonter une voix faible, coupé sous −62 dBFS. Une approximation
//   serait « un autre son que celui validé » (§188) — exactement l'objection.
// La chaîne, étape par étape, et ce qui la fait ici (README de docs/remux-serveur/, « Améliorer les dialogues ») :
//   décodage          ffmpeg (le décodeur de la conversion, `decoderStageArgs`)       même PCM que la conversion
//   repli 7.1 → 5.1   `pan` de `panFor` — la règle de `fold`, rangs 4+6 et 5+7 à −3 dB  comme le lecteur actuel
//   voix / fond       `DialogueEnhancer.process` (égalisation, gains, niveleur, plafond, détecteur, retrait,
//                     fond relatif, compresseur du fond, deux limiteurs sous −1 dBFS)   le code du lecteur actuel
//   encodage          ffmpeg, E-AC-3 640 kb/s 5.1 ou 256 kb/s 2.0 (`encoderStageArgs`)  la cible de la conversion
// Un mono : le lecteur actuel traite un canal (la voix seule, `shapeVoice` sans gain de milieu) ; ici aussi — le
// plan 0 traité en mono, puis copié dans les deux canaux de la cible stéréo, comme `panFor` le fait du mono brut.
//
// **Le pré-roulement du traitement.** `DialogueEnhancer` a une mémoire : enveloppes (jusqu'à 600 ms), niveleur
// (remontée lissée sur 800 ms), détecteur de parole (450 ms), limiteurs (80 ms), biquads. Un segment traité seul
// partirait d'un état neuf, et deux segments voisins ne se recolleraient pas (l'objection de §188). Chaque segment est
// donc traité **depuis `DIALOGUE_PREROLL` échantillons avant sa fenêtre d'encodeur**, avec un `DialogueEnhancer` neuf,
// et le pré-roulement est jeté. Chaque étape est contractante (un filtre linéaire stable, ou une enveloppe dont
// l'écart entre deux états se multiplie à chaque échantillon par au plus le plus lent de ses coefficients) : l'écart à
// un traitement continu décroît comme e^(−t/0,8 s) au pire. Mesuré au banc (`lumen-dialogue-bench.spec.ts`).
//
// **Un segment est une fonction du fichier, par construction** : le traitement d'un segment ne dépend que de
// l'échantillon [début − pré-roulement, fin) du signal x (§161) et du mode — jamais du segment d'avant, ni de la tâche
// qui l'a fait. Une tâche d'avance traite et encode **chaque segment à part** (un `DialogueEnhancer` et un processus
// d'encodage par segment) : ses octets sont ceux du même segment construit seul après un saut, sans rien supposer de
// l'encodeur.

import { DialogueEnhancer } from "../../webcodecs/dialogueEnhance";
import { CONVERT_RATE } from "./convertGrid";

/** Les deux forces servies, nommées comme le lecteur actuel (`DialogueMode` sans `off`). */
export type LumenDialogueMode = "on" | "strong";
export const LUMEN_DIALOGUE_MODES: readonly LumenDialogueMode[] = ["on", "strong"];

/**
 * La version des règles du traitement côté serveur : le pré-roulement, l'ordre des étapes, `DIALOGUE_TUNING`. Dans
 * l'identité des rendus « dialogues » : un réglage changé est une autre adresse, jamais d'autres octets sous la même.
 * **À monter quand `dialogueEnhance.ts` change** (un test le rappelle : `DIALOGUE_TUNING_FINGERPRINT`).
 */
export const LUMEN_DIALOGUE_VERSION = 1;

/**
 * Le pré-roulement du traitement, en échantillons à 48 kHz : 6 s. Le plus lent des états (la remontée du niveleur,
 * 800 ms) y décroît de e^(−7,5) ≈ 5,5·10⁻⁴ : une remontée de 9 dB partie de zéro y est à 0,005 dB de celle d'un
 * traitement continu. Banc du 17/11/2026 sur de vrais films : voir DECISIONS §191.
 */
export const DIALOGUE_PREROLL = 6 * CONVERT_RATE;

/** `on` / `strong` lus d'un paramètre (`?dialogue=`) ; `undefined` absent ; null mal formé. */
export function parseDialogueMode(raw: string | null | undefined): LumenDialogueMode | undefined | null {
  if (raw === null || raw === undefined || raw === "" || raw === "off") return undefined;
  return raw === "on" || raw === "strong" ? raw : null;
}

/** Ce que le fil de calcul reçoit pour traiter les segments d'une tâche. Sérialisable ; `pcm` transféré. */
export interface DialogueWork {
  /** Le PCM décodé et replié, f32 entrelacé, aux canaux de la cible. */
  pcm: Float32Array;
  /** La position absolue (échantillons à 48 kHz) du premier échantillon de `pcm`. */
  pcmStart: number;
  /** Les canaux de `pcm` (ceux de la cible : 6 ou 2). */
  channels: number;
  /** Une source mono, dupliquée en stéréo par `panFor` : traitée en mono (le plan 0), comme le lecteur actuel. */
  mono: boolean;
  mode: LumenDialogueMode;
  /** La fenêtre d'encodeur de chaque segment, en échantillons absolus. */
  windows: { start: number; end: number }[];
  preroll: number;
}

/** Les échantillons [start, end) de `pcm` (posé à `pcmStart`), en plans ; des zéros hors du décodé (le signal x, §161). */
export function planesOf(pcm: Float32Array, pcmStart: number, channels: number, start: number, end: number, only?: number): Float32Array[] {
  const length = Math.max(0, end - start);
  const count = only !== undefined ? 1 : channels;
  const out = Array.from({ length: count }, () => new Float32Array(length));
  const frames = Math.floor(pcm.length / channels);
  const from = Math.max(0, pcmStart - start);
  const to = Math.min(length, pcmStart + frames - start);
  for (let i = from; i < to; i++) {
    const src = (start + i - pcmStart) * channels;
    if (only !== undefined) out[0][i] = pcm[src + only];
    else for (let c = 0; c < channels; c++) out[c][i] = pcm[src + c];
  }
  return out;
}

/**
 * Un segment traité : `DialogueEnhancer` neuf sur [start − preroll, end), le pré-roulement jeté, rendu entrelacé aux
 * canaux de la cible (f32), prêt pour l'encodeur. Une fonction de (x sur cette plage, mode) seulement.
 */
export function enhanceWindow(work: Pick<DialogueWork, "pcm" | "pcmStart" | "channels" | "mono" | "mode" | "preroll">, window: { start: number; end: number }): Float32Array {
  const from = window.start - work.preroll;
  const length = window.end - window.start;
  const channels = work.channels;
  // Rien du décodé dans la plage (le silence avant le premier son, après la fin d'une piste) : des zéros traités
  // rendent des zéros exacts (biquads, gains et limiteurs d'un signal nul), sans le calcul.
  const decodedFrames = Math.floor(work.pcm.length / channels);
  if (decodedFrames === 0 || work.pcmStart >= window.end || work.pcmStart + decodedFrames <= from) return new Float32Array(length * channels);
  const enhancer = new DialogueEnhancer(CONVERT_RATE, work.mono ? 1 : channels, work.mode);
  const input = planesOf(work.pcm, work.pcmStart, channels, from, window.end, work.mono ? 0 : undefined);
  const processed = enhancer.process(input);
  const out = new Float32Array(length * channels);
  for (let i = 0; i < length; i++) {
    const at = work.preroll + i;
    if (work.mono) {
      const v = processed[0][at];
      for (let c = 0; c < channels; c++) out[i * channels + c] = v;
    } else {
      for (let c = 0; c < channels; c++) out[i * channels + c] = processed[c][at];
    }
  }
  return out;
}

/** Chaque segment d'une tâche, traité à part (`enhanceWindow`). */
export function enhanceWindows(work: DialogueWork): Float32Array[] {
  return work.windows.map((w) => enhanceWindow(work, w));
}
