// Une conversion : des segments son [n0, n1) d'une piste, fabriqués par un seul processus ffmpeg (DECISIONS.md §161).
//
// 1. Les trames cibles [a, b) des segments et la fenêtre d'entrée de l'encodeur (`convertGrid.ts`).
// 2. Une fenêtre entièrement dans le silence — avant le premier son de la piste, après sa fin — ne lit rien du
//    fichier : ffmpeg reçoit un échantillon nul et le complète de zéros (`apad`). Sinon le fil de calcul lit les
//    blocs (`audio-feed`, `feed.ts`) et rend le flux élémentaire et la position exacte de son premier échantillon.
// 3. ffmpeg décode, place la fenêtre à l'échantillon près (`atrim` jette ce qui la précède, `adelay` ajoute des
//    zéros devant si le son commence dans la fenêtre, `apad` derrière si la piste s'arrête, `atrim` coupe à la
//    longueur exacte), replie les canaux (`panFor`, la règle de `fold`) et encode en E-AC-3.
// 4. Les trames de sortie sont découpées et vérifiées (`checkTargetFrame`), les trames P … P + (b − a) − 1 gardées,
//    chaque segment muxé à part (`mediaSegment`, `tfdt` = k × 32 000 µs + D, aucune liste d'édition).
// Les mêmes octets quel que soit [n0, n1) : la tâche d'avance de 60 s et le segment construit seul après un saut
// sont interchangeables (banc `lumen-audio-bench.spec.ts`).

import { mediaSegment, type MuxSample, type MuxTrackInfo } from "../../webcodecs/mp4Muxer";
import { AUDIO_TRACK_ID, LUMEN_TIMESCALE, LumenError, SEQUENCE_STRIDE, type LumenIndex } from "../format";
import {
  CONVERT_RATE,
  EAC3_FRAME_US,
  ENCODER_PREROLL,
  frameDecodeUs,
  inputWindow,
  outputRank,
  panFor,
  samplesToUs,
  segmentFrames,
  type ConvertTarget,
} from "./convertGrid";
import { decoderPrerollOf, type LumenConvertSource } from "./convertSource";
import type { AudioFeed, AudioFeedSpec } from "./feed";
import { setPriority } from "node:os";
import { checkTargetFrame, encoderArgs, runFfmpeg, splitEac3Frames, type RunResult } from "./ffmpeg";
import type { FfmpegPool } from "./ffmpegPool";
import { DIALOGUE_PREROLL, type DialogueWork, type LumenDialogueMode } from "./dialogue";

/** La fenêtre d'une conversion, en échantillons absolus, et ses trames. */
export interface ConvertWindow {
  a: number;
  b: number;
  start: number;
  end: number;
}

export function windowOf(index: Pick<LumenIndex, "segments" | "durationUs">, n0: number, n1: number): ConvertWindow {
  const [a, b] = segmentFrames(index, n0, n1);
  return { a, b, ...inputWindow(a, b) };
}

/** La fenêtre est-elle entièrement dans le silence de la piste (avant son premier son, après sa fin sûre) ? */
export function windowIsSilent(source: LumenConvertSource, w: ConvertWindow): boolean {
  if (w.end <= source.firstSample) return true;
  return source.quietFromUs !== null && samplesToUs(w.start) >= source.quietFromUs;
}

/** Le segment de l'index qui contient l'instant `us` (le dernier dont le début est à `us` ou avant). */
function segmentAtUs(index: Pick<LumenIndex, "segments">, us: number): number {
  let lo = 0;
  let hi = index.segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.segments[mid].startUs <= us) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** Ce que le fil de calcul reçoit pour lire la fenêtre `w` de la piste `track`. */
export function feedSpecOf(index: LumenIndex, track: number, source: LumenConvertSource, w: ConvertWindow): AudioFeedSpec {
  const lowUs = samplesToUs(w.start - decoderPrerollOf(source.codec));
  const highUs = samplesToUs(w.end);
  // La lecture part de la coupe juste avant la fenêtre et son pré-roulement, une demi-seconde de marge : le son d'un
  // instant est rangé près de l'image du même instant. Partir 2 s plus tôt doublait la lecture pour rien (banc de
  // charge du 17/11/2026 : la lecture des blocs, pas ffmpeg, faisait l'essentiel du temps d'un segment). Une lecture
  // qui ne remonte pas assez recommence 8 s plus tôt (`retryAt`).
  const from = segmentAtUs(index, lowUs - 0.5e6);
  const retry = segmentAtUs(index, lowUs - 8e6);
  const until = segmentAtUs(index, highUs + 2e6) + 1;
  return {
    path: index.identity.path,
    key: `${index.identity.path}|${index.identity.size}|${index.identity.mtimeMs}|${index.identity.ino}`,
    track,
    source,
    start: w.start,
    end: w.end,
    fromAt: index.segments[from].at,
    untilAt: until < index.segments.length ? index.segments[until].at : null,
    retryAt: retry < from ? index.segments[retry].at : null,
  };
}

