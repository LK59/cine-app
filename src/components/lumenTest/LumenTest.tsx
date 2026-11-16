"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { APP_BUILD } from "@/lib/appBuild";

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
 * Textes en français : la page est pour l'administrateur de la maison, pas pour un rapport.
 */

type Cut = "idr" | "cra" | "cra-leading";

/**
 * Les titres d'essai, tirés du recensement du 16/11/2026 (docs/remux-serveur/README.md, « Étape 3b ») :
 * un par cas à éprouver. Des identifiants de cette bibliothèque — ailleurs, le champ libre sert.
 */
const PRESETS: { id: string; title: string; note: string }[] = [
  { id: "d4513bcf59bba90a23656f40ed816c3d", title: "À la Maison Blanche S03E01", note: "H.264 1080p, AC-3 2.0 — le témoin : même découpe sous les trois modes" },
  { id: "3f79d20c0c10289f3c6df5f72f62b84b", title: "Black Monday S02E10", note: "HEVC 4K à IDR seules, segments de 4 s — cra ne change que la balise des listes" },
  { id: "7f17493b25683f0db7125defa08b70a0", title: "American Housewife — Attaque de poux", note: "HEVC 1080p à GOP ouvert court : idr 15,4 s, cra 12,4 s — les deux modes sur le même fichier" },
  { id: "1694ff6c78fd793f321d348511771a47", title: "Ghosted", note: "HEVC 4K DV 8.1, E-AC-3 Atmos, GOP ouvert : idr refusé (177 s), cra 13,9 s" },
  { id: "a1e058d682294a1de3cf5bb47d904e0e", title: "Pearl Harbor", note: "HEVC 1080p à GOP ouvert (132 CRA à RASL vues) : idr refusé (136 s), cra 14,4 s" },
  { id: "edaa7d0071b034dc32fabf1834484278", title: "Ted Lasso S02E01", note: "HEVC 4K DV 8.1, trois Atmos, CRA à RASL : idr refusé (51,9 s), cra 14 s" },
  { id: "23505fbd074bc303c0a41dbc8a8d207f", title: "Le Prestige", note: "GOP ouvert : idr 208 s, cra 14,4 s — mais son DTS seul, refusé tant que la conversion n'existe pas" },
  { id: "697cf1d483e4e736edf416d8b510f19f", title: "Alien : Romulus", note: "HEVC 1080p, E-AC-3 7.1 par défaut, IDR seules : le son 7.1 en HLS" },
];

const CUTS: { id: Cut; label: string; detail: string }[] = [
  { id: "idr", label: "idr (la règle)", detail: "coupe seulement là où un décodeur repart seul" },
  { id: "cra", label: "cra (essai)", detail: "coupe aussi sur les CRA, RASL gardées" },
  { id: "cra-leading", label: "cra-leading (essai)", detail: "cra, et chaque image nommée : is_leading RASL 1, RADL 3, autre 2" },
];

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
  cutFacts?: { cut: Cut; longestS: number; verified: number; craRasl: number; cuts: number };
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
  quality?: { total: number; dropped: number; corrupted: number };
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
    loadedMetadataMs: run.loadedMetadataMs,
    firstFrameMs: run.firstFrameMs,
    firstFrameVia: run.firstFrameVia,
    seeks: run.seeks.map(seek),
    waits: run.waits,
    errors: run.errors,
    audioTracks: run.audioTracks,
    audioSwitches: run.audioSwitches.map(({ from, to, ms: took, reloaded, changeEvent, waited, heard }) => ({ from, to, ms: took, reloaded, changeEvent, waited, heard })),
    quality: run.quality,
    end: run.end,
  };
}

