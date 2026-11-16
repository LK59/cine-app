"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { APP_BUILD } from "@/lib/appBuild";
import { useWakeLock } from "@/lib/useWakeLock";
import {
  AUDIO_SWITCH_WATCH_MS,
  FIRST_FRAME_TIMEOUT_MS,
  FREEZE_CHECK_MS,
  FreezeWatch,
  PRESETS,
  SERIES,
  formatResult,
  qualityDelta,
  resultOf,
  runSeries,
  seriesEstimateS,
  seriesProgress,
  summaryBody,
  trialTag,
  type Cut,
  type PreparedVerdict,
  type Quality,
  type SeriesAnswers,
  type SeriesDriver,
  type TrialMeasures,
  type TrialResult,
} from "./autoSeries";

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
}

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
}

/** Une lecture : tout ce que la page en mesure, mutable pendant qu'elle dure (dans un `ref`). */
interface Run {
  itemId: string;
  title: string;
  cut: Cut;
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
}

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
  title: string;
  cut: Cut;
  step: string;
  elapsedS: number;
  progress: number;
  results: string[];
  stopped: boolean;
  sent: string | null;
}

/** L'état de la série, mutable pendant qu'elle dure. */
interface AutoState {
  serie: string;
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
  const trial = SERIES[Math.min(state.index, SERIES.length - 1)];
  return {
    phase: state.phase,
    k: Math.min(state.index + 1, SERIES.length),
    n: SERIES.length,
    title: trial.title,
    cut: trial.cut,
    step: state.step,
    elapsedS: (now - state.startedAt) / 1000,
    progress: state.phase === "en-cours" ? seriesProgress(SERIES, state.index, (now - state.trialStartedAt) / 1000) : 1,
    results: state.results.map(formatResult),
    stopped: state.stopped,
    sent: state.sent,
  };
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
    seeks: run.seeks,
    freezes: run.watch.freezes,
    errors: run.errors,
    waits: run.waits.count,
    quality: qualityDelta(run.qualityStart, run.quality),
    audioSwitches: run.audioSwitches,
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
    cut: run.cut,
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
    audioSwitches: run.audioSwitches.map(({ from, to, ms: took, reloaded, changeEvent, waited, heard, errors, freezes }) => ({ from, to, ms: took, reloaded, changeEvent, waited, heard, errors, freezes })),
    quality: run.quality,
    qualityStart: run.qualityStart,
    qualityDelta: qualityDelta(run.qualityStart, run.quality),
    end: run.end,
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