const BASE_ARGS = ["-nostdin", "-hide_banner", "-nostats", "-v", "error", "-threads", "1", "-protocol_whitelist", "pipe"];

/**
 * Les arguments de ffmpeg pour une fenêtre. `feed` null : la fenêtre est silencieuse (un échantillon nul en
 * entrée, complété de zéros). Aucun chemin de fichier : tout passe par `pipe:0` et `pipe:1`.
 */
export function conversionArgs(feed: Pick<AudioFeed, "format" | "startSample" | "decoder"> | null, w: ConvertWindow, sourceChannels: number, target: ConvertTarget): string[] {
  const length = w.end - w.start;
  if (!feed) {
    return [...BASE_ARGS, "-f", "f32le", "-ar", String(CONVERT_RATE), "-ch_layout", target.layout, "-i", "pipe:0", "-af", `apad=whole_len=${length},atrim=end_sample=${length}`, ...encoderArgs(target)];
  }
  const trim = Math.max(0, w.start - feed.startSample);
  const delay = Math.max(0, feed.startSample - w.start);
  const filters = [
    ...(trim > 0 ? [`atrim=start_sample=${trim}`] : []),
    panFor(sourceChannels, target),
    ...(delay > 0 ? [`adelay=delays=${delay}S:all=1`] : []),
    `apad=whole_len=${length}`,
    `atrim=end_sample=${length}`,
  ];
  return [...BASE_ARGS, "-f", feed.format, ...(feed.decoder ? ["-c:a", feed.decoder] : []), "-i", "pipe:0", "-af", filters.join(","), ...encoderArgs(target)];
}

/** Un segment son converti : les trames [aₙ, bₙ) de la conversion, datées sur la grille. */
export function convertedSegment(frames: readonly Uint8Array[], conversionA: number, a: number, b: number, n: number, delayUs: number): Uint8Array {
  if (b <= a) throw new LumenError("segment-vide", `Segment son converti ${n} sans trame.`);
  const samples: MuxSample[] = [];
  for (let k = a; k < b; k++) {
    const data = frames[outputRank(k, conversionA)];
    if (!data) throw new LumenError("segment-vide", `Trame ${k} absente de la conversion.`);
    samples.push({ data, decodeTime: frameDecodeUs(k, delayUs), duration: EAC3_FRAME_US, compositionOffset: 0, isKeyframe: true });
  }
  const info: MuxTrackInfo = { id: AUDIO_TRACK_ID, kind: "audio", timescale: LUMEN_TIMESCALE, sampleEntry: new Uint8Array(0), width: 0, height: 0, language: "und" };
  return mediaSegment(info, n * SEQUENCE_STRIDE + 1, samples);
}

export interface ConvertJob {
  index: LumenIndex;
  track: number;
  source: LumenConvertSource;
  target: ConvertTarget;
  n0: number;
  n1: number;
  ffmpegPath: string;
  /** Le flux de la fenêtre, lu par le fil de calcul (`audio-feed`). */
  readFeed: (spec: AudioFeedSpec) => Promise<{ feed: AudioFeed | null; diskMs: number; ms: number }>;
  niceness: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Le pool de ffmpeg pré-lancés (`ffmpegPool.ts`) : la conversion passe alors par deux processus génériques déjà
   * lancés (décodeur, encodeur) et la fenêtre est posée par Node (`windowPcm`). Absent : un processus lancé pour elle.
   */
  pool?: FfmpegPool;
  /**
   * « Améliorer les dialogues » (§193) : le traitement entre le décodeur et l'encodeur, chaque segment à part
   * (`convertDialogueRange`). Jamais par le pool.
   */
  dialogue?: DialogueRun;
}

/** Ce qu'une conversion « dialogues » reçoit : la force, et qui exécute le traitement (un fil de calcul). */
export interface DialogueRun {
  mode: LumenDialogueMode;
  enhance: (work: DialogueWork) => Promise<{ segments: Float32Array[]; ms: number }>;
}