export function LumenTest() {
  const videoRef = useRef<TestVideo | null>(null);
  const runRef = useRef<Run | null>(null);
  const doneRef = useRef<Run[]>([]);
  const startAtRef = useRef(0);
  const tourRef = useRef(0);
  const seekDone = useRef<(() => void) | null>(null);

  const [itemId, setItemId] = useState("");
  const [title, setTitle] = useState("");
  const [cut, setCut] = useState<Cut>("idr");
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

  const note = useCallback((line: string) => {
    const at = (performance.now() / 1000).toFixed(1);
    setLog((lines) => [...lines.slice(-299), `${at}s ${line}`]);
  }, []);
  const refresh = useCallback(() => setView(viewOf(runRef.current, videoRef.current)), []);

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

  // L'environnement, une fois monté ; puis l'état de la vidéo et le délai des sauts, chaque seconde.
  useEffect(() => {
    const first = setTimeout(() => {
      const video = document.createElement("video");
      const nav = navigator as Navigator & { standalone?: boolean };
      setEnv({
        userAgent: navigator.userAgent,
        standalone: window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true,
        hlsNative: video.canPlayType("application/vnd.apple.mpegurl") || "non",
        managedMediaSource: "ManagedMediaSource" in window,
        screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
      });
    }, 0);
    const timer = setInterval(() => {
      const run = runRef.current;
      if (run?.pending && performance.now() - run.pending.startedAt > SEEK_TIMEOUT_MS) finishSeek(run, { ok: false, timedOut: true });
      refresh();
    }, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [finishSeek, refresh]);

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
        if (!run || run.pending) return;
        // Un saut que la page n'a pas demandé : la barre native, ou le départ à une position.
        run.pending = { kind: "barre", from: video.currentTime, to: video.currentTime, startedAt: now(), waits: 0 };
      },
      seeked: () => {
        const m = runRef.current?.pending;
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
          `éligibilité ${chosenCut} en ${ms(performance.now() - began)} ms : ${body.ok ? "ok" : `refus ${body.reason}${body.detail ? ` (${body.detail})` : ""}`} · ${body.segments ?? "?"} segments · le plus long ${body.cutFacts?.longestS ?? "?"} s · CRA à RASL ${body.cutFacts?.craRasl ?? "?"}`
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
    run.quality = qualityOf(video ?? null) ?? run.quality;
    run.end = end;
    doneRef.current = [...doneRef.current, run].slice(-12);
    runRef.current = null;
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
    tourRef.current += 1; // un parcours en cours s'arrête
    closeRun("nouvelle lecture");
    const s = newPlaybackId();
    const master = `/api/lumen/${itemId}/${current.version}/${s}/master.m3u8${current.audioTrack !== null ? `?audio=${current.audioTrack}` : ""}`;
    startAtRef.current = Math.max(0, Number(startAt) || 0);
    const run: Run = {
      itemId,
      title: title || itemId,
      cut,
      audio: current.audioTrack,
      s,
      version: current.version,
      verdict: { ok: current.ok, segments: current.segments, longestS: current.cutFacts?.longestS, targetS: current.targetS, craRasl: current.cutFacts?.craRasl, verified: current.cutFacts?.verified, durationS: current.durationS },
      clickAt,
      seeks: [],
      pending: null,
      waits: { count: 0, totalMs: 0, maxMs: 0 },
      waitingSince: null,
      errors: [],
      audioTracks: [],
      audioSwitches: [],
    };
    runRef.current = run;
    note(`lecture ${run.title} · ${cut} · piste ${current.audioTrack ?? "—"} · ${s}`);
    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback(() => {
        if (runRef.current !== run || run.firstFrameMs !== undefined) return;
        run.firstFrameMs = ms(performance.now() - run.clickAt);
        run.firstFrameVia = "rvfc";
        note(`première image (requestVideoFrameCallback) : ${run.firstFrameMs} ms`);
        refresh();
      });
    }
    video.src = master;
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

  /** N sauts au hasard, chacun suivi de 4 s de lecture : de quoi mesurer sans geste. */
  const tour = async () => {
    const n = Math.max(1, Math.min(60, Math.round(Number(tourCount) || 10)));
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

  /** Passe à la piste audio suivante par `audioTracks[i].enabled` : sans recharger, si Safari sait faire. */
  const nextAudio = () => {
    const video = videoRef.current;
    const run = runRef.current;
    const tracks = tracksOf(video);
    if (!video || !run || tracks.length < 2) {
      note(`changement de piste impossible : ${tracks.length} piste(s) annoncée(s) par audioTracks`);
      return;
    }
    const current = tracks.findIndex((t) => t.enabled);
    const next = (current + 1) % tracks.length;
    run.audioSwitches.push({
      from: describeTrack(tracks[current], current),
      to: describeTrack(tracks[next], next),
      startedAt: performance.now(),
      reloaded: false,
      changeEvent: false,
      waited: false,
      at: video.currentTime,
    });
    // L'ordre compte peu en HLS (un seul rendu actif par groupe), mais on allume d'abord : jamais sans son.
    tracks[next].enabled = true;
    if (current >= 0 && current !== next) tracks[current].enabled = false;
    note(`piste audio ${current} → ${next} (${tracks[next].language || "?"} ${tracks[next].label || ""})`);
    refresh();
  };

  const heard = (answer: "oui" | "non") => {
    const sw = runRef.current?.audioSwitches.at(-1);
    if (!sw) return;
    sw.heard = answer;
    note(`son de la nouvelle piste entendu : ${answer}`);
    refresh();
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
              {verdict.cutFacts?.longestS ?? "?"} s · CRA à RASL vérifiées {verdict.cutFacts?.craRasl ?? "?"}/{verdict.cutFacts?.verified ?? "?"} · version {verdict.version ?? "—"}
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
          <button type="button" className="btn btn-ghost btn-sm" onClick={nextAudio}>
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
                sauts {view.seeks} (manqués {view.missed}) · blocages {view.waits.count} ({view.waits.totalMs} ms, pire {view.waits.maxMs} ms) · erreurs {view.errors}
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
    </main>
  );
}
