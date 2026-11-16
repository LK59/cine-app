"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { APP_BUILD } from "@/lib/appBuild";
import { useWakeLock } from "@/lib/useWakeLock";
import {
  AUDIO_SWITCH_WATCH_MS,
  DEFAULT_TARGET_S,
  DWELL_AFTER_SEEK_MS,
  EARLY_DELAY_MS,
  LEVER_SERIES,
  MUX_SERIES,
  MUX_SWITCH_WATCH_MS,
  FIRST_FRAME_TIMEOUT_MS,
  FREEZE_CHECK_MS,
  FreezeWatch,
  PRESETS,
  QUICK_SERIES,
  SERIES,
  comparisonRows,
  formatResult,
  modeLabel,
  modeTag,
  newSeed,
  planOf,
  playerLabel,
  qualityDelta,
  resultOf,
  runSeries,
  seekPositions,
  seriesEstimateS,
  seriesProgress,
  summaryBody,
  trialTag,
  type AudioCheck,
  type ComparisonCell,
  type ComparisonRow,
  type Cut,
  type PlayerKind,
  type PreparedVerdict,
  type Quality,
  type SeriesAnswers,
  type SeriesDriver,
  type SeriesOrder,
  type SeriesPass,
  type Trial,
  type TrialModes,
  type TrialMeasures,
  type TrialResult,
} from "./autoSeries";
import { currentPlayerInfo, openCurrentPlayer } from "./currentPlayer";
import {
  aheadOf,
  buildCascade,
  fetchServerChrono,
  lumenResourceName,
  probeLink,
  segmentsByRendition,
  summarizeCascades,
  syncClock,
  type Cascade,
  type CascadeMoments,
  type ChronoSummary,
  type ClockSync,
  type PageEvent,
  type ReceivedLike,
  type ResourceLike,
} from "./chronology";
import { analyzeMux, checkAudio, expectedAudio, switchTarget, trackOfUri, type ExpectedAudio, type MuxAnalysis, type MuxChecks, type MuxMetric } from "./muxPass";
import type { RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";

/**
 * La page de banc de Lumen serveur (`/lumen-test`, étape 3b de docs/remux-serveur/, DECISIONS §157,
 * administrateur seul).
 *
 * Elle existe pour une question qu'aucun banc Linux ne tranche : **Safari et AVFoundation savent-ils
 * démarrer un segment HLS sur une CRA, en jetant eux-mêmes les RASL qui la suivent ?** La norme HEVC le
 * prévoit (H.265 §8.1.3 : une CRA qui ouvre un accès aléatoire a `NoRaslOutputFlag` = 1, ses RASL ne sont
 * pas sorties) ; Safari sous MediaSource ne l'a jamais fait (*Ted Lasso* S02E01, « Media failed to
 * decode ») ; le HLS natif passe par un autre chemin. La réponse décide de la part de la bibliothèque que
 * Lumen serveur peut servir : les HEVC à GOP ouvert (défaut de x265) n'ont presque que des CRA, et sous la
 * découpe `idr` leurs segments dépassent 30 s.
 *
 * On y choisit un titre, une piste audio et une découpe (`idr` la règle, `cra` et `cra-leading` les essais), et
 * la page lit la liste maître de Lumen serveur dans un `<video>` en HLS natif. Elle mesure ce que la page
 * peut voir — première image, chaque saut, les blocages, les erreurs, les pistes audio annoncées par
 * `video.audioTracks` et ce qu'un changement fait, l'état du décodage — et « Envoyer les résultats » écrit
 * une ligne `kind: "lumen-test"` dans `startup.log`, où le serveur joint ce qu'il a vu des mêmes lectures :
 * segments remis, construction, envoi, et la trace de ce que Safari a demandé après chaque saut.
 *
 * « Tout enchaîner » (16/11/2026) déroule le protocole entier de l'étape 3b d'un seul appui (`autoSeries.ts` :
 * le plan, l'enchaînement, la détection des gels) et envoie une ligne par essai, marquée `auto`. Il lit dans
 * **le même `<video>`** que le mode manuel, en ne changeant que sa source : WebKit lève la restriction du son
 * pour un élément une fois qu'un geste l'a lancé, et un second élément la reperdrait. Il mesure en plus ce que
 * seul l'œil voyait jusque-là : les gels (position qui avance sans image présentée, `FreezeWatch`) et les
 * compteurs de décodage de chaque essai. Une image *présentée* mais abîmée reste invisible à la page — d'où les
 * deux questions de fin de série.
 *
 * Depuis l'étape 3c (17/11/2026), un **second lecteur** : le lecteur de production d'aujourd'hui (Lumen dans la
 * page : remux, MediaSource), ouvert par ses API publiques (`currentPlayer.ts`), joué dans le même `<video>` et
 * mesuré par les mêmes évènements — la page ne distingue les deux qu'à l'ouverture et à la fermeture. « Tout
 * enchaîner » et « Comparatif rapide » jouent chaque titre par les deux, avec les mêmes sauts (graine commune),
 * tous les essais serveur d'abord (WebKit refuse un HLS natif après une MediaSource dans une même page), et
 * finissent sur un tableau côte à côte. Une cible de segment d'essai (2 s) se choisit aussi à la main.
 *
 * Depuis l'étape 3e (17/11/2026, DECISIONS §160), **la chronologie** de chaque démarrage et de chaque saut
 * (`chronology.ts`) : les horloges de la page et du serveur synchronisées au début de chaque essai, chaque requête
 * de Safari horodatée par le serveur (arrivée, prête, premier et dernier morceau remis), chaque évènement de la
 * vidéo avec l'avance de `buffered` devant la position, et une cascade par démarrage et par saut — à l'écran et
 * dans la ligne. Puis **les leviers de démarrage** en modes d'essai (son multiplexé, préparation précoce, départ
 * par `EXT-X-START` ou `#t=`, débit annoncé moyen), et **l'ordre inversé** : le lecteur actuel d'abord, la page
 * rechargée, puis Lumen serveur — avec un « Touchez pour continuer » pour rendre le son à l'élément.
 *
 * Depuis l'étape 3f, **la passe « son multiplexé »** (bouton à part, `MUX_SERIES` et `muxPass.ts`) : quatre titres,
 * trois essais par mode en alternance, mêmes sauts ; la page y lit en plus la liste maître (une fois par titre et par
 * mode, sous un identifiant de lecture jetable) pour savoir quelle piste Safari doit allumer, vérifie celle qu'il
 * allume, change de piste une fois (vers une autre langue) en comptant les segments de la nouvelle piste qu'elle voit
 * arriver, et finit sur un verdict par titre contre la dispersion des répétitions. Les arrivées des segments côté page
 * (Resource Timing, que Safari expose aussi pour le HLS natif) entrent dans les cascades de toutes les passes.
 *
 * Textes en français : la page est pour l'administrateur de la maison, pas pour un rapport.
 */

// `cra` est la règle depuis le format 2 (DECISIONS §158, banc Safari du 16/11/2026) : l'index se construit
// depuis les Cues. `idr` et `cra-leading` restent des essais, pour refaire une comparaison.
const CUTS: { id: Cut; label: string; detail: string }[] = [
  { id: "cra", label: "cra (la règle)", detail: "coupe sur toute clé de l'index (IDR ou CRA), RASL gardées ; index des Cues" },
  { id: "idr", label: "idr (essai)", detail: "coupe seulement là où un décodeur repart seul ; chaque clé lue" },
  { id: "cra-leading", label: "cra-leading (essai)", detail: "cra, et chaque image nommée : is_leading RASL 1, RADL 3, autre 2" },
];

/**
 * Ce que l'index dit de ses clés : sous `idr`, les CRA à RASL parmi les clés lues ; sous la règle `cra`,
 * l'index des Cues ne lit que la première clé (§158) — le nombre de RASL n'y est pas connu, et ne compte plus.
 */
function keysLine(facts: Verdict["cutFacts"]): string {
  if (!facts) return "clés ?";
  if (facts.trusted) return `${facts.cuts} coupes, ${facts.trusted} prises des Cues sans lecture`;
  return `CRA à RASL vérifiées ${facts.craRasl}/${facts.verified}`;
}

interface AudioFacts {
  number: number;
  codec: string;
  language: string | null;
  name: string | null;
  channels: number;
  hlsChannels: string | null;
  isDefault: boolean;
  servable: boolean;
  refusal: string | null;
  /** §159 : `sbr-explicite`, `silence-devant`, `silence-derriere` — absent d'une réponse d'avant. */
  repairs?: string[];
}

interface Verdict {
  ok: boolean;
  pending?: boolean;
  reason?: string;
  detail?: string;
  version?: string;
  audioTrack: number | null;
  audio: AudioFacts[];
  segments?: number;
  durationS?: number;
  targetS?: number;
  cutFacts?: { cut: Cut; targetS?: number; longestS: number; verified: number; craRasl: number; cuts: number; trusted?: number };
  /** Demandé avec `mux=1` (étape 3e) : la version et l'adresse portent l'essai multiplexé. */
  muxed?: boolean;
}

/** Les cibles de segment proposées à la main : 4 s la règle, 2 s l'essai de l'étape 3c. */
const TARGETS = [DEFAULT_TARGET_S, 2] as const;

type SeekKind = "-10" | "+10" | "+60" | "hasard" | "parcours" | "barre" | "depart";

interface SeekMeasure {
  kind: SeekKind;
  from: number;
  to: number;
  startedAt: number;
  seekedMs?: number;
  advanceMs?: number;
  playingMs?: number;
  landed?: number;
  ok?: boolean;
  timedOut?: boolean;
  waits: number;
  error?: string;
}

interface AudioSwitch {
  from: string;
  to: string;
  startedAt: number;
  ms?: number;
  reloaded: boolean;
  changeEvent: boolean;
  /** Un `waiting` entre le changement et la reprise : le son a coûté une coupure. */
  waited: boolean;
  heard?: "oui" | "non";
  /** La position au changement : l'avance se mesure contre elle. */
  at: number;
  /** Tour des pistes de la série : erreurs et gels survenus dans les 8 s qui suivent le changement. */
  errors?: number;
  freezes?: number;
  /**
   * Passe « son multiplexé » (étape 3f) : le numéro Matroska de la piste visée (lu dans la liste maître), la piste
   * allumée à la fin de la fenêtre est-elle celle-là (`applied`), et les segments de cette piste que la page a vus
   * arriver depuis le changement (`segs`, Resource Timing) — la preuve que Safari a vraiment chargé l'autre son.
   */
  target?: number;
  applied?: boolean;
  segs?: number;
}

/** Une lecture : tout ce que la page en mesure, mutable pendant qu'elle dure (dans un `ref`). */
interface Run {
  itemId: string;
  title: string;
  /** Le lecteur de la lecture : Lumen serveur (HLS natif) ou le lecteur actuel (MediaSource). */
  player: PlayerKind;
  cut: Cut;
  /** La cible de segment du serveur (s). */
  targetS: number;
  /** Lecteur actuel : ce que le moteur a ouvert (vidéo, piste, son copié ou réencodé). */
  engine?: Record<string, string | undefined>;
  /** Lecteur actuel : la piste réellement ouverte. */
  openedAudio?: number | null;
  audio: number | null;
  s: string;
  version: string;
  verdict: Record<string, unknown>;
  clickAt: number;
  loadedMetadataMs?: number;
  firstFrameMs?: number;
  firstFrameVia?: "rvfc" | "playing";
  seeks: SeekMeasure[];
  pending: SeekMeasure | null;
  waits: { count: number; totalMs: number; maxMs: number };
  waitingSince: number | null;
  errors: string[];
  audioTracks: string[];
  audioSwitches: AudioSwitch[];
  quality?: Quality;
  /** Les compteurs de décodage à la première image : la ligne envoie la différence avec la fin (`qualityDelta`). */
  qualityStart?: Quality;
  /** Les images présentées et les gels (position qui avance sans image) — `requestVideoFrameCallback` seul. */
  watch: FreezeWatch;
  /** Un essai de « Tout enchaîner » : son nom et son rang dans la série. */
  trial?: string;
  rank?: number;
  end?: string;
  /** Les leviers de démarrage de la lecture (serveur, étape 3e) ; absent : la règle. */
  modes?: TrialModes;
  /** Le départ demandé (s), et la première image à cette position (±2 s) — un départ en milieu de film. */
  startAt: number;
  targetFrameMs?: number;
  /** La position de la toute première image présentée. */
  firstFrameAt?: number;
  /**
   * La source posée d'avance (`early: "élément"`) : tant que Lire n'est pas appuyé, aucune image ne compte. `clickAt`
   * est alors l'appui sur Lire, et `preloadAt` la pose de la source.
   */
  preloaded: boolean;
  preloadAt?: number;
  /** La chronologie (étape 3e) : les évènements de la vidéo, l'horloge, l'échantillon de débit, puis les cascades. */
  events: PageEvent[];
  clock: ClockSync | null;
  link: { mbps: number | null; ms: number; via: "rt" | "lecture"; MB: number } | null;
  cascades?: Cascade[];
  chrono?: ChronoSummary;
  rtLumen?: number;
  rtStream?: number;
  /** La relecture du relevé serveur et le calcul des cascades, en cours après la fermeture. */
  chronoDone?: Promise<void>;
  /** Le dernier `readyState` et la dernière avance notés par l'échantillonneur (100 ms). */
  sampled?: { rs: number; ahead: number | null };
  /** Les segments reçus par la page, par rendu (`v`, `vm2`, `a3` — Resource Timing, étape 3f). */
  rtSegs?: Record<string, number>;
  /** Passe « son multiplexé » : ce que la liste maître désigne, la piste allumée au départ, et le débit annoncé. */
  expected?: ExpectedAudio | null;
  audioCheck?: AudioCheck;
  streamMbps?: number;
}

/** Les évènements de la vidéo notés tels quels dans la chronologie (étape 3e). */
const CHRONO_EVENTS = [
  "loadstart",
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "canplaythrough",
  "play",
  "playing",
  "pause",
  "waiting",
  "seeking",
  "seeked",
  "progress",
  "stalled",
  "suspend",
  "emptied",
  "error",
  "ended",
] as const;

/**
 * Un évènement de plus dans la chronologie de la lecture : l'instant, le `readyState`, la position et l'avance de
 * `buffered` devant elle — ce qu'AVFoundation a déjà reçu et analysé. Jamais plus de `EVENTS_MAX` par lecture.
 */
function pushEvent(run: Run, video: HTMLVideoElement, e: string): void {
  if (run.events.length >= EVENTS_MAX) return;
  let ahead: number | null = null;
  try {
    ahead = aheadOf(video.buffered, video.currentTime);
  } catch {
    /* `buffered` illisible (source retirée) : sans avance */
  }
  run.events.push({ t: performance.now(), e, rs: video.readyState, ct: Math.round(video.currentTime * 10) / 10, ahead });
}

/**
 * Les fenêtres de cascade d'une lecture : le démarrage (de l'appui — ou de la source posée d'avance — à la
 * première image à la bonne position, plus 2 s), puis chaque saut (du geste à la reprise, plus 1,5 s).
 */
function momentsOf(run: Run): CascadeMoments[] {
  const out: CascadeMoments[] = [];
  const frameAt = run.firstFrameMs !== undefined ? run.clickAt + run.firstFrameMs : undefined;
  const targetAt = run.targetFrameMs !== undefined ? run.clickAt + run.targetFrameMs : undefined;
  const playing = run.events.find((e) => e.e === "playing" && e.t >= run.clickAt);
  out.push({
    kind: "départ",
    to: run.startAt,
    startedAt: run.clickAt,
    from: run.preloadAt,
    playingAt: playing?.t,
    frameAt: targetAt ?? frameAt,
    endAt: (targetAt ?? frameAt ?? run.clickAt + FIRST_FRAME_TIMEOUT_MS) + 2000,
  });
  for (const m of run.seeks) {
    const at = (v: number | undefined) => (v === undefined ? undefined : m.startedAt + v);
    out.push({
      kind: "saut",
      to: m.to,
      startedAt: m.startedAt,
      seekedAt: at(m.seekedMs),
      playingAt: at(m.playingMs),
      advanceAt: at(m.advanceMs),
      endAt: (at(m.advanceMs) ?? at(m.seekedMs) ?? m.startedAt + SEEK_TIMEOUT_MS) + 1500,
    });
  }
  return out;
}

/** Les entrées Resource Timing de la page, réduites à ce qu'une cascade lit. */
function resourcesNow(): ResourceLike[] {
  try {
    return (performance.getEntriesByType?.("resource") ?? []).map((e) => {
      const r = e as PerformanceResourceTiming;
      return { name: r.name, startTime: r.startTime, responseStart: r.responseStart, responseEnd: r.responseEnd, encodedBodySize: r.encodedBodySize };
    });
  } catch {
    return [];
  }
}

/** Les lignes d'écran des cascades d'une lecture : l'en-tête de chacune, puis ses requêtes et ses évènements. */
function cascadeLines(run: Run): string[] {
  const out: string[] = [];
  for (const c of run.cascades ?? []) {
    const head = [
      `${c.k === "départ" ? "DÉPART" : "SAUT"} → ${c.to} s`,
      c.firstReqMs !== undefined ? `1re requête +${c.firstReqMs}` : null,
      c.firstVideoReadyMs !== undefined ? `1er segment vidéo prêt +${c.firstVideoReadyMs}` : null,
      c.firstVideoSentMs !== undefined ? `remis +${c.firstVideoSentMs}` : null,
      c.frameMs !== undefined ? `image +${c.frameMs}` : null,
      c.seekedMs !== undefined ? `seeked +${c.seekedMs} (avance ${c.aheadSeekedS ?? "—"} s, ${c.videoSeeked ?? "?"} seg. v, ${c.sentSeekedMB ?? "?"} Mo remis)` : null,
      c.playingMs !== undefined ? `playing +${c.playingMs} (avance ${c.aheadPlayingS ?? "—"} s)` : null,
      c.advanceMs !== undefined ? `reprise +${c.advanceMs} (avance ${c.aheadAdvanceS ?? "—"} s, ${c.videoAdvance ?? "?"} seg. v, ${c.sentAdvanceMB ?? "?"} Mo remis)` : null,
      c.srvMbps !== undefined ? `remis à ${c.srvMbps} Mb/s` : null,
    ].filter(Boolean);
    out.push(head.join(" · "));
    for (const line of c.req) out.push(`   req ${line}`);
    for (const line of c.ev) out.push(`   ev  ${line}`);
  }
  return out;
}

/** Ce que sessionStorage garde d'une série pendant le rechargement de l'ordre `actuel`. */
interface SavedSeries {
  serie: string;
  pass: SeriesPass;
  order: SeriesOrder;
  seed: number;
  /** Le rang (0…) de l'essai par lequel reprendre. */
  index: number;
  results: TrialResult[];
  elapsedMs: number;
  outbox: Record<string, unknown>[];
  savedAt: number;
}

/** La série gardée pour reprise, ou null (rien, trop vieille, ou stockage refusé — la page se rend sans). */
function readSavedSeries(): SavedSeries | null {
  try {
    const raw = typeof window === "undefined" ? null : window.sessionStorage.getItem(SERIES_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedSeries;
    // Une heure : au-delà, ce n'est plus la même séance d'essai (réseau, cache disque, charge).
    if (!saved || typeof saved.index !== "number" || Date.now() - saved.savedAt > 60 * 60 * 1000) return null;
    return saved;
  } catch {
    return null;
  }
}

function forgetSavedSeries(): void {
  try {
    window.sessionStorage.removeItem(SERIES_KEY);
  } catch {
    /* rien */
  }
}

/** Au plus, par lecture : un parcours de 20 sauts en fait ~600 (évènements, `progress`, échantillons d'avance). */
const EVENTS_MAX = 2500;
/** L'échantillon de débit pris avant chaque essai : de quoi dépasser le démarrage lent de TCP, sans coûter une rafale. */
const PROBE_BYTES = 4 * 1024 * 1024;
/** La série en cours pendant un rechargement (ordre `actuel`) : sessionStorage, effacée à la reprise. */
const SERIES_KEY = "cine:lumen-test-serie";

/** Ce qu'une seconde d'avance du temps veut dire : la lecture a repris, pas un simple `timeupdate` du saut. */
const ADVANCE_S = 0.3;
/** Au-delà, un saut est déclaré manqué. */
const SEEK_TIMEOUT_MS = 20_000;

type AudioTrackLike = { id: string; label: string; language: string; enabled: boolean };
type AudioTrackListLike = { length: number; [index: number]: AudioTrackLike } & EventTarget;
type TestVideo = HTMLVideoElement & {
  audioTracks?: AudioTrackListLike;
  requestVideoFrameCallback?: (callback: () => void) => number;
};

const ms = (value: number) => Math.round(value);

/** Attend `duration` ms, par pas de 250 ms, et rend la main plus tôt si `stop()` le dit (« Arrêter »). */
async function sleepUnless(duration: number, stop: () => boolean): Promise<void> {
  const until = performance.now() + duration;
  while (!stop() && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, until - performance.now()))));
}