export interface ConvertFacts {
  /** Lecture du fichier (fil de calcul), dont l'attente du disque. */
  feedMs: number;
  diskMs: number;
  /** ffmpeg, du lancement à la dernière trame. */
  ffmpegMs: number;
  /** Octets donnés à ffmpeg. */
  inputBytes: number;
  /** Trames gardées. */
  frames: number;
  /** Fenêtre entièrement silencieuse (rien lu du fichier). */
  silent: boolean;
  /** Le premier octet rendu par ffmpeg, compté du don des données (le coût de lancement s'y voit). */
  firstByteMs: number | null;
  /** Servie par le pool de processus pré-lancés. */
  pooled: boolean;
}

/** Les segments [n0, n1) d'une piste, convertis par un seul processus. */
export async function convertRange(job: ConvertJob): Promise<{ segments: Map<number, Uint8Array>; facts: ConvertFacts }> {
  if (job.dialogue) return convertDialogueRange(job, job.dialogue);
  const { index, source, target } = job;
  const w = windowOf(index, job.n0, job.n1);
  let feed: AudioFeed | null = null;
  let feedMs = 0;
  let diskMs = 0;
  if (!windowIsSilent(source, w)) {
    const read = await job.readFeed(feedSpecOf(index, job.track, source, w));
    feed = read.feed;
    feedMs = read.ms;
    diskMs = read.diskMs;
  }
  if (job.signal?.aborted) throw new LumenError("occupe", "Conversion arrêtée.");
  // Le flux de sortie attendu (640 kb/s), largement majoré : une sortie qui dépasse est un défaut.
  const maxOutputBytes = Math.max(1 << 20, (w.b - w.a + 16) * 8192);
  let run: RunResult;
  let inputBytes: number;
  if (job.pool) {
    // Deux processus déjà lancés : le décodeur rend le PCM replié, Node pose la fenêtre, l'encodeur encode.
    let pcm: Float32Array | null = null;
    if (feed) {
      const decoder = job.pool.take(decoderStageArgs(feed, source.channels, target));
      nice(decoder.pid, job.niceness);
      const decoded = await decoder.feed(feed.bytes, { timeoutMs: job.timeoutMs, signal: job.signal });
      pcm = new Float32Array(decoded.stdout.buffer, decoded.stdout.byteOffset, Math.floor(decoded.stdout.byteLength / 4));
    }
    const windowed = windowPcm(pcm, feed?.startSample ?? 0, w, target.channels);
    const input = new Uint8Array(windowed.buffer, windowed.byteOffset, windowed.byteLength);
    inputBytes = (feed?.bytes.length ?? 0) + input.length;
    const encoder = job.pool.take(encoderStageArgs(target));
    nice(encoder.pid, job.niceness);
    run = await encoder.feed(input, { timeoutMs: job.timeoutMs, signal: job.signal });
    if (run.stdout.length > maxOutputBytes) throw new Error("Conversion : sortie trop grosse.");
  } else {
    const input = feed ? feed.bytes : new Uint8Array(target.channels * 4);
    inputBytes = input.length;
    run = await runFfmpeg(job.ffmpegPath, conversionArgs(feed, w, source.channels, target), input, { timeoutMs: job.timeoutMs, niceness: job.niceness, signal: job.signal, maxOutputBytes });
  }
  const frames = splitEac3Frames(run.stdout);
  const needed = ENCODER_PREROLL + (w.b - w.a);
  if (frames.length < needed) throw new Error(`Conversion : ${frames.length} trames pour ${needed} attendues.`);
  for (let i = ENCODER_PREROLL; i < needed; i++) {
    const why = checkTargetFrame(frames[i], target);
    if (why) throw new Error(`Conversion : trame ${i} non conforme (${why}).`);
  }
  const segments = new Map<number, Uint8Array>();
  for (let n = job.n0; n < job.n1; n++) {
    const [a, b] = segmentFrames(index, n, n + 1);
    segments.set(n, convertedSegment(frames, w.a, a, b, n, index.delayUs));
  }
  return { segments, facts: { feedMs, diskMs, ffmpegMs: run.ms, inputBytes, frames: w.b - w.a, silent: !feed, firstByteMs: run.firstByteMs, pooled: !!job.pool } };
}

// ── « Améliorer les dialogues » (§193) ───────────────────────────────────────