  const [itemId, setItemId] = useState("");
  const [title, setTitle] = useState("");
  const [cut, setCut] = useState<Cut>("cra");
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
  const [answers, setAnswers] = useState<SeriesAnswers>({ damaged: null, damagedTitle: "", audioClean: null });

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
        if (run.firstFrameMs === undefined && !video.requestVideoFrameCallback) {
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
      for (const [type, handler] of Object.entries(handlers)) video.removeEventListener(type, handler);
      tracks?.removeEventListener("change", onTracks);
      tracks?.removeEventListener("addtrack", onTracks);
    };
  }, [finishSeek, note, refresh]);

  /** Le verdict du serveur pour ce titre, cette piste et cette découpe ; l'index se construit au besoin. */
  const prepare = async (id = itemId, audioTrack = audio, chosenCut = cut) => {
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      setBusy("Identifiant Jellyfin attendu (32 caractères hexadécimaux).");
      return null;
    }
    setBusy("Préparation (l'index d'un fichier jamais lu prend 2 à 30 s)…");
    const began = performance.now();
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const query = new URLSearchParams({ wait: "25000", cut: chosenCut });
        if (audioTrack !== null) query.set("audio", String(audioTrack));
        const res = await fetch(`/api/lumen/${id}/eligibility?${query}`);
        const body = (await res.json().catch(() => null)) as Verdict | null;
        if (res.status === 202 || body?.pending) continue;
        if (!res.ok || !body) {
          setBusy(`Refusé par le serveur (HTTP ${res.status}).`);
          note(`éligibilité : HTTP ${res.status}`);
          return null;
        }
        setVerdict(body);
        setAudio(body.audioTrack);
        setBusy(null);
        note(
          `éligibilité ${chosenCut} en ${ms(performance.now() - began)} ms : ${body.ok ? "ok" : `refus ${body.reason}${body.detail ? ` (${body.detail})` : ""}`} · ${body.segments ?? "?"} segments · le plus long ${body.cutFacts?.longestS ?? "?"} s · ${keysLine(body.cutFacts)}`
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
      if (run.firstFrameMs === undefined) {
        run.firstFrameMs = ms(now - run.clickAt);
        run.firstFrameVia = "rvfc";
        run.qualityStart = qualityOf(video);
        note(`première image (requestVideoFrameCallback) : ${run.firstFrameMs} ms`);
        refresh();
      }
      run.watch.frame(now, video.currentTime);
      video.requestVideoFrameCallback(onFrame);
    }
    video.requestVideoFrameCallback(onFrame);
  };

  /**
   * Ouvre une lecture de la liste maître dans la vidéo : la lecture précédente fermée, la nouvelle mesurée.
   * Partagé par « Lire » et la série ; ne lance pas `play()` (chacun le fait à sa façon).
   */
  const startRun = (params: { itemId: string; title: string; cut: Cut; startAt: number; verdict: Verdict; clickAt: number }): Run | null => {
    const video = videoRef.current;
    const current = params.verdict;
    if (!video || !current.version) return null;
    tourRef.current += 1; // un parcours en cours s'arrête
    closeRun("nouvelle lecture");
    const s = newPlaybackId();
    const master = `/api/lumen/${params.itemId}/${current.version}/${s}/master.m3u8${current.audioTrack !== null ? `?audio=${current.audioTrack}` : ""}`;
    startAtRef.current = Math.max(0, params.startAt);
    const run: Run = {
      itemId: params.itemId,
      title: params.title || params.itemId,
      cut: params.cut,
      audio: current.audioTrack,
      s,
      version: current.version,
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
    };
    runRef.current = run;
    note(`lecture ${run.title} · ${params.cut} · piste ${current.audioTrack ?? "—"} · ${s}`);
    watchFrames(video, run);
    video.src = master;
    refresh();
    return run;
  };

  const play = async () => {
    const video = videoRef.current;
    if (!video) return;
    const clickAt = performance.now();
    let current = verdict;
    if (!current || !current.version || current.cutFacts?.cut !== cut || current.audioTrack !== audio) current = await prepare();
    if (!current?.ok || !current.version) {
      if (current && !current.ok) note(`non servi : ${current.reason}`);
      return;
    }
    if (!startRun({ itemId, title, cut, startAt: Number(startAt) || 0, verdict: current, clickAt })) return;
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
  const seek = (kind: SeekKind, target?: number): Promise<void> => {
    const video = videoRef.current;
    const run = runRef.current;
    if (!video || !run || !Number.isFinite(video.duration)) return Promise.resolve();
    if (run.pending) finishSeek(run, { ok: false, error: "remplacé par un autre saut" });
    const from = video.currentTime;
    const duration = video.duration;
    const to =
      target ??
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

  /** N sauts au hasard, chacun suivi de 4 s de lecture : de quoi mesurer sans geste. Partagé avec la série. */
  const runTour = async (n: number) => {
    const token = ++tourRef.current;
    setTouring(true);
    note(`parcours de ${n} sauts`);
    for (let i = 0; i < n && tourRef.current === token && runRef.current; i++) {
      await seek("parcours");
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    if (tourRef.current === token) note("parcours terminé");
    setTouring(false);
  };

  const tour = () => runTour(Math.max(1, Math.min(60, Math.round(Number(tourCount) || 10))));

  /** Passe à la piste audio suivante par `audioTracks[i].enabled` : sans recharger, si Safari sait faire. */
  const nextAudio = (): AudioSwitch | null => {
    const video = videoRef.current;
    const run = runRef.current;
    const tracks = tracksOf(video);
    if (!video || !run || tracks.length < 2) {
      note(`changement de piste impossible : ${tracks.length} piste(s) annoncée(s) par audioTracks`);
      return null;
    }
    const current = tracks.findIndex((t) => t.enabled);
    const next = (current + 1) % tracks.length;
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
   * Le pilote de la série (`SeriesDriver`) : chaque geste du protocole, sur la vraie vidéo, avec les fonctions du
   * mode manuel — le même verdict, la même lecture, le même parcours, le même changement de piste. Construit à
   * l'appui ; l'état qu'il partage avec l'écran vit dans les `ref`.
   */
  const makeDriver = (state: AutoState): SeriesDriver => {
    const stopped = () => state.stopped;
    let lastVerdict: Verdict | null = null;
    let logFrom = 0;
    const lineRuns = new Map<number, Record<string, unknown>[]>();
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

    return {
      stopped,
      begin: (t, rank) => {
        state.index = rank - 1;
        state.trialStartedAt = performance.now();
        logFrom = logCountRef.current;
        note(`— essai ${rank}/${SERIES.length} : ${t.id}`);
        // Les choix du mode manuel suivent la série : un essai à refaire à la main part de là.
        setItemId(t.itemId);
        setTitle(t.title);
        setCut(t.cut);
        setStartAt(String(t.startAt));
        setStep("Préparation");
      },
      prepare: async (t, chosenCut): Promise<PreparedVerdict | null> => {
        setStep(`Préparation (${chosenCut})`);
        const v = await prepare(t.itemId, null, chosenCut);
        lastVerdict = v;
        return v ? { ok: v.ok, reason: v.reason, detail: v.detail, version: v.version, audioTrack: v.audioTrack, segments: v.segments, longestS: v.cutFacts?.longestS } : null;
      },
      start: async (t, rank) => {
        const video = videoRef.current;
        if (!video || !lastVerdict) return { image: false, reason: "pas de vidéo" };
        setStep("Attente de la première image");
        const run = startRun({ itemId: t.itemId, title: t.title, cut: t.cut, startAt: t.startAt, verdict: lastVerdict, clickAt: performance.now() });
        if (!run) return { image: false, reason: "lecture impossible" };
        run.trial = t.id;
        run.rank = rank;
        refusedRef.current = false;
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
      },
      tour: async (count, index) => {
        const t = SERIES[state.index];
        setStep(`Parcours ${index + 1}/${t.tours.length} (${count} sauts)`);
        await runTour(count);
      },
      audioTour: async () => {
        const video = videoRef.current;
        const run = runRef.current;
        const count = tracksOf(video).length;
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
      close: (t, rank, outcome) => {
        const tag = { trial: t.id, rank };
        if (outcome.prepared) {
          lineRuns.set(
            rank,
            outcome.prepared.map((p) => ({
              ...tag,
              itemId: t.itemId,
              title: t.title,
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
          lineRuns.set(rank, [{ ...tag, itemId: t.itemId, title: t.title, cut: t.cut, verdict: verdictLine(lastVerdict), end }]);
          return resultOf(t, rank, outcome);
        }
        tourRef.current += 1;
        closeRun(end);
        videoRef.current?.pause();
        lineRuns.set(rank, [reportOf(run)]);
        refresh();
        return resultOf(t, rank, outcome, measuresOf(run));
      },
      send: async (t, rank, result) => {
        const fresh = Math.min(150, logCountRef.current - logFrom);
        outboxRef.current = [
          ...outboxRef.current,
          {
            kind: "lumen-test",
            build: APP_BUILD,
            env: envRef.current,
            auto: { ...trialTag(state.serie, t, rank, SERIES.length), status: result.status },
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
  const runAll = () => {
    const video = videoRef.current;
    if (!video || autoRef.current?.phase === "en-cours") return;
    tourRef.current += 1;
    closeRun("série");
    video.muted = false;
    video.removeAttribute("src");
    video.load();
    playOf(video).catch(() => {});
    const state: AutoState = {
      serie: newPlaybackId().slice(2, 14),
      startedAt: performance.now(),
      phase: "en-cours",
      stopped: false,
      index: 0,
      trialStartedAt: performance.now(),
      step: "Démarrage",
      results: [],
      sent: null,
    };
    autoRef.current = state;
    setAnswers({ damaged: null, damagedTitle: "", audioClean: null });
    note(`série ${state.serie} : ${SERIES.length} essais`);
    video.scrollIntoView?.({ block: "start" });
    refreshAuto();
    void runSeries(SERIES, makeDriver(state), (result) => {
      state.results = [...state.results, result];
      refreshAuto();
    }).then(({ stopped }) => {
      videoRef.current?.pause();
      state.phase = "questions";
      state.step = stopped ? "Arrêtée" : "Terminée";
      note(`série ${state.serie} ${stopped ? "arrêtée" : "terminée"} : ${state.results.length} essai(s)`);
      refreshAuto();
    });
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
      { kind: "lumen-test", build: APP_BUILD, env: envRef.current, ...summaryBody(state.serie, SERIES.length, state.results, answers, { elapsedS: (performance.now() - state.startedAt) / 1000, stopped: state.stopped }) },
    ].slice(-OUTBOX_MAX);
    const ok = await flush();
    state.sent = ok ? "Bilan envoyé. Merci." : `Bilan non envoyé (${outboxRef.current.length} ligne(s) en attente) : réessayer.`;
    if (ok) state.phase = "envoyé";
    refreshAuto();
  };

  const estimateMin = Math.round(seriesEstimateS(SERIES) / 60);

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 text-sm text-white">
      <h1 className="text-xl font-semibold">Banc Lumen serveur</h1>
      <p className="mt-1 text-xs text-white/60">
        Lecture en HLS natif de la liste de Lumen serveur. Une découpe à la fois : <b>idr</b> est la règle ; <b>cra</b> et <b>cra-leading</b> coupent aussi
        sur les images CRA suivies de RASL — la question est de savoir si Safari démarre dessus après un saut.
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
          Le protocole entier de l&apos;étape 3b, d&apos;un seul appui : {SERIES.length} essais, environ {estimateMin} minutes. Chaque essai part au journal dès
          qu&apos;il est fini. Gardez le son audible et regardez de temps en temps : deux questions à la fin.
        </p>
        <button type="button" className="btn btn-primary mt-3 w-full justify-center py-3 text-base" disabled={auto?.phase === "en-cours"} onClick={runAll}>
          {auto?.phase === "en-cours" ? "Série en cours…" : "Tout enchaîner"}
        </button>
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
        <h2 className="font-semibold">2. Découpe, piste, départ</h2>
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
                  {auto.title} · {auto.cut} — {auto.step}
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
                {view.title} · {view.cut} · {view.s}
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

      {needTap && (
        <button type="button" onClick={tap} className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-6 text-center text-2xl font-semibold text-white">
          Touchez pour continuer
        </button>
      )}
    </main>
  );
}