/** `play()` en promesse dans tous les cas : jsdom rend `undefined`, et une exception synchrone devient un refus. */
function playOf(video: HTMLVideoElement): Promise<void> {
  try {
    return Promise.resolve(video.play());
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Par le nom : un `DOMException` n'est pas un `Error` partout. */
const isNotAllowed = (error: unknown) => typeof error === "object" && error !== null && (error as { name?: unknown }).name === "NotAllowedError";

/**
 * La vidéo est-elle à l'écran ? Un navigateur peut cesser de présenter les images d'une vidéo sortie de la vue
 * (l'administrateur fait défiler pour lire les résultats) : sans cette garde, chaque défilement serait un gel.
 * Plein écran natif (iOS) : à l'écran.
 */
function onScreen(video: TestVideo): boolean {
  if ((video as TestVideo & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen) return true;
  const box = video.getBoundingClientRect();
  return box.bottom > 0 && box.top < window.innerHeight && box.width > 0;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)} min ${String(Math.floor(seconds % 60)).padStart(2, "0")} s`;

/** Ce que l'écran montre de la lecture en cours : relu dans les `ref` chaque seconde, jamais pendant le rendu. */
interface View {
  title: string;
  /** « serveur », « serveur 2 s », « actuel ». */
  player: string;
  cut: Cut;
  s: string;
  loadedMetadataMs?: number;
  firstFrameMs?: number;
  firstFrameVia?: string;
  seeks: number;
  missed: number;
  waits: Run["waits"];
  errors: number;
  t: number;
  paused: boolean;
  readyState: number;
  frames?: number;
  dropped?: number;
  corrupted?: number;
  tracks: string[];
  switched: boolean;
  heard?: "oui" | "non";
  freezes: number;
}

/** Ce que l'écran montre de la série : relu dans `autoRef` à chaque étape et chaque seconde, jamais au rendu. */
interface AutoView {
  phase: "en-cours" | "questions" | "envoyé";
  k: number;
  n: number;
  pass: SeriesPass;
  title: string;
  player: string;
  step: string;
  elapsedS: number;
  progress: number;
  results: string[];
  /** Le tableau côte à côte, une fois la série finie. */
  comparison: ComparisonRow[];
  /** Les essais finis, pour le tableau de la chronologie. */
  trials: TrialResult[];
  /** La passe « son multiplexé » finie : le verdict par titre (`muxPass.ts`). */
  mux: MuxAnalysis | null;
  order: SeriesOrder;
  stopped: boolean;
  sent: string | null;
}

/** L'état de la série, mutable pendant qu'elle dure. */
interface AutoState {
  serie: string;
  pass: SeriesPass;
  order: SeriesOrder;
  plan: Trial[];
  /** La graine des positions de saut : la même pour les deux lecteurs d'un titre, portée par chaque ligne. */
  seed: number;
  startedAt: number;
  phase: AutoView["phase"];
  stopped: boolean;
  index: number;
  trialStartedAt: number;
  step: string;
  results: TrialResult[];
  sent: string | null;
}

function qualityOf(video: TestVideo | null): Run["quality"] {
  const q = video?.getVideoPlaybackQuality?.();
  return q ? { total: q.totalVideoFrames, dropped: q.droppedVideoFrames, corrupted: (q as VideoPlaybackQuality & { corruptedVideoFrames?: number }).corruptedVideoFrames ?? 0 } : undefined;
}

function viewOf(run: Run | null, video: TestVideo | null): View | null {
  if (!run) return null;
  const q = qualityOf(video);
  const last = run.audioSwitches.at(-1);
  return {
    title: run.title,
    player: playerLabel(run),
    cut: run.cut,
    s: run.s,
    loadedMetadataMs: run.loadedMetadataMs,
    firstFrameMs: run.firstFrameMs,
    firstFrameVia: run.firstFrameVia,
    seeks: run.seeks.length,
    missed: run.seeks.filter((m) => !m.ok).length,
    waits: { ...run.waits },
    errors: run.errors.length,
    t: video?.currentTime ?? 0,
    paused: video?.paused ?? true,
    readyState: video?.readyState ?? 0,
    frames: q?.total,
    dropped: q?.dropped,
    corrupted: q?.corrupted,
    tracks: tracksOf(video).map(describeTrack),
    switched: !!last,
    heard: last?.heard,
    freezes: run.watch.freezes.length,
  };
}

function autoViewOf(state: AutoState | null): AutoView | null {
  if (!state) return null;
  const now = performance.now();
  const plan = state.plan;
  const trial = plan[Math.min(state.index, plan.length - 1)];
  return {
    phase: state.phase,
    k: Math.min(state.index + 1, plan.length),
    n: plan.length,
    pass: state.pass,
    title: trial.title,
    player: `${playerLabel(trial)}${trial.modes ? ` (${modeLabel(trial.modes)})` : ""}`,
    step: state.step,
    elapsedS: (now - state.startedAt) / 1000,
    progress: state.phase === "en-cours" ? seriesProgress(plan, state.index, (now - state.trialStartedAt) / 1000) : 1,
    results: state.results.map(formatResult),
    // La passe « son multiplexé » a son propre tableau : le comparatif des deux lecteurs n'y a pas de sens.
    comparison: state.phase === "en-cours" || state.pass === "multiplexé" ? [] : comparisonRows(state.results),
    trials: state.phase === "en-cours" ? [] : state.results,
    mux: state.phase === "en-cours" || state.pass !== "multiplexé" ? null : analyzeMux(state.results),
    order: state.order,
    stopped: state.stopped,
    sent: state.sent,
  };
}

/**
 * La liste maître d'un essai de la passe « son multiplexé » (étape 3f), lue par la page sous un identifiant de lecture
 * jetable — ni la chronologie ni le relevé de l'essai ne la comptent : la piste que Safari doit allumer, l'ordre des
 * rendus, le débit annoncé. Null si elle ne se lit pas : l'essai continue, sa piste n'est simplement pas jugée.
 */
async function readMaster(itemId: string, version: string, audioTrack: number | null): Promise<ExpectedAudio | null> {
  try {
    const res = await fetch(`/api/lumen/${itemId}/${version}/${newPlaybackId()}/master.m3u8${audioTrack !== null ? `?audio=${audioTrack}` : ""}`, { cache: "no-store" });
    if (!res.ok) return null;
    return expectedAudio(await res.text());
  } catch {
    return null;
  }
}

function newPlaybackId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `lt${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function tracksOf(video: TestVideo | null): AudioTrackLike[] {
  const list = video?.audioTracks;
  if (!list || typeof list.length !== "number") return [];
  const out: AudioTrackLike[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

function describeTrack(track: AudioTrackLike | undefined, index: number): string {
  return track ? `${index}:${track.language || "?"}:${track.label || "?"}:${track.enabled ? "on" : "off"}` : `${index}:—`;
}

/** Ce que la série retient d'une lecture pour sa ligne de résultat (`resultOf`). */
function measuresOf(run: Run): TrialMeasures {
  return {
    firstFrameMs: run.firstFrameMs,
    targetFrameMs: run.targetFrameMs,
    chrono: run.chrono,
    linkMbps: run.link?.mbps ?? undefined,
    seeks: run.seeks,
    freezes: run.watch.freezes,
    errors: run.errors,
    waits: run.waits.count,
    quality: qualityDelta(run.qualityStart, run.quality),
    audioSwitches: run.audioSwitches,
    ...(run.audioCheck ? { audioCheck: run.audioCheck } : {}),
    ...(run.streamMbps !== undefined ? { streamMbps: run.streamMbps } : {}),
  };
}

/** Ce qui part au serveur d'une lecture : sans les horodatages internes. */
function reportOf(run: Run): Record<string, unknown> {
  const seek = (m: SeekMeasure) => ({
    kind: m.kind,
    from: Math.round(m.from * 10) / 10,
    to: Math.round(m.to * 10) / 10,
    seekedMs: m.seekedMs,
    advanceMs: m.advanceMs,
    playingMs: m.playingMs,
    landed: m.landed === undefined ? undefined : Math.round(m.landed * 10) / 10,
    ok: m.ok,
    timedOut: m.timedOut,
    waits: m.waits,
    error: m.error,
  });
  return {
    itemId: run.itemId,
    title: run.title,
    player: run.player,
    // La découpe et la cible ne disent quelque chose que du serveur ; le lecteur actuel lit le fichier entier.
    ...(run.player === "serveur" ? { cut: run.cut, targetS: run.targetS } : { engine: run.engine, openedAudio: run.openedAudio ?? undefined }),
    audio: run.audio,
    s: run.s,
    version: run.version,
    verdict: run.verdict,
    trial: run.trial,
    rank: run.rank,
    loadedMetadataMs: run.loadedMetadataMs,
    firstFrameMs: run.firstFrameMs,
    firstFrameVia: run.firstFrameVia,
    seeks: run.seeks.map(seek),
    waits: run.waits,
    errors: run.errors,
    // Sans `requestVideoFrameCallback`, rien n'est compté : l'absence de `framesPresented` dit que les gels n'ont
    // pas été cherchés (et non qu'il n'y en a pas eu).
    framesPresented: run.watch.presented || undefined,
    freezes: run.watch.freezes.map(({ at, ms: took, afterSeek, until }) => ({ at, ms: took, afterSeek, until })),
    audioTracks: run.audioTracks,
    audioSwitches: run.audioSwitches.map(({ from, to, ms: took, reloaded, changeEvent, waited, heard, errors, freezes, target, applied, segs }) => ({
      from,
      to,
      ms: took,
      reloaded,
      changeEvent,
      waited,
      heard,
      errors,
      freezes,
      target,
      applied,
      segs,
    })),
    audioCheck: run.audioCheck,
    streamMbps: run.streamMbps,
    quality: run.quality,
    qualityStart: run.qualityStart,
    qualityDelta: qualityDelta(run.qualityStart, run.quality),
    end: run.end,
    ...(run.modes ? { mode: modeTag(run.modes) } : {}),
    ...(run.startAt ? { startAt: run.startAt } : {}),
    targetFrameMs: run.targetFrameMs,
    firstFrameAt: run.firstFrameAt === undefined ? undefined : Math.round(run.firstFrameAt * 10) / 10,
    chrono: {
      clock: run.clock ?? undefined,
      link: run.link ?? undefined,
      rtLumen: run.rtLumen,
      rtStream: run.rtStream,
      rtSegs: run.rtSegs,
      summary: run.chrono,
      cascades: run.cascades,
    },
  };
}

/** Une ligne envoyée sans réponse exploitable ; gardée pour le prochain envoi (au plus 30). */
const OUTBOX_MAX = 30;

export function LumenTest() {
  const videoRef = useRef<TestVideo | null>(null);
  const runRef = useRef<Run | null>(null);
  const doneRef = useRef<Run[]>([]);
  const startAtRef = useRef(0);
  const tourRef = useRef(0);
  const seekDone = useRef<(() => void) | null>(null);
  // Le journal lu hors du rendu : chaque ligne d'essai emporte les lignes écrites depuis son début.
  const logRef = useRef<string[]>([]);
  const logCountRef = useRef(0);
  const envRef = useRef<Record<string, unknown> | null>(null);
  const autoRef = useRef<AutoState | null>(null);
  const outboxRef = useRef<Record<string, unknown>[]>([]);
  // « Touchez pour continuer » : le `play()` refusé attend un geste ; `tapRef` le relâche.
  const tapRef = useRef<(() => void) | null>(null);
  const refusedRef = useRef(false);
  // Le lecteur actuel ouvert dans la vidéo (sa MediaSource), détruit à la fermeture de la lecture.
  const engineRef = useRef<RemuxPlayback | null>(null);

  const [itemId, setItemId] = useState("");
  const [title, setTitle] = useState("");
  const [cut, setCut] = useState<Cut>("cra");
  const [player, setPlayer] = useState<PlayerKind>("serveur");
  const [target, setTarget] = useState<number>(DEFAULT_TARGET_S);
  const [audio, setAudio] = useState<number | null>(null);
  const [startAt, setStartAt] = useState("0");
  const [tourCount, setTourCount] = useState("10");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [view, setView] = useState<View | null>(null);
  const [env, setEnv] = useState<{ userAgent: string; standalone: boolean; hlsNative: string; managedMediaSource: boolean; screen: string } | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [touring, setTouring] = useState(false);
  const [auto, setAuto] = useState<AutoView | null>(null);
  const [needTap, setNeedTap] = useState(false);
  const [answers, setAnswers] = useState<SeriesAnswers>({ damaged: null, damagedTitle: "", audioClean: null, audioChanged: null, lipSync: null });
  // Étape 3e : l'ordre des lecteurs d'une série, les leviers du mode manuel, la série à reprendre après un
  // rechargement (lue une fois, au montage : la page ne se rend que dans le navigateur), les cascades affichées.
  const [order, setOrder] = useState<SeriesOrder>("serveur");
  const [modes, setModes] = useState<TrialModes>({});
  const [resume, setResume] = useState<SavedSeries | null>(() => readSavedSeries());
  const [cascadeView, setCascadeView] = useState<{ title: string; lines: string[] } | null>(null);

  // Un écran qui s'éteint au milieu de la série met la page en arrière-plan et Safari en pause : le verrou est
  // demandé pendant toute la série, et redemandé au retour au premier plan (`useWakeLock`, partagé avec les
  // lecteurs, chaque demande dans son try/catch — un refus n'arrête rien).
  useWakeLock(auto?.phase === "en-cours");

  const note = useCallback((line: string) => {
    const at = (performance.now() / 1000).toFixed(1);
    const entry = `${at}s ${line}`;
    logRef.current = [...logRef.current.slice(-399), entry];
    logCountRef.current += 1;
    setLog((lines) => [...lines.slice(-299), entry]);
  }, []);
  const refresh = useCallback(() => setView(viewOf(runRef.current, videoRef.current)), []);
  const refreshAuto = useCallback(() => setAuto(autoViewOf(autoRef.current)), []);

  /** Un saut fini (ou manqué) : rangé dans la lecture, et la promesse du parcours relâchée. */
  const finishSeek = useCallback(
    (run: Run, outcome: { ok: boolean; timedOut?: boolean; error?: string }) => {
      const m = run.pending;
      if (!m) return;
      run.pending = null;
      Object.assign(m, outcome);
      run.seeks.push(m);
      note(
        `saut ${m.kind} ${m.from.toFixed(1)} → ${m.to.toFixed(1)} s : ${m.ok ? "repris" : m.timedOut ? "MANQUÉ (20 s)" : "erreur"} · seeked ${m.seekedMs ?? "—"} ms · avance ${m.advanceMs ?? "—"} ms${m.waits ? ` · ${m.waits} attente(s)` : ""}`
      );
      const done = seekDone.current;
      seekDone.current = null;
      done?.();
      refresh();
    },
    [note, refresh]
  );

  // L'environnement, une fois monté ; puis l'état de la vidéo et le délai des sauts, chaque seconde ; et les gels,
  // toutes les 2 s (`FREEZE_CHECK_MS`).
  useEffect(() => {
    // Resource Timing garde 250 entrées par défaut : un essai du lecteur actuel en fait des centaines (ses plages
    // d'octets), et la chronologie les relit. Vidé à chaque nouvelle lecture (`startRun`).
    try {
      performance.setResourceTimingBufferSize?.(5000);
    } catch {
      /* rien */
    }
    const first = setTimeout(() => {
      const video = document.createElement("video");
      const nav = navigator as Navigator & { standalone?: boolean };
      const facts = {
        userAgent: navigator.userAgent,
        standalone: window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true,
        hlsNative: video.canPlayType("application/vnd.apple.mpegurl") || "non",
        managedMediaSource: "ManagedMediaSource" in window,
        screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
      };
      envRef.current = facts;
      setEnv(facts);
    }, 0);
    let lastFreezeCheck = 0;
    const timer = setInterval(() => {
      const run = runRef.current;
      const now = performance.now();
      if (run?.pending && now - run.pending.startedAt > SEEK_TIMEOUT_MS) finishSeek(run, { ok: false, timedOut: true });
      const video = videoRef.current;
      // Page cachée ou vidéo hors de la vue : `requestVideoFrameCallback` peut se taire alors que le son continue —
      // ce ne serait pas un gel. On repart alors de la position courante, et on juge de nouveau une fois revenu.
      if (run && video && now - lastFreezeCheck >= FREEZE_CHECK_MS - 50) {
        lastFreezeCheck = now;
        if (document.visibilityState !== "visible" || !onScreen(video)) run.watch.rebase(now, video.currentTime, false);
        else {
          const freeze = run.watch.check(now, video.currentTime);
          if (freeze) note(`GEL : la position avance sans nouvelle image depuis ${freeze.at.toFixed(1)} s${freeze.afterSeek ? " (après un saut)" : ""}`);
        }
      }
      refresh();
      if (autoRef.current?.phase === "en-cours") refreshAuto();
    }, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [finishSeek, note, refresh, refreshAuto]);

  // Retour au premier plan : la position a pu avancer sans image (page cachée) ; on repart d'elle.
  useEffect(() => {
    const onVisibility = () => {
      const run = runRef.current;
      const video = videoRef.current;
      if (document.visibilityState === "visible" && run && video) run.watch.rebase(performance.now(), video.currentTime, false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Les évènements de la vidéo, branchés une fois : chacun met à jour la lecture en cours.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const now = () => performance.now();
    const endWait = (run: Run) => {
      if (run.waitingSince === null) return;
      const took = now() - run.waitingSince;
      run.waitingSince = null;
      run.waits.count += 1;
      run.waits.totalMs += ms(took);
      run.waits.maxMs = Math.max(run.waits.maxMs, ms(took));
      note(`blocage terminé : ${ms(took)} ms`);
    };
    const handlers: Record<string, () => void> = {
      loadedmetadata: () => {
        const run = runRef.current;
        if (!run) return;
        run.loadedMetadataMs ??= ms(now() - run.clickAt);
        run.audioTracks = tracksOf(video).map(describeTrack);
        note(`loadedmetadata à ${run.loadedMetadataMs} ms · durée ${video.duration.toFixed(1)} s · ${run.audioTracks.length} piste(s) audio`);
        if (startAtRef.current > 0) {
          // Un départ en milieu de film est un saut comme un autre : sur un segment qui s'ouvre sur une CRA
          // sous `cra`, c'est exactement le cas à éprouver.
          run.pending = { kind: "depart", from: 0, to: startAtRef.current, startedAt: now(), waits: 0 };
          video.currentTime = startAtRef.current;
          note(`départ demandé à ${startAtRef.current} s`);
        }
      },
      playing: () => {
        const run = runRef.current;
        if (!run) return;
        if (run.firstFrameMs === undefined && !run.preloaded && !video.requestVideoFrameCallback) {
          run.firstFrameMs = ms(now() - run.clickAt);
          run.firstFrameVia = "playing";
          run.qualityStart = qualityOf(video);
          note(`première image (playing) : ${run.firstFrameMs} ms`);
        }
        if (run.pending && run.pending.seekedMs !== undefined && run.pending.playingMs === undefined) run.pending.playingMs = ms(now() - run.pending.startedAt);
        endWait(run);
      },
      waiting: () => {
        const run = runRef.current;
        if (!run) return;
        for (const sw of run.audioSwitches) if (sw.ms === undefined) sw.waited = true;
        note(`waiting à ${video.currentTime.toFixed(1)} s`);
        // L'attente d'un saut est celle du saut ; un blocage, c'est une attente en pleine lecture.
        if (run.pending) run.pending.waits += 1;
        else run.waitingSince ??= now();
      },
      seeking: () => {
        const run = runRef.current;
        if (!run) return;
        // Le gel se juge de nouveau depuis la cible : l'image d'avant le saut n'a plus à changer.
        run.watch.rebase(now(), video.currentTime);
        if (run.pending) return;
        // Un saut que la page n'a pas demandé : la barre native, ou le départ à une position.
        run.pending = { kind: "barre", from: video.currentTime, to: video.currentTime, startedAt: now(), waits: 0 };
      },
      seeked: () => {
        const run = runRef.current;
        // Safari peut atterrir avant la cible (début du segment) : la référence est là où il a atterri.
        run?.watch.rebase(now(), video.currentTime);
        const m = run?.pending;
        if (!m || m.seekedMs !== undefined) return;
        m.seekedMs = ms(now() - m.startedAt);
        m.landed = video.currentTime;
      },
      timeupdate: () => {
        const run = runRef.current;
        if (!run) return;
        const m = run.pending;
        if (m && m.landed !== undefined && video.currentTime > m.landed + ADVANCE_S) {
          m.advanceMs = ms(now() - m.startedAt);
          pushEvent(run, video, "reprise");
          finishSeek(run, { ok: true });
        }
        for (const sw of run.audioSwitches) {
          if (sw.ms === undefined && video.currentTime > sw.at + ADVANCE_S) {
            sw.ms = ms(now() - sw.startedAt);
            note(`piste audio : le temps avance de nouveau ${sw.ms} ms après le changement${sw.reloaded ? " (élément rechargé)" : ""}`);
          }
        }
        if (run.waitingSince !== null && !video.paused && video.readyState >= 3) endWait(run);
      },
      error: () => {
        const run = runRef.current;
        const e = video.error;
        const line = e ? `code=${e.code} ${e.message || ""}`.trim() : "erreur sans MediaError";
        run?.errors.push(line);
        if (run?.pending) finishSeek(run, { ok: false, error: line });
        note(`ERREUR ${line}`);
      },
      emptied: () => {
        const run = runRef.current;
        for (const sw of run?.audioSwitches ?? []) if (sw.ms === undefined) sw.reloaded = true;
      },
      loadstart: () => {
        const run = runRef.current;
        for (const sw of run?.audioSwitches ?? []) if (sw.ms === undefined) sw.reloaded = true;
      },
      stalled: () => note("stalled"),
      ended: () => note("ended"),
    };
    // La chronologie (étape 3e) : chaque évènement noté avec l'avance de `buffered`, avant le traitement propre à
    // chacun (un `seeked` est noté avant que la mesure du saut ne le lise).
    const chronoHandlers = CHRONO_EVENTS.map((type) => {
      const handler = () => {
        const run = runRef.current;
        if (run) pushEvent(run, video, type);
      };
      video.addEventListener(type, handler);
      return [type, handler] as const;
    });
    // L'échantillonneur : les changements de `readyState` sans évènement propre, et l'avance qui grandit (d'une
    // seconde au moins) entre deux `progress` — de quoi voir à quel rythme AVFoundation remplit sa réserve.
    const sampler = setInterval(() => {
      const run = runRef.current;
      if (!run) return;
      const rs = video.readyState;
      let ahead: number | null = null;
      try {
        ahead = aheadOf(video.buffered, video.currentTime);
      } catch {
        /* rien */
      }
      const last = run.sampled;
      if (!last || last.rs !== rs) pushEvent(run, video, "rs");
      else if (ahead !== null && (last.ahead === null || Math.abs(ahead - last.ahead) >= 1)) pushEvent(run, video, "buf");
      else return;
      run.sampled = { rs, ahead };
    }, 100);
    for (const [type, handler] of Object.entries(handlers)) video.addEventListener(type, handler);
    // `audioTracks` n'existe que sur WebKit (Chromium le cache derrière un drapeau) ; jsdom en a une ébauche sans évènements.
    const tracks = typeof video.audioTracks?.addEventListener === "function" ? video.audioTracks : undefined;
    const onTracks = () => {
      const run = runRef.current;
      if (!run) return;
      run.audioTracks = tracksOf(video).map(describeTrack);
      for (const sw of run.audioSwitches) if (sw.ms === undefined) sw.changeEvent = true;
      refresh();
    };
    tracks?.addEventListener("change", onTracks);
    tracks?.addEventListener("addtrack", onTracks);
    return () => {
      clearInterval(sampler);
      for (const [type, handler] of chronoHandlers) video.removeEventListener(type, handler);
      for (const [type, handler] of Object.entries(handlers)) video.removeEventListener(type, handler);
      tracks?.removeEventListener("change", onTracks);
      tracks?.removeEventListener("addtrack", onTracks);
    };
  }, [finishSeek, note, refresh]);

  /** Le verdict du serveur pour ce titre, cette piste et cette découpe ; l'index se construit au besoin. */
  const prepare = async (id = itemId, audioTrack = audio, chosenCut = cut, targetS = target, mux = !!modes.mux) => {
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      setBusy("Identifiant Jellyfin attendu (32 caractères hexadécimaux).");
      return null;
    }
    setBusy("Préparation (l'index d'un fichier jamais lu prend 2 à 30 s)…");
    const began = performance.now();
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const query = new URLSearchParams({ wait: "25000", cut: chosenCut });
        if (targetS !== DEFAULT_TARGET_S) query.set("target", String(targetS));
        if (audioTrack !== null) query.set("audio", String(audioTrack));
        // L'essai multiplexé (levier a, étape 3e) : la version rendue porte `m1`, la liste maître désigne la piste dans la vidéo.
        if (mux) query.set("mux", "1");
        const res = await fetch(`/api/lumen/${id}/eligibility?${query}`);
        const body = (await res.json().catch(() => null)) as Verdict | null;
        if (res.status === 202 || body?.pending) continue;
        if (!res.ok || !body) {
          setBusy(`Refusé par le serveur (HTTP ${res.status}).`);
          note(`éligibilité : HTTP ${res.status}`);
          return null;
        }
        body.muxed = mux;
        setVerdict(body);
        setAudio(body.audioTrack);
        setBusy(null);
        note(
          `éligibilité ${chosenCut}${targetS !== DEFAULT_TARGET_S ? ` (cible ${targetS} s)` : ""} en ${ms(performance.now() - began)} ms : ${body.ok ? "ok" : `refus ${body.reason}${body.detail ? ` (${body.detail})` : ""}`} · ${body.segments ?? "?"} segments · le plus long ${body.cutFacts?.longestS ?? "?"} s · ${keysLine(body.cutFacts)}`
        );
        return body;
      }
      setBusy("L'index n'est toujours pas prêt : réessayer dans un moment.");
    } catch (error) {
      setBusy(`Réseau : ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  };

  /** Ferme la lecture en cours : son dernier état de décodage, puis rangée avec les autres. */
  const closeRun = (end: string) => {
    const run = runRef.current;
    const video = videoRef.current;
    if (!run) return;
    if (run.pending) finishSeek(run, { ok: false, error: "lecture arrêtée" });
    run.watch.end(performance.now());
    run.quality = qualityOf(video ?? null) ?? run.quality;
    run.end = end;
    doneRef.current = [...doneRef.current, run].slice(-12);
    runRef.current = null;
    // Le lecteur actuel : sa MediaSource fermée, l'élément rendu sans source (`destroy`), après le dernier relevé.
    engineRef.current?.destroy();
    engineRef.current = null;
    if (video) video.preload = "none";
    // La chronologie : Resource Timing lu tout de suite (la lecture suivante le vide), puis le relevé du serveur relu
    // et les cascades dessinées — en arrière-plan ; l'envoi de la ligne l'attend (`chronoDone`).
    const resources = resourcesNow();
    run.chronoDone = finalizeChrono(run, resources);
  };

  /**
   * Les cascades d'une lecture fermée (étape 3e) : le relevé du serveur pour Lumen serveur (ses requêtes ramenées sur
   * l'horloge de la page), Resource Timing pour le lecteur actuel (ses propres requêtes de plages), et les évènements
   * de la vidéo. Ce que Resource Timing voit des requêtes HLS de Safari est compté à part (`rtLumen`) : sur iPhone, on
   * s'attend à rien — le chargeur d'AVFoundation n'est pas celui de la page.
   */
  const finalizeChrono = async (run: Run, resources: ResourceLike[]): Promise<void> => {
    run.rtLumen = resources.filter((r) => /\/api\/lumen\/[^/]+\/[^/]+\/[^/]+\/(?:master|v|vm\d+|a\d+|init-)/.test(r.name)).length;
    const stream = resources.filter((r) => r.name.includes("/api/jellyfin/stream"));
    run.rtStream = stream.length;
    // Ce que la page a vu arriver de Lumen serveur (étape 3f) : Safari expose les requêtes HLS à Resource Timing.
    const received: ReceivedLike[] =
      run.player === "serveur"
        ? resources.flatMap((r) => {
            const name = lumenResourceName(r.name, run.s);
            return name ? [{ name, startTime: r.startTime, responseEnd: r.responseEnd, bytes: r.encodedBodySize }] : [];
          })
        : [];
    if (received.length) run.rtSegs = segmentsByRendition(received);
    const entries = run.player === "serveur" && run.clock ? await fetchServerChrono(run.itemId, run.s) : null;
    run.cascades = momentsOf(run).map((m) =>
      buildCascade(m, run.events, run.player === "serveur" ? { entries: entries ?? [], clock: run.clock, timeOrigin: performance.timeOrigin, received } : { resources: stream })
    );
    run.chrono = summarizeCascades(run.cascades);
    note(`chronologie ${run.title} · ${playerLabel(run)} : ${run.cascades.length} cascade(s)${run.clock ? ` · horloge ±${Math.round(run.clock.rttMs / 2)} ms` : ""}${entries ? ` · ${entries.length} requête(s) vues du serveur` : ""} · Resource Timing : ${run.rtLumen} requête(s) HLS, ${run.rtStream} plage(s) du lecteur actuel`);
    setCascadeView({ title: `${run.title} · ${playerLabel(run)}${run.modes ? ` (${modeLabel(run.modes)})` : ""}`, lines: cascadeLines(run) });
  };

  /**
   * Compte les images présentées tant que `run` est la lecture en cours : la première donne le temps jusqu'à
   * l'image, chacune nourrit la détection des gels. La position notée est `currentTime` au rappel, pas le
   * `mediaTime` des métadonnées : c'est contre `currentTime` que les gels se jugent, et en HLS les deux
   * horloges ne partent pas forcément du même zéro.
   */
  const watchFrames = (video: TestVideo, run: Run) => {
    if (!video.requestVideoFrameCallback) return;
    function onFrame() {
      if (runRef.current !== run || !video.requestVideoFrameCallback) return; // une autre lecture : la boucle s'éteint
      const now = performance.now();
      // Une source posée d'avance (`early: "élément"`) peut présenter une image avant Lire : elle ne compte pas.
      if (!run.preloaded) {
        if (run.firstFrameMs === undefined) {
          run.firstFrameMs = ms(now - run.clickAt);
          run.firstFrameVia = "rvfc";
          run.firstFrameAt = video.currentTime;
          run.qualityStart = qualityOf(video);
          pushEvent(run, video, "image");
          note(`première image (requestVideoFrameCallback) : ${run.firstFrameMs} ms à ${video.currentTime.toFixed(1)} s`);
          refresh();
        }
        // La première image à la position demandée : la mesure d'un départ en milieu de film (levier c).
        if (run.targetFrameMs === undefined && Math.abs(video.currentTime - run.startAt) <= 2) {
          run.targetFrameMs = ms(now - run.clickAt);
          if (run.startAt > 0) {
            pushEvent(run, video, "image-départ");
            note(`première image à la position de départ (${run.startAt} s) : ${run.targetFrameMs} ms`);
          }
        }
        run.watch.frame(now, video.currentTime);
      }
      video.requestVideoFrameCallback(onFrame);
    }
    video.requestVideoFrameCallback(onFrame);
  };

  /**
   * Ouvre une lecture de la liste maître dans la vidéo : la lecture précédente fermée, la nouvelle mesurée.
   * Partagé par « Lire » et la série ; ne lance pas `play()` (chacun le fait à sa façon).
   */
  const startRun = (params: {
    itemId: string;
    title: string;
    player: PlayerKind;
    cut: Cut;
    targetS: number;
    startAt: number;
    verdict: Verdict;
    clickAt: number;
    /** L'identifiant de lecture, tiré avant la synchronisation des horloges (qui le marque chronométré). */
    s: string;
    chrono: { clock: ClockSync | null; link: Run["link"] };
    modes?: TrialModes;
    /** Poser la source sans lire (`early: "élément"`) : Lire viendra plus tard (`armRun`). */
    preload?: boolean;
  }): Run | null => {
    const video = videoRef.current;
    const current = params.verdict;
    if (!video || (params.player === "serveur" && !current.version)) return null;
    tourRef.current += 1; // un parcours en cours s'arrête
    closeRun("nouvelle lecture");
    try {
      performance.clearResourceTimings?.();
    } catch {
      /* rien */
    }
    const s = params.s;
    const startAt = Math.max(0, params.startAt);
    const startMode = params.modes?.startMode ?? "saut";
    // Les essais de la seule liste maître (étape 3e) : `?start=` (EXT-X-START), `?bw=moyen` ; `#t=` sur l'adresse.
    const query = new URLSearchParams();
    if (current.audioTrack !== null) query.set("audio", String(current.audioTrack));
    if (startAt > 0 && startMode === "ext-x-start") query.set("start", String(startAt));
    if (params.modes?.bandwidth === "moyen") query.set("bw", "moyen");
    const search = query.toString();
    const master = `/api/lumen/${params.itemId}/${current.version}/${s}/master.m3u8${search ? `?${search}` : ""}${startAt > 0 && startMode === "fragment" ? `#t=${startAt}` : ""}`;
    // Le lecteur actuel s'ouvre à la position demandée (`startSeconds`, comme l'hôte) : pas de saut de départ ; Lumen
    // serveur saute à `loadedmetadata` sous la règle (`saut`), et pas sous `EXT-X-START` ni `#t=`.
    startAtRef.current = params.player === "serveur" && startMode === "saut" ? startAt : 0;
    const run: Run = {
      itemId: params.itemId,
      title: params.title || params.itemId,
      player: params.player,
      cut: params.cut,
      targetS: params.targetS,
      audio: current.audioTrack,
      s,
      version: current.version ?? "",
      verdict: { ok: current.ok, segments: current.segments, longestS: current.cutFacts?.longestS, targetS: current.targetS, craRasl: current.cutFacts?.craRasl, verified: current.cutFacts?.verified, durationS: current.durationS },
      clickAt: params.clickAt,
      seeks: [],
      pending: null,
      waits: { count: 0, totalMs: 0, maxMs: 0 },
      waitingSince: null,
      errors: [],
      audioTracks: [],
      audioSwitches: [],
      watch: new FreezeWatch(),
      modes: params.modes && Object.keys(params.modes).length ? params.modes : undefined,
      startAt,
      preloaded: !!params.preload,
      preloadAt: params.preload ? params.clickAt : undefined,
      events: [],
      clock: params.chrono.clock,
      link: params.chrono.link,
    };
    runRef.current = run;
    note(
      `lecture ${run.title} · ${playerLabel(run)}${run.player === "serveur" ? ` · ${params.cut}` : ""}${run.modes ? ` · ${modeLabel(run.modes)}` : ""} · piste ${current.audioTrack ?? "—"} · ${s}${run.clock ? ` · horloge ${run.clock.offsetMs} ms ±${Math.round(run.clock.rttMs / 2)}` : ""}${run.link?.mbps ? ` · lien ${run.link.mbps} Mb/s` : ""}`
    );
    watchFrames(video, run);
    if (run.player === "serveur") {
      // La fiche ouverte d'avance : Safari charge listes, init et premiers segments avant Lire.
      if (params.preload) video.preload = "auto";
      video.src = master;
    }
    refresh();
    return run;
  };

  /** Lire, après une source posée d'avance : l'appui devient l'origine de la mesure. */
  const armRun = (run: Run) => {
    run.preloaded = false;
    run.clickAt = performance.now();
    const video = videoRef.current;
    if (video) pushEvent(run, video, "lire");
  };

  /**
   * Avant une lecture serveur : l'identifiant de lecture, les horloges synchronisées (ce qui marque la lecture
   * chronométrée), et un échantillon du débit vers l'appareil. Le lecteur actuel n'a que l'échantillon : ses
   * requêtes, la page les voit elle-même (Resource Timing).
   */
  const chronoBefore = async (id: string, player: PlayerKind): Promise<{ s: string; clock: ClockSync | null; link: Run["link"] }> => {
    const s = newPlaybackId();
    const clock = player === "serveur" ? await syncClock(id, s) : null;
    const probe = await probeLink(id, s, PROBE_BYTES);
    const link = probe ? { ...probe, MB: PROBE_BYTES / 1024 / 1024 } : null;
    note(`horloge : ${clock ? `décalage ${clock.offsetMs} ms, aller-retour ${clock.rttMs} ms (${clock.samples} échanges)` : "sans"} · lien : ${link?.mbps ?? "?"} Mb/s (${link?.via ?? "—"})`);
    return { s, clock, link };
  };

  /**
   * Le lecteur actuel dans la vidéo, pour la lecture `run` (`currentPlayer.ts` : ses API publiques, comme
   * l'hôte). Rend un motif d'échec, ou null : ouvert — ou l'essai fermé entre-temps. Ses erreurs de moteur
   * (`onError`) vont dans celles de la lecture : l'hôte replierait vers le lecteur serveur, ici c'est un résultat.
   */
  const openCurrent = async (run: Run, startSeconds: number): Promise<string | null> => {
    const video = videoRef.current;
    if (!video) return "pas de vidéo";
    try {
      const opened = await openCurrentPlayer(video, {
        itemId: run.itemId,
        audioTrack: run.audio,
        startSeconds,
        onError: (line) => {
          if (runRef.current !== run) return;
          run.errors.push(line);
          if (run.pending) finishSeek(run, { ok: false, error: line });
          note(`ERREUR ${line}`);
        },
        onNote: (line) => runRef.current === run && note(line),
        cancelled: () => runRef.current !== run,
      });
      if (!opened) return "arrêté";
      engineRef.current = opened.playback;
      run.engine = opened.facts;
      run.openedAudio = opened.openedAudio;
      note(`lecteur actuel ouvert : ${opened.facts.video ?? "?"} · ${opened.facts.audio ?? "?"} · son ${opened.facts.sound ?? "?"} · piste ${opened.openedAudio ?? "—"}`);
      return null;
    } catch (error) {
      const line = `ouverture : ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
      if (runRef.current === run) run.errors.push(line);
      note(`ERREUR ${line}`);
      return line;
    }
  };

  const play = async () => {
    const video = videoRef.current;
    if (!video) return;
    let current = verdict;
    if (!current || !current.version || current.cutFacts?.cut !== cut || (current.cutFacts?.targetS ?? DEFAULT_TARGET_S) !== target || current.audioTrack !== audio || !!current.muxed !== !!modes.mux) current = await prepare();
    // Le lecteur actuel lit aussi un fichier que le serveur refuse (le son DTS de *Le Prestige*) : le verdict ne
    // sert alors qu'à connaître la piste.
    if (!current || (player === "serveur" && (!current.ok || !current.version))) {
      if (current && !current.ok) note(`non servi : ${current.reason}`);
      return;
    }
    // La chronologie (étape 3e) avant l'appui mesuré : horloges, débit. Les leviers ne s'appliquent qu'au serveur.
    const chrono = await chronoBefore(itemId, player);
    const runModes = player === "serveur" ? modes : undefined;
    if (runModes?.early) {
      await fetch(`/api/lumen/${itemId}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: current.audioTrack ?? undefined, position: Number(startAt) || 0, s: chrono.s, cut, ...(target !== DEFAULT_TARGET_S ? { target } : {}) }),
      }).catch(() => null);
      note(`préparation précoce : ${EARLY_DELAY_MS / 1000} s avant Lire`);
    }
    // `serveur` : le serveur prépare seul pendant le délai, la vidéo n'a pas encore de source.
    if (runModes?.early === "serveur") await new Promise((resolve) => setTimeout(resolve, EARLY_DELAY_MS));
    const preload = runModes?.early === "élément";
    const run = startRun({ itemId, title, player, cut, targetS: target, startAt: Number(startAt) || 0, verdict: current, clickAt: performance.now(), s: chrono.s, chrono, modes: runModes, preload });
    if (!run) return;
    // `élément` : la source est posée, Safari charge pendant le délai ; Lire vient ensuite.
    if (preload) {
      await new Promise((resolve) => setTimeout(resolve, EARLY_DELAY_MS));
      if (runRef.current !== run) return;
      armRun(run);
    }
    if (player === "actuel" && (await openCurrent(run, Number(startAt) || 0))) return;
    try {
      await video.play();
    } catch (error) {
      note(`play() refusé : ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
    refresh();
  };

  const stop = () => {
    tourRef.current += 1;
    closeRun("arrêt");
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    note("arrêt");
    refresh();
  };

  /** Un saut mesuré ; la promesse se résout quand il a repris, échoué ou dépassé 20 s. */
  const seek = (kind: SeekKind, position?: number): Promise<void> => {
    const video = videoRef.current;
    const run = runRef.current;
    if (!video || !run || !Number.isFinite(video.duration)) return Promise.resolve();
    if (run.pending) finishSeek(run, { ok: false, error: "remplacé par un autre saut" });
    const from = video.currentTime;
    const duration = video.duration;
    const to =
      position ??
      (kind === "-10" ? from - 10 : kind === "+10" ? from + 10 : kind === "+60" ? from + 60 : 30 + Math.random() * Math.max(1, duration - 90));
    const clamped = Math.max(0, Math.min(duration - 5, to));
    run.pending = { kind, from, to: clamped, startedAt: performance.now(), waits: 0 };
    const done = new Promise<void>((resolve) => {
      seekDone.current = resolve;
    });
    video.currentTime = clamped;
    if (video.paused) void video.play().catch(() => {});
    refresh();
    return done;
  };

  /**
   * N sauts, chacun suivi de 4 s de lecture : de quoi mesurer sans geste. Partagé avec la série, qui donne les
   * positions (`seekPositions` : les mêmes pour les deux lecteurs d'un titre) ; à la main, au hasard.
   */
  const runTour = async (n: number, positions?: number[], dwellMs = DWELL_AFTER_SEEK_MS) => {
    const token = ++tourRef.current;
    setTouring(true);
    note(`parcours de ${n} sauts${positions ? ` (positions de la graine : ${positions.join(", ")})` : ""}`);
    for (let i = 0; i < n && tourRef.current === token && runRef.current; i++) {
      await seek("parcours", positions?.[i]);
      await new Promise((resolve) => setTimeout(resolve, dwellMs));
    }
    if (tourRef.current === token) note("parcours terminé");
    setTouring(false);
  };

  const tour = () => runTour(Math.max(1, Math.min(60, Math.round(Number(tourCount) || 10))));

  /**
   * Passe à la piste audio suivante — ou à la piste `to` (la passe « son multiplexé » vise une autre langue) — par
   * `audioTracks[i].enabled` : sans recharger, si Safari sait faire.
   */
  const nextAudio = (to?: number): AudioSwitch | null => {
    const video = videoRef.current;
    const run = runRef.current;
    const tracks = tracksOf(video);
    if (!video || !run || tracks.length < 2) {
      note(`changement de piste impossible : ${tracks.length} piste(s) annoncée(s) par audioTracks`);
      return null;
    }
    const current = tracks.findIndex((t) => t.enabled);
    const next = to !== undefined && to >= 0 && to < tracks.length && to !== current ? to : (current + 1) % tracks.length;
    const sw: AudioSwitch = {
      from: describeTrack(tracks[current], current),
      to: describeTrack(tracks[next], next),
      startedAt: performance.now(),
      reloaded: false,
      changeEvent: false,
      waited: false,
      at: video.currentTime,
    };
    run.audioSwitches.push(sw);
    // L'ordre compte peu en HLS (un seul rendu actif par groupe), mais on allume d'abord : jamais sans son.
    tracks[next].enabled = true;
    if (current >= 0 && current !== next) tracks[current].enabled = false;
    note(`piste audio ${current} → ${next} (${tracks[next].language || "?"} ${tracks[next].label || ""})`);
    refresh();
    return sw;
  };

  const heard = (answer: "oui" | "non") => {
    const sw = runRef.current?.audioSwitches.at(-1);
    if (!sw) return;
    sw.heard = answer;
    note(`son de la nouvelle piste entendu : ${answer}`);
    refresh();
  };

  /**
   * Envoie les lignes en attente, dans l'ordre. Une ligne qui n'a pas reçu de réponse exploitable (réseau, 5xx,
   * 429) reste en tête pour le prochain envoi : une série de 30 minutes sur un réseau mobile ne perd pas un essai
   * pour une coupure. Un refus définitif (400, 403) la retire — la renvoyer n'y changerait rien.
   */
  const flush = async (): Promise<boolean> => {
    while (outboxRef.current.length) {
      const body = outboxRef.current[0];
      try {
        const res = await fetch("/api/viewport-diag", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok && (res.status >= 500 || res.status === 429 || res.status === 408)) return false;
        if (!res.ok) note(`ligne refusée par le serveur (HTTP ${res.status}) : abandonnée`);
      } catch {
        return false;
      }
      outboxRef.current = outboxRef.current.slice(1);
    }
    return true;
  };

  const send = async () => {
    const video = videoRef.current;
    // Les cascades des lectures fermées se dessinent en arrière-plan (`finalizeChrono`) : on les attend.
    await Promise.all(doneRef.current.map((r) => r.chronoDone?.catch(() => {})));
    const runs = [...doneRef.current];
    const live = runRef.current;
    if (live) {
      live.quality = qualityOf(video) ?? live.quality;
      runs.push({ ...live, end: live.end ?? "en cours" });
    }
    try {
      const res = await fetch("/api/viewport-diag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "lumen-test", build: APP_BUILD, env, runs: runs.map(reportOf), log: log.slice(-150) }),
      });
      setSent(res.ok ? `Envoyé (${runs.length} lecture${runs.length > 1 ? "s" : ""}).` : `Non envoyé (HTTP ${res.status}).`);
    } catch {
      setSent("Non envoyé (réseau).");
    }
  };

  const choosePreset = (preset: (typeof PRESETS)[number]) => {
    setItemId(preset.id);
    setTitle(preset.title);
    setVerdict(null);
    setAudio(null);
  };

  // --- « Tout enchaîner » -----------------------------------------------------------------------------------

  const setStep = (step: string) => {
    const state = autoRef.current;
    if (!state) return;
    state.step = step;
    refreshAuto();
  };

  /**
   * La préparation précoce d'un essai (levier b, étape 3e) : `POST …/prepare` (l'index, puis le segment de départ et
   * son pendant audio construits et gardés deux minutes), puis le délai d'une fiche ouverte avant Lire. `élément` :
   * la source est en plus posée sur la vidéo pendant ce délai (`preload="auto"`), et `start` n'aura qu'à lire.
   */
  const prepareEarly = async (t: Trial, v: Verdict, chrono: { s: string; clock: ClockSync | null; link: Run["link"] }) => {
    const early = t.modes?.early;
    if (!early) return;
    await fetch(`/api/lumen/${t.itemId}/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio: v.audioTrack ?? undefined, position: t.startAt, s: chrono.s, cut: t.cut, ...(t.targetS !== DEFAULT_TARGET_S ? { target: t.targetS } : {}) }),
    }).catch(() => null);
    const stop = () => autoRef.current?.stopped ?? true;
    if (early === "élément") {
      const run = startRun({ itemId: t.itemId, title: t.title, player: t.player, cut: t.cut, targetS: t.targetS, startAt: t.startAt, verdict: v, clickAt: performance.now(), s: chrono.s, chrono, modes: t.modes, preload: true });
      if (run) run.trial = t.id;
    }
    setStep(`Fiche ouverte (${EARLY_DELAY_MS / 1000} s avant Lire)`);
    await sleepUnless(EARLY_DELAY_MS, stop);
  };

  /**
   * Le pilote de la série (`SeriesDriver`) : chaque geste du protocole, sur la vraie vidéo, avec les fonctions du
   * mode manuel — le même verdict, la même lecture, le même parcours, le même changement de piste. Construit à
   * l'appui ; l'état qu'il partage avec l'écran vit dans les `ref`.
   */
  const makeDriver = (state: AutoState): SeriesDriver => {
    const stopped = () => state.stopped;
    let lastVerdict: Verdict | null = null;
    // La chronologie préparée pour l'essai qui va lire (identifiant, horloge, débit) : tirée dans `prepare`, hors
    // du temps de la première image, comme le verdict.
    let pending: { s: string; clock: ClockSync | null; link: Run["link"] } | null = null;
    // La passe « son multiplexé » (étape 3f) : la liste maître lue une fois par titre et par mode — la piste que Safari
    // doit allumer, les rendus dans l'ordre de `audioTracks`, le débit annoncé — et celle de l'essai qui va lire.
    const masters = new Map<string, ExpectedAudio | null>();
    let pendingExpected: ExpectedAudio | null | undefined;
    let logFrom = 0;
    const lineRuns = new Map<number, Record<string, unknown>[]>();
    const plan = state.plan;
    const verdictLine = (v: Verdict | null) =>
      v ? { ok: v.ok, reason: v.reason, detail: v.detail, segments: v.segments, longestS: v.cutFacts?.longestS, targetS: v.targetS, craRasl: v.cutFacts?.craRasl, verified: v.cutFacts?.verified, durationS: v.durationS } : undefined;

    /** Attend la première image : 20 s au plus une fois `play()` accepté ; un refus du geste attend l'appui. */
    const awaitFirstFrame = async (run: Run): Promise<{ image: true } | { image: false; reason: string }> => {
      let deadline = performance.now() + FIRST_FRAME_TIMEOUT_MS;
      for (;;) {
        if (stopped()) return { image: false, reason: "arrêté" };
        if (run.firstFrameMs !== undefined) return { image: true };
        if (run.errors.length) return { image: false, reason: `erreur ${run.errors[0]}`.slice(0, 120) };
        if (refusedRef.current) {
          refusedRef.current = false;
          note("play() refusé (NotAllowedError) : un appui est nécessaire");
          setStep("En attente d'un appui");
          setNeedTap(true);
          await new Promise<void>((resolve) => {
            tapRef.current = resolve;
          });
          deadline = performance.now() + FIRST_FRAME_TIMEOUT_MS;
          continue;
        }
        if (performance.now() > deadline) return { image: false, reason: "sans image après 20 s" };
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };

    /**
     * Le changement de piste de la passe « son multiplexé » (étape 3f) : un seul, vers une piste d'une autre langue
     * (`switchTarget` — un changement qui s'entend), observé `MUX_SWITCH_WATCH_MS`. En plus de ce que mesure le tour
     * des pistes (reprise, `waiting`, erreurs, gels), la piste allumée à la fin (appliqué ?) et les segments de la
     * nouvelle piste que la page a vus arriver (Resource Timing) : en multiplexé, Safari doit quitter le son des
     * segments vidéo pour un rendu séparé — c'est ce que la spécification d'Apple ne garantit pas.
     */
    const switchOnce = async (video: TestVideo | null, run: Run | null) => {
      const tracks = tracksOf(video);
      const target = switchTarget(tracks);
      if (!video || !run || target < 0) {
        note(`changement de piste : ${tracks.length} piste(s) annoncée(s) par audioTracks, rien à changer`);
        return;
      }
      setStep("Changement de piste");
      const errorsBefore = run.errors.length;
      const freezesBefore = run.watch.freezes.length;
      const sw = nextAudio(target);
      if (!sw) return;
      // Le numéro Matroska de la piste visée : le rendu de même rang dans le groupe de la liste maître, si Safari
      // annonce autant de pistes que la liste en déclare (sinon l'ordre ne se recoupe pas : rien de supposé).
      const renditions = run.expected?.renditions;
      const number = renditions && renditions.length === tracks.length ? trackOfUri(renditions[target].uri) : null;
      if (number !== null) sw.target = number;
      await sleepUnless(MUX_SWITCH_WATCH_MS, stopped);
      sw.errors = run.errors.length - errorsBefore;
      sw.freezes = run.watch.freezes.length - freezesBefore;
      sw.applied = !!tracksOf(video)[target]?.enabled;
      if (sw.target !== undefined) {
        const prefix = `a${sw.target}/`;
        sw.segs = resourcesNow().filter((r) => {
          const name = r.startTime >= sw.startedAt - 50 ? lumenResourceName(r.name, run.s) : null;
          return !!name && name.startsWith(prefix) && name.endsWith(".m4s");
        }).length;
      }
      note(
        `piste ${sw.to} : ${sw.ms !== undefined ? `reprise ${sw.ms} ms` : "LE TEMPS N'A PAS REPRIS"}${sw.waited ? " · blocage" : ""}${sw.errors ? ` · ${sw.errors} erreur(s)` : ""}${sw.freezes ? ` · ${sw.freezes} gel(s)` : ""} · ${sw.applied ? "appliquée" : "NON APPLIQUÉE"}${sw.segs !== undefined ? ` · ${sw.segs} segment(s) de la piste ${sw.target} reçus` : ""}`
      );
    };

    return {
      stopped,
      begin: (t, rank) => {
        state.index = rank - 1;
        state.trialStartedAt = performance.now();
        logFrom = logCountRef.current;
        note(`— essai ${rank}/${plan.length} : ${t.id}`);
        // Les choix du mode manuel suivent la série : un essai à refaire à la main part de là.
        setItemId(t.itemId);
        setTitle(t.title);
        setCut(t.cut);
        setPlayer(t.player);
        setTarget(t.targetS);
        setStartAt(String(t.startAt));
        setStep("Préparation");
      },
      prepare: async (t, chosenCut): Promise<PreparedVerdict | null> => {
        setStep(t.player === "serveur" ? `Préparation (${chosenCut}${t.targetS !== DEFAULT_TARGET_S ? `, ${t.targetS} s` : ""})` : "Préparation (lecteur actuel)");
        // Les deux lecteurs demandent le verdict du serveur : la piste audio (la même pour les deux) et la durée
        // d'où les positions des sauts sont tirées. Le lecteur actuel demande en plus la description du fichier
        // que son hôte lit avant d'ouvrir — hors du temps de la première image, comme le verdict du serveur.
        const v = await prepare(t.itemId, null, chosenCut, t.targetS, !!t.modes?.mux);
        lastVerdict = v;
        pending = null;
        pendingExpected = undefined;
        if (t.player === "serveur") {
          // La liste maître de la passe « son multiplexé », avant l'échantillon de débit (qui reste juste avant l'essai).
          if (t.rep && v?.ok && v.version && !stopped()) {
            const k = `${t.key}|${t.modes?.mux ? "mux" : "normal"}`;
            if (!masters.has(k)) {
              setStep("Liste maître");
              masters.set(k, await readMaster(t.itemId, v.version, v.audioTrack));
            }
            pendingExpected = masters.get(k) ?? null;
          }
          if (v?.ok && !t.prepareOnly && !stopped()) {
            setStep("Horloges et débit");
            pending = await chronoBefore(t.itemId, "serveur");
            await prepareEarly(t, v, pending);
          }
          return v ? { ok: v.ok, reason: v.reason, detail: v.detail, version: v.version, audioTrack: v.audioTrack, segments: v.segments, longestS: v.cutFacts?.longestS, durationS: v.durationS } : null;
        }
        if (!stopped()) {
          setStep("Débit");
          pending = await chronoBefore(t.itemId, "actuel");
        }
        try {
          const info = await currentPlayerInfo(t.itemId);
          return info.ok ? { ok: true, audioTrack: v?.audioTrack ?? null, durationS: v?.durationS } : { ok: false, reason: info.reason, audioTrack: v?.audioTrack ?? null };
        } catch (error) {
          note(`description du fichier : ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      },
      start: async (t, rank, prepared) => {
        const video = videoRef.current;
        if (!video || !lastVerdict) return { image: false, reason: "pas de vidéo" };
        setStep("Attente de la première image");
        const verdict: Verdict = { ...lastVerdict, audioTrack: prepared.audioTrack };
        const held = runRef.current;
        // La fiche ouverte d'avance (`early: "élément"`) : la source est déjà posée, Lire part d'ici.
        const preloaded = held?.preloaded && held.trial === t.id ? held : null;
        const chrono = pending ?? { s: newPlaybackId(), clock: null, link: null };
        const run =
          preloaded ??
          startRun({ itemId: t.itemId, title: t.title, player: t.player, cut: t.cut, targetS: t.targetS, startAt: t.startAt, verdict, clickAt: performance.now(), s: chrono.s, chrono, modes: t.modes });
        if (!run) return { image: false, reason: "lecture impossible" };
        if (preloaded) armRun(run);
        run.trial = t.id;
        run.rank = rank;
        if (pendingExpected !== undefined) {
          run.expected = pendingExpected;
          run.streamMbps = pendingExpected?.streamMbps;
        }
        refusedRef.current = false;
        if (t.player === "actuel") {
          const failed = await openCurrent(run, t.startAt);
          if (failed) return { image: false, reason: failed.slice(0, 120) };
        }
        playOf(video).catch((error: unknown) => {
          if (runRef.current !== run) return;
          if (isNotAllowed(error)) refusedRef.current = true;
          else note(`play() refusé : ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
        });
        return awaitFirstFrame(run);
      },
      play: async (duration) => {
        setStep(`Lecture ${Math.round(duration / 1000)} s`);
        await sleepUnless(duration, stopped);
        // La passe « son multiplexé » : la piste allumée au départ, contre celle que la liste maître désigne — avant
        // tout changement de piste de l'essai. En multiplexé, c'est la piste sans URI, dans les segments vidéo.
        const run = runRef.current;
        if (plan[state.index]?.rep && run && run.expected !== undefined) {
          run.audioCheck = checkAudio(run.expected, tracksOf(videoRef.current));
          const c = run.audioCheck;
          note(
            `piste au départ : ${c.got ?? "?"}${c.ok === undefined ? " (non jugée)" : c.ok ? " — la bonne" : ` — FAUSSE, attendue ${c.want ?? "?"}`}${run.expected?.muxed === false && run.modes?.mux ? " · liste maître NON multiplexée" : ""}`
          );
        }
      },
      tour: async (count, index) => {
        const t = plan[state.index];
        setStep(`Parcours ${index + 1}/${t.tours.length} (${count} sauts)`);
        // Les mêmes positions pour les deux lecteurs du titre : la graine de la série, le titre, le rang du parcours,
        // la durée du verdict serveur (celle de l'élément si le serveur n'en a pas donné).
        const duration = lastVerdict?.durationS ?? videoRef.current?.duration ?? 0;
        await runTour(count, Number.isFinite(duration) && duration > 0 ? seekPositions(state.seed, t.key, index, count, duration) : undefined, t.dwellMs);
      },
      audioTour: async () => {
        const video = videoRef.current;
        const run = runRef.current;
        const count = tracksOf(video).length;
        if (plan[state.index]?.audioSwitch) {
          await switchOnce(video, run);
          return;
        }
        if (!video || !run || count < 2) {
          note(`tour des pistes : ${count} piste(s) annoncée(s) par audioTracks, rien à changer`);
          return;
        }
        // Autant de changements que de pistes : on revient sur celle du départ, chacune entendue une fois.
        for (let i = 0; i < count && !stopped(); i++) {
          setStep(`Pistes audio ${i + 1}/${count}`);
          const errorsBefore = run.errors.length;
          const freezesBefore = run.watch.freezes.length;
          const sw = nextAudio();
          if (!sw) break;
          await sleepUnless(AUDIO_SWITCH_WATCH_MS, stopped);
          sw.errors = run.errors.length - errorsBefore;
          sw.freezes = run.watch.freezes.length - freezesBefore;
          note(
            `piste ${sw.to} : ${sw.ms !== undefined ? `reprise ${sw.ms} ms` : "LE TEMPS N'A PAS REPRIS"}${sw.waited ? " · blocage" : ""}${sw.errors ? ` · ${sw.errors} erreur(s)` : ""}${sw.freezes ? ` · ${sw.freezes} gel(s)` : ""}`
          );
        }
      },
      close: async (t, rank, outcome) => {
        const tag = { trial: t.id, rank };
        if (outcome.prepared) {
          lineRuns.set(
            rank,
            outcome.prepared.map((p) => ({
              ...tag,
              itemId: t.itemId,
              title: t.title,
              player: t.player,
              cut: p.cut,
              audio: p.verdict?.audioTrack ?? undefined,
              verdict: p.verdict ? { ok: p.verdict.ok, reason: p.verdict.reason, detail: p.verdict.detail, segments: p.verdict.segments, longestS: p.verdict.longestS } : undefined,
              end: "préparé seulement",
            }))
          );
          return resultOf(t, rank, outcome);
        }
        const run = runRef.current?.trial === t.id && runRef.current.rank === rank ? runRef.current : null;
        const end = `série : ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`.slice(0, 40);
        if (!run) {
          lineRuns.set(rank, [{ ...tag, itemId: t.itemId, title: t.title, player: t.player, ...(t.player === "serveur" ? { cut: t.cut, targetS: t.targetS } : {}), verdict: verdictLine(lastVerdict), end }]);
          return resultOf(t, rank, outcome);
        }
        tourRef.current += 1;
        closeRun(end);
        videoRef.current?.pause();
        // Les cascades : le relevé du serveur relu, puis dessinées (`finalizeChrono`) — avant la ligne et le résultat.
        setStep("Chronologie");
        await run.chronoDone?.catch(() => {});
        lineRuns.set(rank, [reportOf(run)]);
        refresh();
        return resultOf(t, rank, outcome, measuresOf(run));
      },
      reload: async (index) => {
        // L'ordre `actuel` : WebKit refuse un HLS natif dans une page qui a servi une MediaSource. On garde la série
        // (sessionStorage) et on recharge ; la reprise attend un appui (« Touchez pour continuer »), qui rend aussi à
        // l'élément le droit de jouer avec le son.
        setStep("Rechargement de la page");
        note(`série ${state.serie} : rechargement avant l'essai ${index + 1} (lecteur actuel fini, Lumen serveur ensuite)`);
        const saved: SavedSeries = {
          serie: state.serie,
          pass: state.pass,
          order: state.order,
          seed: state.seed,
          index,
          results: state.results,
          elapsedMs: performance.now() - state.startedAt,
          outbox: outboxRef.current,
          savedAt: Date.now(),
        };
        try {
          window.sessionStorage.setItem(SERIES_KEY, JSON.stringify(saved));
        } catch {
          note("sessionStorage refusé : la série ne peut pas reprendre après le rechargement");
          state.stopped = true;
          return;
        }
        window.location.reload();
        await new Promise<void>(() => {});
      },
      send: async (t, rank, result) => {
        const fresh = Math.min(150, logCountRef.current - logFrom);
        outboxRef.current = [
          ...outboxRef.current,
          {
            kind: "lumen-test",
            build: APP_BUILD,
            env: envRef.current,
            auto: { ...trialTag(state.serie, t, rank, plan.length, { pass: state.pass, seed: state.seed, order: state.order }), status: result.status },
            runs: lineRuns.get(rank) ?? [],
            log: fresh > 0 ? logRef.current.slice(-fresh) : [],
          },
        ].slice(-OUTBOX_MAX);
        lineRuns.delete(rank);
        const ok = await flush();
        note(ok ? `essai ${rank} envoyé` : `essai ${rank} gardé pour le prochain envoi (${outboxRef.current.length} en attente)`);
      },
    };
  };

  /**
   * L'appui sur « Tout enchaîner ». Tout ce qui précède le premier `await` se passe dans le geste : c'est là que
   * l'élément vidéo reçoit le droit de jouer avec le son (WebKit le lève sur `load()`/`play()` faits pendant un
   * geste, pour cet élément et ses sources suivantes). Le `play()` sans source est rejeté — sans importance.
   */
  const runAll = (pass: SeriesPass, saved?: SavedSeries) => {
    const video = videoRef.current;
    if (!video || autoRef.current?.phase === "en-cours") return;
    tourRef.current += 1;
    closeRun("série");
    video.muted = false;
    video.removeAttribute("src");
    video.load();
    playOf(video).catch(() => {});
    const seriesOrder = saved?.order ?? (pass === "leviers" || pass === "multiplexé" ? "serveur" : order);
    const plan = planOf(pass, seriesOrder);
    const state: AutoState = {
      serie: saved?.serie ?? newPlaybackId().slice(2, 14),
      pass,
      order: seriesOrder,
      plan,
      seed: saved?.seed ?? newSeed(),
      startedAt: performance.now() - (saved?.elapsedMs ?? 0),
      phase: "en-cours",
      stopped: false,
      index: saved?.index ?? 0,
      trialStartedAt: performance.now(),
      step: "Démarrage",
      results: saved?.results ?? [],
      sent: null,
    };
    autoRef.current = state;
    if (saved) {
      // Les lignes restées en attente avant le rechargement repartent avec la suite.
      outboxRef.current = [...saved.outbox, ...outboxRef.current].slice(-OUTBOX_MAX);
      note(`série ${state.serie} reprise après le rechargement, à l'essai ${state.index + 1} sur ${plan.length}`);
    } else {
      setAnswers({ damaged: null, damagedTitle: "", audioClean: null, audioChanged: null, lipSync: null });
      const passLabel = pass === "courte" ? "comparatif rapide" : pass === "leviers" ? "leviers de démarrage" : pass === "multiplexé" ? "son multiplexé" : "complète";
      note(`série ${state.serie} (${passLabel}, ${seriesOrder === "actuel" ? "lecteur actuel d'abord, rechargement" : "serveur d'abord"}, graine ${state.seed}) : ${plan.length} essais`);
    }
    video.scrollIntoView?.({ block: "start" });
    refreshAuto();
    void runSeries(
      plan,
      makeDriver(state),
      (result) => {
        state.results = [...state.results, result];
        refreshAuto();
      },
      { from: state.index }
    ).then(({ stopped }) => {
      videoRef.current?.pause();
      state.phase = "questions";
      state.step = stopped ? "Arrêtée" : "Terminée";
      note(`série ${state.serie} ${stopped ? "arrêtée" : "terminée"} : ${state.results.length} essai(s)`);
      refreshAuto();
    });
  };

  /**
   * La reprise d'une série après le rechargement de l'ordre `actuel` : l'appui sur « Touchez pour continuer » est le
   * geste qui rend à l'élément le droit de jouer avec le son (`runAll` fait `load()` et `play()` dans ce geste).
   */
  const resumeSeries = () => {
    const saved = resume;
    setResume(null);
    forgetSavedSeries();
    if (saved) runAll(saved.pass, saved);
  };

  /** « Arrêter » : l'essai en cours se ferme (sa ligne part quand même), rien après. */
  const stopAll = () => {
    const state = autoRef.current;
    if (!state || state.phase !== "en-cours") return;
    state.stopped = true;
    tourRef.current += 1;
    const run = runRef.current;
    if (run?.pending) finishSeek(run, { ok: false, error: "série arrêtée" });
    setNeedTap(false);
    tapRef.current?.();
    tapRef.current = null;
    videoRef.current?.pause();
    note("série : arrêt demandé");
    setStep("Arrêt…");
  };

  /** « Touchez pour continuer » : le `play()` refait dans ce geste-ci. */
  const tap = () => {
    const video = videoRef.current;
    setNeedTap(false);
    if (video) {
      playOf(video).catch((error: unknown) => {
        if (isNotAllowed(error)) refusedRef.current = true;
      });
    }
    const resume = tapRef.current;
    tapRef.current = null;
    resume?.();
  };

  const sendSummary = async () => {
    const state = autoRef.current;
    if (!state) return;
    // Un bilan renvoyé après un échec remplace le précédent encore en attente : une seule ligne récapitulative.
    const isSummary = (body: Record<string, unknown>) => (body.auto as { summary?: boolean } | undefined)?.summary === true;
    outboxRef.current = [
      ...outboxRef.current.filter((body) => !isSummary(body)),
      { kind: "lumen-test", build: APP_BUILD, env: envRef.current, ...summaryBody(state.serie, state.plan.length, state.results, answers, { elapsedS: (performance.now() - state.startedAt) / 1000, stopped: state.stopped, pass: state.pass, seed: state.seed, order: state.order }) },
    ].slice(-OUTBOX_MAX);
    const ok = await flush();
    state.sent = ok ? "Bilan envoyé. Merci." : `Bilan non envoyé (${outboxRef.current.length} ligne(s) en attente) : réessayer.`;
    if (ok) state.phase = "envoyé";
    refreshAuto();
  };

  const estimateMin = Math.round(seriesEstimateS(SERIES) / 60);
  const quickMin = Math.round(seriesEstimateS(QUICK_SERIES) / 60);
  const leverMin = Math.round(seriesEstimateS(LEVER_SERIES) / 60);
  const muxMin = Math.round(seriesEstimateS(MUX_SERIES) / 60);

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 text-sm text-white">
      <h1 className="text-xl font-semibold">Banc Lumen serveur</h1>
      <p className="mt-1 text-xs text-white/60">
        Deux lecteurs dans le même élément vidéo : <b>Lumen serveur</b> (la liste HLS lue nativement ; découpe <b>cra</b>, la règle, ou un essai) et le{" "}
        <b>lecteur actuel</b> (Lumen dans la page : remux et MediaSource), mesurés de la même façon — première image, sauts, attentes, gels, décodage.
      </p>

      <section className="mt-4 rounded-xl border border-white/15 p-3 font-mono text-[11px] leading-relaxed text-white/80">
        {env ? (
          <>
            <div>HLS natif (canPlayType) : {env.hlsNative} · application installée : {String(env.standalone)} · écran {env.screen}</div>
            <div className="break-all">{env.userAgent}</div>
          </>
        ) : (
          "…"
        )}
      </section>

      <section className="mt-4 rounded-xl border border-white/30 bg-white/5 p-3">
        <h2 className="font-semibold">Série automatique</h2>
        <p className="mt-1 text-xs text-white/60">
          Chaque titre joué par Lumen serveur et par le lecteur actuel, avec les mêmes sauts, dans l&apos;ordre choisi plus bas ; une chronologie de chaque démarrage et de chaque saut. Chaque essai part au
          journal dès qu&apos;il est fini, et un tableau côte à côte les compare à la fin. Gardez le son audible et regardez de temps en temps : deux
          questions à la fin.
        </p>
        <button type="button" className="btn btn-primary mt-3 w-full justify-center py-3 text-base" disabled={auto?.phase === "en-cours"} onClick={() => runAll("complète")}>
          {auto?.phase === "en-cours" ? "Série en cours…" : `Tout enchaîner (${SERIES.length} essais, ~${estimateMin} min)`}
        </button>
        <button type="button" className="btn btn-ghost mt-2 w-full justify-center py-2.5" disabled={auto?.phase === "en-cours"} onClick={() => runAll("courte")}>
          {`Comparatif rapide (${QUICK_SERIES.length} essais, ~${quickMin} min)`}
        </button>
        <button type="button" className="btn btn-ghost mt-2 w-full justify-center py-2.5" disabled={auto?.phase === "en-cours"} onClick={() => runAll("leviers")}>
          {`Leviers de démarrage (${LEVER_SERIES.length} essais, Lumen serveur seul, ~${leverMin} min)`}
        </button>
        <button type="button" className="btn btn-ghost mt-2 w-full justify-center py-2.5" disabled={auto?.phase === "en-cours"} onClick={() => runAll("multiplexé")}>
          {`Son multiplexé (${MUX_SERIES.length} essais, Lumen serveur seul, ~${muxMin} min)`}
        </button>
        <p className="mt-1 text-[11px] text-white/50">
          La passe du son multiplexé : quatre titres, chacun trois fois avec les groupes son séparés (la règle) et trois fois avec le son dans les segments vidéo, en
          alternance, mêmes sauts ; un changement de piste par essai multiplexé. Écoutez le changement de langue et regardez les lèvres : deux questions
          à la fin.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-white/60">
          Ordre des lecteurs :
          {(
            [
              ["serveur", "Lumen serveur d'abord"],
              ["actuel", "Lecteur actuel d'abord (rechargement)"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setOrder(id)}
              className={`rounded-lg border px-2 py-1 ${order === id ? "border-white/60 bg-white/10 text-white" : "border-white/15"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-white/50">
          Le lecteur joué en second lit des positions que le premier vient de lire, sur un cache disque plus chaud. Dans le second ordre, la page se recharge
          entre les deux (Safari refuse le HLS natif après une MediaSource) : touchez l&apos;écran pour reprendre, le son en dépend.
        </p>
      </section>

      <section className="mt-4 rounded-xl border border-white/15 p-3">
        <h2 className="font-semibold">1. Titre</h2>
        {PRESETS.length > 0 && (
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => choosePreset(p)}
                className={`rounded-lg border px-2 py-1.5 text-left text-xs ${itemId === p.id ? "border-white/60 bg-white/10" : "border-white/15"}`}
              >
                <div className="font-semibold">{p.title}</div>
                <div className="text-white/60">{p.note}</div>
              </button>
            ))}
          </div>
        )}
        <label className="mt-2 block text-xs text-white/60">
          Identifiant Jellyfin
          <input
            value={itemId}
            onChange={(e) => {
              setItemId(e.target.value.trim());
              setTitle("");
              setVerdict(null);
              setAudio(null);
            }}
            placeholder="32 caractères hexadécimaux"
            className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-2 py-1.5 font-mono text-xs text-white"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
      </section>

      <section className="mt-4 rounded-xl border border-white/15 p-3">
        <h2 className="font-semibold">2. Lecteur, découpe, piste, départ</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {(
            [
              ["serveur", "Lumen serveur", "la liste HLS, lue nativement"],
              ["actuel", "Lecteur actuel", "remux dans la page, MediaSource"],
            ] as const
          ).map(([id, label, detail]) => (
            <button
              key={id}
              type="button"
              onClick={() => setPlayer(id)}
              className={`rounded-lg border px-2 py-1.5 text-left text-xs ${player === id ? "border-white/60 bg-white/10" : "border-white/15"}`}
            >
              <div className="font-semibold">{label}</div>
              <div className="text-white/60">{detail}</div>
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-white/60">
          Cible de segment (serveur) :
          {TARGETS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setTarget(s);
                setVerdict(null);
              }}
              className={`rounded-lg border px-2 py-1 ${target === s ? "border-white/60 bg-white/10 text-white" : "border-white/15"}`}
            >
              {s} s{s === DEFAULT_TARGET_S ? " (la règle)" : " (essai)"}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-white/60">
          Leviers (serveur) :
          {(
            [
              ["mux", "son multiplexé", { mux: !modes.mux }],
              ["prep", "préparé 5 s avant", { early: modes.early === "serveur" ? undefined : "serveur" }],
              ["fiche", "fiche ouverte 5 s avant", { early: modes.early === "élément" ? undefined : "élément" }],
              ["xstart", "départ par EXT-X-START", { startMode: modes.startMode === "ext-x-start" ? undefined : "ext-x-start" }],
              ["frag", "départ par #t=", { startMode: modes.startMode === "fragment" ? undefined : "fragment" }],
              ["bw", "débit annoncé moyen", { bandwidth: modes.bandwidth ? undefined : "moyen" }],
            ] as const
          ).map(([id, label, change]) => {
            const on = id === "mux" ? !!modes.mux : id === "prep" ? modes.early === "serveur" : id === "fiche" ? modes.early === "élément" : id === "xstart" ? modes.startMode === "ext-x-start" : id === "frag" ? modes.startMode === "fragment" : !!modes.bandwidth;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setModes((m) => {
                    const next: TrialModes = { ...m, ...change };
                    for (const k of Object.keys(next) as (keyof TrialModes)[]) if (!next[k]) delete next[k];
                    return next;
                  });
                  if (id === "mux") setVerdict(null);
                }}
                className={`rounded-lg border px-2 py-1 ${on ? "border-white/60 bg-white/10 text-white" : "border-white/15"}`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {CUTS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setCut(c.id);
                setVerdict(null);
              }}
              className={`rounded-lg border px-2 py-1.5 text-left text-xs ${cut === c.id ? "border-white/60 bg-white/10" : "border-white/15"}`}
            >
              <div className="font-semibold">{c.label}</div>
              <div className="text-white/60">{c.detail}</div>
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void prepare()}>
            Préparer
          </button>
          <label className="text-xs text-white/60">
            Départ à (s)
            <input value={startAt} onChange={(e) => setStartAt(e.target.value)} inputMode="numeric" className="ml-2 w-20 rounded border border-white/20 bg-black/40 px-1.5 py-1 text-white" />
          </label>
        </div>
        {busy && <p className="mt-2 text-xs text-white/70">{busy}</p>}
        {verdict && (
          <div className="mt-3 font-mono text-[11px] leading-relaxed text-white/80">
            <div>
              {verdict.ok ? "servi" : `refusé : ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ""}`} · {verdict.segments ?? "?"} segments · cible {verdict.targetS ?? "?"} s · le plus long{" "}
              {verdict.cutFacts?.longestS ?? "?"} s · {keysLine(verdict.cutFacts)} · version {verdict.version ?? "—"}
            </div>
            <div className="mt-2 space-y-1">
              {verdict.audio.map((a) => (
                <label key={a.number} className={`flex items-center gap-2 ${a.servable ? "" : "text-white/40"}`}>
                  <input
                    type="radio"
                    name="piste"
                    disabled={!a.servable}
                    checked={audio === a.number}
                    onChange={() => {
                      setAudio(a.number);
                      setVerdict({ ...verdict, audioTrack: a.number });
                    }}
                  />
                  piste {a.number} · {a.language ?? "?"} · {a.codec} {a.hlsChannels ?? a.channels} · {a.name ?? ""}
                  {a.isDefault ? " · défaut" : ""}
                  {a.refusal ? ` · refus ${a.refusal}` : ""}
                  {a.repairs?.length ? ` · réparée : ${a.repairs.join(", ")}` : ""}
                </label>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-white/15 p-3">
        <h2 className="font-semibold">3. Lecture</h2>
        <video ref={videoRef} controls playsInline preload="none" className="mt-2 aspect-video w-full rounded-lg bg-black" />
        {auto && (
          <div className="mt-3 rounded-lg border border-white/30 bg-white/5 p-3">
            {auto.phase === "en-cours" ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold">
                    Essai {auto.k} sur {auto.n}
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={stopAll}>
                    Arrêter
                  </button>
                </div>
                <div className="mt-1 text-xs">
                  {auto.title} · {auto.player} — {auto.step}
                </div>
                <div className="mt-1 text-xs text-white/60">Écoulé : {clock(auto.elapsedS)}</div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/15" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(auto.progress * 100)}>
                  <div className="h-full rounded-full bg-white/80" style={{ width: `${Math.round(auto.progress * 100)}%` }} />
                </div>
              </>
            ) : (
              <div className="font-semibold">
                Série {auto.stopped ? "arrêtée" : "terminée"} : {auto.results.length} essai{auto.results.length > 1 ? "s" : ""} en {clock(auto.elapsedS)}
              </div>
            )}
            {auto.comparison.length > 0 && <ComparisonTable rows={auto.comparison} />}
            {auto.mux && <MuxTable analysis={auto.mux} />}
            {auto.trials.length > 0 && <ChronoTable trials={auto.trials} />}
            {auto.results.length > 0 && (
              <ol className="mt-2 space-y-0.5 font-mono text-[11px] leading-relaxed text-white/80">
                {auto.results.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ol>
            )}
            {auto.phase === "questions" && (
              <div className="mt-3 space-y-3 text-xs">
                <fieldset>
                  <legend className="font-semibold">Avez-vous vu une image abîmée (verte, en blocs) ou figée pendant que le son continuait ?</legend>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {(["non", "oui"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`btn btn-sm ${answers.damaged === value ? "btn-primary" : "btn-ghost"}`}
                        onClick={() => setAnswers((a) => ({ ...a, damaged: value }))}
                      >
                        {value === "oui" ? "Oui" : "Non"}
                      </button>
                    ))}
                  </div>
                  {answers.damaged === "oui" && (
                    <label className="mt-2 block text-white/60">
                      Sur quel titre (facultatif)
                      <input
                        value={answers.damagedTitle}
                        onChange={(e) => setAnswers((a) => ({ ...a, damagedTitle: e.target.value }))}
                        className="mt-1 w-full rounded-lg border border-white/20 bg-black/40 px-2 py-1.5 text-xs text-white"
                      />
                    </label>
                  )}
                </fieldset>
                {auto.pass === "multiplexé" && (
                  <>
                    <fieldset>
                      <legend className="font-semibold">
                        Quand la piste a changé pendant un essai « son multiplexé » (du français à l&apos;anglais), avez-vous entendu l&apos;autre langue ?
                      </legend>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {(
                          [
                            ["oui", "Oui, à chaque fois"],
                            ["parfois", "Parfois"],
                            ["non", "Non"],
                            ["pas-entendu", "Je n'ai pas écouté"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            className={`btn btn-sm ${answers.audioChanged === value ? "btn-primary" : "btn-ghost"}`}
                            onClick={() => setAnswers((a) => ({ ...a, audioChanged: value }))}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset>
                      <legend className="font-semibold">La voix était-elle en phase avec les lèvres ?</legend>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {(
                          [
                            ["oui", "Oui, partout"],
                            ["non-mux", "Décalée en multiplexé seulement"],
                            ["non-partout", "Décalée partout"],
                            ["pas-regardé", "Je n'ai pas regardé"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            className={`btn btn-sm ${answers.lipSync === value ? "btn-primary" : "btn-ghost"}`}
                            onClick={() => setAnswers((a) => ({ ...a, lipSync: value }))}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  </>
                )}
                {auto.pass !== "multiplexé" && (
                <fieldset>
                  <legend className="font-semibold">Quand les pistes audio ont changé (Ted Lasso), le son a-t-il changé sans coupure de l&apos;image ?</legend>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {(
                      [
                        ["oui", "Oui"],
                        ["non", "Non"],
                        ["pas-entendu", "Je n'ai pas entendu"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`btn btn-sm ${answers.audioClean === value ? "btn-primary" : "btn-ghost"}`}
                        onClick={() => setAnswers((a) => ({ ...a, audioClean: value }))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                )}
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void sendSummary()}>
                  Envoyer le bilan
                </button>
              </div>
            )}
            {auto.sent && <p className="mt-2 text-xs text-white/70">{auto.sent}</p>}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void play()}>
            Lire
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={stop}>
            Arrêter
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void seek("-10")}>
            −10 s
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void seek("+10")}>
            +10 s
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void seek("+60")}>
            +60 s
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void seek("hasard")}>
            Au hasard
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-xs text-white/60">
            Parcours de
            <input value={tourCount} onChange={(e) => setTourCount(e.target.value)} inputMode="numeric" className="mx-1.5 w-12 rounded border border-white/20 bg-black/40 px-1.5 py-1 text-white" />
            sauts
          </label>
          <button type="button" className="btn btn-ghost btn-sm" disabled={touring} onClick={() => void tour()}>
            {touring ? "Parcours en cours…" : "Lancer le parcours"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void nextAudio()}>
            Piste audio suivante
          </button>
          {view?.switched && (
            <>
              <span className="text-xs text-white/60">Entendez-vous la nouvelle piste ?</span>
              <button type="button" className={`btn btn-sm ${view.heard === "oui" ? "btn-primary" : "btn-ghost"}`} onClick={() => heard("oui")}>
                Oui
              </button>
              <button type="button" className={`btn btn-sm ${view.heard === "non" ? "btn-primary" : "btn-ghost"}`} onClick={() => heard("non")}>
                Non
              </button>
            </>
          )}
        </div>
        <div className="mt-3 font-mono text-[11px] leading-relaxed text-white/80">
          {view ? (
            <>
              <div>
                {view.title} · {view.player} · {view.cut} · {view.s}
              </div>
              <div>
                métadonnées {view.loadedMetadataMs ?? "—"} ms · première image {view.firstFrameMs ?? "—"} ms{view.firstFrameVia ? ` (${view.firstFrameVia})` : ""} · t ={" "}
                {view.t.toFixed(1)} s · {view.paused ? "en pause" : "lecture"} · readyState {view.readyState}
              </div>
              <div>
                sauts {view.seeks} (manqués {view.missed}) · blocages {view.waits.count} ({view.waits.totalMs} ms, pire {view.waits.maxMs} ms) · erreurs {view.errors} · gels{" "}
                {view.freezes}
              </div>
              <div>
                images {view.frames ?? "—"} · perdues {view.dropped ?? "—"} · corrompues {view.corrupted ?? "—"}
              </div>
              <div>audioTracks : {view.tracks.length ? view.tracks.join(" · ") : "aucune (ou non exposé)"}</div>
            </>
          ) : (
            "Aucune lecture."
          )}
        </div>
        {cascadeView && (
          <details className="mt-3 rounded-lg border border-white/15 p-2">
            <summary className="cursor-pointer text-xs font-semibold">Chronologie de la dernière lecture — {cascadeView.title}</summary>
            <p className="mt-1 text-[10px] text-white/50">
              En ms depuis le geste. req : arrivée au serveur, prête (r), premier et dernier morceau remis (f, l) — remis n&apos;est pas reçu, des tampons
              de plusieurs Mo séparent le serveur de l&apos;appareil —, poids (k, Ko). ev : évènement, readyState, avance de buffered devant la position (s).
            </p>
            <pre className="mt-1 max-h-96 overflow-auto whitespace-pre font-mono text-[10px] leading-snug text-white/80">{cascadeView.lines.join("\n")}</pre>
          </details>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-white/15 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Journal</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void send()}>
            Envoyer les résultats
          </button>
        </div>
        {sent && <p className="mt-1 text-xs text-white/60">{sent}</p>}
        <ol className="mt-2 space-y-0.5 font-mono text-[11px] text-white/80">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      </section>

      {resume && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/90 px-6 text-center text-white">
          <button type="button" onClick={resumeSeries} className="w-full max-w-md rounded-2xl border border-white/40 bg-white/10 px-6 py-10 text-2xl font-semibold">
            Touchez pour continuer
          </button>
          <p className="max-w-md text-sm text-white/70">
            La page s&apos;est rechargée entre le lecteur actuel et Lumen serveur. La série reprend à l&apos;essai {resume.index + 1} ; l&apos;appui rend le son à
            la vidéo.
          </p>
          <button
            type="button"
            className="text-xs text-white/50 underline"
            onClick={() => {
              forgetSavedSeries();
              setResume(null);
            }}
          >
            Abandonner la série
          </button>
        </div>
      )}
      {needTap && (
        <button type="button" onClick={tap} className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-6 text-center text-2xl font-semibold text-white">
          Touchez pour continuer
        </button>
      )}
    </main>
  );
}

/**
 * La chronologie de chaque essai, à la fin d'une série (étape 3e) : le débit mesuré avant la lecture, puis les
 * médianes des sauts — première requête au serveur, premier segment vidéo prêt, `seeked` → reprise, avance de
 * `buffered` à `seeked` et à la reprise, segments vidéo demandés avant la reprise —, et la plus longue préparation
 * d'une réponse sur le serveur. De quoi lire où passe le temps sans ouvrir le journal.
 */
function ChronoTable({ trials }: { trials: TrialResult[] }) {
  const rows = trials.filter((t) => !t.verdicts && (t.chrono || t.linkMbps !== undefined));
  if (!rows.length) return null;
  const cell = (v: number | undefined, unit = "") => (v === undefined ? "—" : `${v}${unit}`);
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse font-mono text-[11px] text-white/85">
        <thead>
          <tr className="text-white/60">
            {["Essai", "lien Mb/s", "1re req.", "seg. prêt", "seg. reçu", "seeked→reprise", "avance seeked", "avance reprise", "seg. v", "serveur max"].map((h) => (
              <th key={h} className="px-1.5 py-1 text-right font-normal first:text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rank} className="border-t border-white/10">
              <td className="px-1.5 py-1">
                {r.title} · {playerLabel(r)}
                {r.mode ? ` (${r.mode})` : ""}
                {r.rep ? ` #${r.rep}` : ""}
              </td>
              <td className="px-1.5 py-1 text-right">{cell(r.linkMbps)}</td>
              <td className="px-1.5 py-1 text-right">{cell(r.chrono?.firstReqMs)}</td>
              <td className="px-1.5 py-1 text-right">{cell(r.chrono?.firstVideoReadyMs)}</td>
              <td className="px-1.5 py-1 text-right">{cell(r.chrono?.firstVideoRecvMs)}</td>
              <td className="px-1.5 py-1 text-right">{cell(r.chrono?.seekedToAdvanceMs)}</td>
              <td className="px-1.5 py-1 text-right">{cell(r.chrono?.aheadSeekedS, " s")}</td>
              <td className="px-1.5 py-1 text-right">{cell(r.chrono?.aheadAdvanceS, " s")}</td>
              <td className="px-1.5 py-1 text-right">{cell(r.chrono?.videoAdvance)}</td>
              <td className="px-1.5 py-1 text-right">{cell(r.chrono?.readyMaxMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-white/50">
        Médianes des sauts, en ms depuis le geste ; avances en secondes de film déjà dans `buffered`. « seg. prêt » : le premier segment vidéo construit
        sur le serveur ; « seg. reçu » : le même, reçu en entier par l&apos;appareil (Resource Timing) ; « serveur max » : la plus longue préparation
        d&apos;une réponse de l&apos;essai.
      </p>
    </div>
  );
}

/** « 612/1050 » : médiane et 90e centile, en ms ; un tiret pour ce qui n'a pas été mesuré. */
function pair(median: number | undefined, p90: number | undefined): string {
  return median === undefined ? "—" : `${median}/${p90 ?? "—"}`;
}

/** Une colonne d'un lecteur : ses trois mesures, ou ce qui l'a empêchée. */
function Cells({ cell }: { cell: ComparisonCell | undefined }) {
  if (!cell) return <td colSpan={3} className="px-1.5 py-1 text-white/40">—</td>;
  if (cell.status !== "ok" && cell.firstFrameMs === undefined) return <td colSpan={3} className="px-1.5 py-1 text-white/60">{cell.status}</td>;
  const flags = [cell.missed ? `${cell.missed} manqué${cell.missed > 1 ? "s" : ""}` : null, cell.errors ? `${cell.errors} err.` : null, cell.freezes ? `${cell.freezes} gel${cell.freezes > 1 ? "s" : ""}` : null].filter(Boolean);
  return (
    <>
      <td className="px-1.5 py-1 text-right">
        {cell.firstFrameMs ?? "—"}
        {cell.targetFrameMs !== undefined && cell.targetFrameMs !== cell.firstFrameMs && <div className="text-[10px] text-white/60">au départ {cell.targetFrameMs}</div>}
      </td>
      <td className="px-1.5 py-1 text-right">{pair(cell.seekedMedianMs, cell.seekedP90Ms)}</td>
      <td className="px-1.5 py-1 text-right">
        {pair(cell.advanceMedianMs, cell.advanceP90Ms)}
        {flags.length > 0 && <div className="text-[10px] text-white/60">{flags.join(" · ")}</div>}
      </td>
    </>
  );
}

/**
 * L'écran de fin du comparatif : par titre, la première image, puis `seekedMs` (l'image à la bonne position) et
 * `advanceMs` (la lecture repartie), médiane et p90 en ms, pour Lumen serveur et pour le lecteur actuel. Les
 * essais de cible 2 s ont leur ligne (serveur seul). Défile de côté dans son cadre sur un téléphone.
 */
function ComparisonTable({ rows }: { rows: ComparisonRow[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse font-mono text-[11px] text-white/85">
        <thead>
          <tr className="text-white/60">
            <th className="px-1.5 py-1 text-left font-normal" rowSpan={2}>
              Titre
            </th>
            <th className="px-1.5 py-1 font-normal" colSpan={3}>
              Lumen serveur
            </th>
            <th className="px-1.5 py-1 font-normal" colSpan={3}>
              Lecteur actuel
            </th>
          </tr>
          <tr className="text-white/60">
            {["image", "seeked", "reprise", "image", "seeked", "reprise"].map((h, i) => (
              <th key={i} className="px-1.5 py-1 text-right font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.key}-${row.targetS}-${row.mode ?? ""}`} className="border-t border-white/10 align-top">
              <td className="px-1.5 py-1">
                {row.title}
                {row.targetS !== DEFAULT_TARGET_S ? ` · cible ${row.targetS} s` : ""}
                {row.mode ? ` · ${row.mode}` : ""}
              </td>
              <Cells cell={row.serveur} />
              <Cells cell={row.actuel} />
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-white/50">En ms : première image ; puis, par saut, médiane/p90 jusqu&apos;à l&apos;image (seeked) et jusqu&apos;à la reprise de la lecture.</p>
    </div>
  );
}

/** Une valeur en secondes à deux décimales (« 0,48 s ») ; un tiret pour ce qui manque. */
const asSeconds = (v: number | undefined) => (v === undefined ? "—" : `${(v / 1000).toFixed(2).replace(".", ",")} s`);

/** Une mesure comparée : les médianes des deux modes, l'écart, et le verdict. */
function MetricRow({ label, m }: { label: string; m: MuxMetric }) {
  return (
    <tr className="border-t border-white/10 align-top">
      <td className="px-1.5 py-1">{label}</td>
      <td className="px-1.5 py-1 text-right">
        {asSeconds(m.medNormal)}
        <div className="text-[10px] text-white/50">{m.normal.join(" · ") || "—"}</div>
      </td>
      <td className="px-1.5 py-1 text-right">
        {asSeconds(m.medMux)}
        <div className="text-[10px] text-white/50">{m.mux.join(" · ") || "—"}</div>
      </td>
      <td className="px-1.5 py-1 text-right">{m.diffMs === undefined ? "—" : `${m.diffMs > 0 ? "+" : ""}${m.diffMs} ms`}</td>
      <td className={`px-1.5 py-1 ${m.kind === "plus-rapide" ? "text-emerald-300" : m.kind === "plus-lent" ? "text-amber-300" : "text-white/70"}`}>{m.verdict}</td>
    </tr>
  );
}

/** Les contrôles d'un mode, en une ligne. */
function checksLine(c: MuxChecks): string {
  return [
    `${c.ok}/${c.trials} essais`,
    `erreurs ${c.errors}`,
    `gels ${c.freezes}`,
    `manqués ${c.missed}`,
    `blocages ${c.waits}`,
    `perdues ${c.dropped}`,
    `corrompues ${c.corrupted}`,
    c.audioChecked ? `piste au départ ${c.audioOk}/${c.audioChecked}` : "piste au départ non jugée",
    c.switches
      ? `changement ${c.switches - c.switchTrouble}/${c.switches} net${c.switchNotApplied ? `, ${c.switchNotApplied} non appliqué` : ""}${c.switchMs !== undefined ? `, reprise ${c.switchMs} ms` : ""}${c.switchSegs !== undefined ? `, ${c.switchSegs} seg. reçus` : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * L'écran de fin de la passe « son multiplexé » (étape 3f) : par titre, la première image, l'image au saut et la
 * reprise — médianes de la règle et du multiplexé, les trois valeurs de chacun dessous, l'écart, le verdict contre la
 * dispersion des répétitions —, puis chaque essai avec le débit mesuré juste avant (⚠ sous le seuil du titre), et les
 * contrôles de non-régression. En tête, la synthèse sur les quatre titres.
 */
function MuxTable({ analysis }: { analysis: MuxAnalysis }) {
  return (
    <div className="mt-3 space-y-4">
      <div className="rounded-lg border border-white/20 p-2 text-xs">
        <div>Première image : {analysis.overall.firstFrame}</div>
        <div>Reprise après un saut : {analysis.overall.resume}</div>
        <div>Non-régression : {analysis.overall.regressions}</div>
      </div>
      {analysis.titles.map((t) => (
        <div key={t.key} className="overflow-x-auto">
          <div className="text-xs font-semibold">
            {t.title}
            <span className="font-normal text-white/60">
              {" "}
              · débit annoncé {t.streamMbps ?? "?"} Mb/s · seuil {t.floorMbps} Mb/s{t.lowLink ? ` · ${t.lowLink} essai${t.lowLink > 1 ? "s" : ""} sous le seuil` : ""}
            </span>
          </div>
          <table className="mt-1 w-full min-w-[40rem] border-collapse font-mono text-[11px] text-white/85">
            <thead>
              <tr className="text-white/60">
                {["Mesure", "normal (méd.)", "multiplexé (méd.)", "écart", "verdict"].map((h, i) => (
                  <th key={h} className={`px-1.5 py-1 font-normal ${i === 0 || i === 4 ? "text-left" : "text-right"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <MetricRow label="première image" m={t.firstFrame} />
              <MetricRow label="image au saut" m={t.seeked} />
              <MetricRow label="reprise" m={t.resume} />
            </tbody>
          </table>
          <ol className="mt-1 space-y-0.5 font-mono text-[10px] text-white/70">
            {t.trials.map((r) => (
              <li key={r.rank}>
                {r.rank}. {r.mode} #{r.rep ?? "?"} · lien {r.linkMbps ?? "?"} Mb/s{r.low ? " ⚠" : ""} · image {r.firstFrameMs ?? "—"} · saut {r.seekedMs ?? "—"} · reprise {r.resumeMs ?? "—"}
                {r.startRecvMs !== undefined ? ` · 1er seg. reçu +${r.startRecvMs}` : ""}
                {r.audioOk === false ? " · PISTE FAUSSE" : ""}
                {r.status !== "ok" ? ` · ${r.status}` : ""}
              </li>
            ))}
          </ol>
          <div className="mt-1 text-[10px] text-white/70">normal : {checksLine(t.checks.normal)}</div>
          <div className="text-[10px] text-white/70">multiplexé : {checksLine(t.checks.multiplexé)}</div>
          <div className={`text-[10px] ${t.regressions.length ? "text-amber-300" : "text-white/60"}`}>
            {t.regressions.length ? `À regarder : ${t.regressions.join(" ; ")}` : "Rien de dégradé en multiplexé."}
            {t.tracksSame === true ? " Pistes annoncées identiques dans tous les essais." : ""}
          </div>
        </div>
      ))}
      <p className="text-[10px] text-white/50">
        En ms. Un écart n&apos;est déclaré que si les trois répétitions d&apos;un mode sont toutes plus rapides que les trois de l&apos;autre, et de 50 ms au
        moins ; sinon il est dans le bruit. « positions » : les six sauts, les mêmes dans chaque essai, comparés un à un.
      </p>
    </div>
  );
}