/**
 * Un décodage partagé par les segments d'une tâche donne-t-il, à chaque segment, le PCM qu'il aurait seul ? Oui quand
 * le décodeur est exact au bit au-delà de son pré-roulement (DTS, TrueHD, Opus, MPEG en flottants : §161). **Non pour
 * l'AC-3/E-AC-3** : le décodeur de FFmpeg tire un tramage pseudo-aléatoire (`dithflag`, un générateur `av_lfg` semé à
 * l'ouverture) pour les mantisses sans bits, dont l'état dépend de tout ce qu'il a décodé depuis son départ. Mesuré
 * au banc du 17/11/2026 (*Braveheart*, VF E-AC-3) : 1 segment sur 6 identique entre l'avance et le segment seul avec
 * un décodage partagé — chacun le sien, et 6 sur 6.
 */
export function decodeSharedAcrossSegments(codec: LumenConvertSource["codec"]): boolean {
  return codec !== "dolby";
}

/**
 * Les segments [n0, n1) d'une piste, traités par `DialogueEnhancer` puis encodés — **chaque segment à part** :
 * 1. le flux de la fenêtre élargie du pré-roulement du traitement (`DIALOGUE_PREROLL`) : lu une fois pour la tâche,
 *    ou une fois par segment pour un décodeur qui ne le permet pas (`decodeSharedAcrossSegments`) ;
 * 2. un ffmpeg décode et replie (`decoderStageArgs`, le `pan` de `panFor`) : le PCM de x, placé à l'échantillon
 *    (`feed.startSample`) ;
 * 3. le fil de calcul traite chaque segment depuis son propre pré-roulement, avec un `DialogueEnhancer` neuf
 *    (`enhanceWindow`), et rend sa fenêtre d'encodeur ;
 * 4. un ffmpeg par segment l'encode (`encoderStageArgs`, la fenêtre de la conversion : P trames devant, T derrière),
 *    les trames P … P + (b − a) − 1 gardées.
 * Un seul ffmpeg à la fois dans la tâche : elle tient une place de la file, comme toute conversion. Les octets d'un
 * segment ne dépendent que de x sur [début − pré-roulements, fin) et du mode : identiques seul ou dans l'avance.
 */
export async function convertDialogueRange(job: ConvertJob, dialogue: DialogueRun): Promise<{ segments: Map<number, Uint8Array>; facts: ConvertFacts }> {
  const { index, source, target } = job;
  const whole = windowOf(index, job.n0, job.n1);
  const segs: { n: number; a: number; b: number; w: { start: number; end: number } }[] = [];
  for (let n = job.n0; n < job.n1; n++) {
    const [a, b] = segmentFrames(index, n, n + 1);
    segs.push({ n, a, b, w: inputWindow(a, b) });
  }
  const groups = decodeSharedAcrossSegments(source.codec) ? [segs] : segs.map((s) => [s]);
  const facts: ConvertFacts = { feedMs: 0, diskMs: 0, ffmpegMs: 0, inputBytes: 0, frames: whole.b - whole.a, silent: true, firstByteMs: null, pooled: false };
  const segments = new Map<number, Uint8Array>();
  for (const group of groups) {
    // La fenêtre lue et décodée : celle du groupe, avec le pré-roulement du traitement devant.
    const read: ConvertWindow = { a: group[0].a, b: group[group.length - 1].b, start: group[0].w.start - DIALOGUE_PREROLL, end: group[group.length - 1].w.end };
    let feed: AudioFeed | null = null;
    if (!windowIsSilent(source, read)) {
      const got = await job.readFeed(feedSpecOf(index, job.track, source, read));
      feed = got.feed;
      facts.feedMs += got.ms;
      facts.diskMs += got.diskMs;
    }
    if (job.signal?.aborted) throw new LumenError("occupe", "Conversion arrêtée.");
    let pcm: Float32Array = new Float32Array(0);
    if (feed) {
      facts.silent = false;
      facts.inputBytes += feed.bytes.length;
      // Le décodé couvre [startSample, endSample) aux canaux de la cible : la sortie bornée à ce qu'il doit faire, large.
      const maxOutputBytes = Math.max(1 << 20, Math.ceil((feed.endSample - feed.startSample + CONVERT_RATE) * target.channels * 4 * 1.05));
      const decoded = await runFfmpeg(job.ffmpegPath, decoderStageArgs(feed, source.channels, target), feed.bytes, {
        timeoutMs: job.timeoutMs,
        niceness: job.niceness,
        signal: job.signal,
        maxOutputBytes,
      });
      facts.ffmpegMs += decoded.ms;
      facts.firstByteMs ??= decoded.firstByteMs;
      const out = decoded.stdout;
      // Le tampon de ffmpeg tel quel quand il est aligné (il est alors transféré au fil, pas copié), sinon une copie.
      pcm = out.byteOffset % 4 === 0 ? new Float32Array(out.buffer, out.byteOffset, Math.floor(out.byteLength / 4)) : new Float32Array(out.slice().buffer, 0, Math.floor(out.byteLength / 4));
    }
    const enhanced = await dialogue.enhance({
      pcm,
      pcmStart: feed?.startSample ?? 0,
      channels: target.channels,
      mono: source.channels === 1,
      mode: dialogue.mode,
      windows: group.map((s) => s.w),
      preroll: DIALOGUE_PREROLL,
    });
    if (enhanced.segments.length !== group.length) throw new Error("Dialogues : traitement incomplet.");
    facts.feedMs += enhanced.ms;
    for (let i = 0; i < group.length; i++) {
      if (job.signal?.aborted) throw new LumenError("occupe", "Conversion arrêtée.");
      const { n, a, b } = group[i];
      const samples = enhanced.segments[i];
      const input = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
      facts.inputBytes += input.length;
      const run = await runFfmpeg(job.ffmpegPath, encoderStageArgs(target), input, {
        timeoutMs: job.timeoutMs,
        niceness: job.niceness,
        signal: job.signal,
        maxOutputBytes: Math.max(1 << 20, (b - a + 16) * 8192),
      });
      facts.ffmpegMs += run.ms;
      facts.firstByteMs ??= run.firstByteMs;
      const frames = splitEac3Frames(run.stdout);
      const needed = ENCODER_PREROLL + (b - a);
      if (frames.length < needed) throw new Error(`Dialogues : ${frames.length} trames pour ${needed} attendues.`);
      for (let k = ENCODER_PREROLL; k < needed; k++) {
        const why = checkTargetFrame(frames[k], target);
        if (why) throw new Error(`Dialogues : trame ${k} non conforme (${why}).`);
      }
      // La conversion de ce segment a commencé à sa propre trame `a` : le rang de la trame k y est k − a + P.
      segments.set(n, convertedSegment(frames, a, a, b, n, index.delayUs));
    }
  }
  return { segments, facts };
}

// ── La voie du pool : deux processus génériques ──────────────────────────────

/** Le décodeur générique d'un format : le flux élémentaire en entrée, le PCM replié (f32le entrelacé) en sortie. */
export function decoderStageArgs(feed: Pick<AudioFeed, "format" | "decoder">, sourceChannels: number, target: ConvertTarget): string[] {
  return [...BASE_ARGS, "-f", feed.format, ...(feed.decoder ? ["-c:a", feed.decoder] : []), "-i", "pipe:0", "-af", panFor(sourceChannels, target), "-f", "f32le", "pipe:1"];
}

/** L'encodeur générique d'une cible : un PCM f32le entrelacé à 48 kHz en entrée, le flux E-AC-3 en sortie. */
export function encoderStageArgs(target: ConvertTarget): string[] {
  return [...BASE_ARGS, "-f", "f32le", "-ar", String(CONVERT_RATE), "-ch_layout", target.layout, "-i", "pipe:0", ...encoderArgs(target)];
}

/**
 * La fenêtre [start, end) posée sur le PCM décodé, à l'échantillon : ce que `atrim`, `adelay`, `apad` et `atrim` font
 * dans la voie à un processus — le décodé commence à `startSample`, des zéros partout où il n'y a rien.
 */
export function windowPcm(pcm: Float32Array | null, startSample: number, w: Pick<ConvertWindow, "start" | "end">, channels: number): Float32Array {
  const length = w.end - w.start;
  const out = new Float32Array(length * channels);
  if (!pcm) return out;
  const frames = Math.floor(pcm.length / channels);
  const offset = startSample - w.start; // > 0 : le son commence dans la fenêtre ; < 0 : à couper devant
  const from = Math.max(0, -offset);
  const to = Math.min(frames, length - offset);
  if (to > from) out.set(pcm.subarray(from * channels, to * channels), (from + offset) * channels);
  return out;
}

function nice(pid: number | undefined, niceness: number): void {
  if (!pid || !niceness) return;
  try {
    setPriority(pid, niceness);
  } catch {
    // Sans le droit, la priorité normale.
  }
}
