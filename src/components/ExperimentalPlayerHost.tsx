"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { AlertTriangle, RotateCw, WifiOff, X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { usePlayback } from "@/components/PlaybackProvider";
import { PlayerControls } from "@/components/PlayerControls";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { PLAYBACK_CLIENTS } from "@/lib/playbackClients";
import { useViewportResizing } from "@/lib/useViewportResizing";
import { useT } from "@/components/TranslationProvider";
import { PlaybackEngine } from "@/lib/webcodecs/engine";
import { MediaElementFacade, asVideoElement } from "@/lib/webcodecs/mediaFacade";
import { probePlaybackPath, type RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";
import { describePath } from "@/lib/webcodecs/pathSelector";
import { trace, traceKeepAcrossReset } from "@/lib/webcodecs/trace";
import { isNetworkFailure } from "@/lib/webcodecs/byteSource";
import { reportPlayback } from "@/lib/reportPlayback";
import { describeCapabilities, probeCapabilities } from "@/lib/webcodecs/capabilities";
import { ExperimentalPlayerReport, type ReportInput } from "@/components/ExperimentalPlayerReport";
import type { EngineTrack } from "@/lib/webcodecs/engine";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import {
  ExternalSubtitleTrack,
  isExternalTrack,
  toEngineTrack as externalToEngineTrack,
  type ExternalSubtitleSource,
} from "@/lib/webcodecs/externalSubtitles";
import { chooseAudioTrack, chooseSubtitleTrack, trackLanguage } from "@/lib/trackPreferences";

/** Which of the pipeline's own readings belong under the sound rather than under the stream. */
const AUDIO_ROWS = ["Traitement audio", "Décalage de présentation"];

/** How long a threshold has to be crossed before anything is shown at all. */
const SPINNER_AFTER_MS = 120;

/** And before the wait is worth a sentence, then before it is worth admitting it is long. */
const WORD_AFTER_MS = 1000;
const STILL_WORKING_AFTER_MS = 3000;

/** And before a wait stops being slow and starts being a fault worth reporting. */
const STUCK_AFTER_MS = 20000;

/**
 * And before waiting stops being worth it at all.
 *
 * A first picture arrives in four seconds on an ordinary file over an ordinary link. Half a
 * minute is not a slow start, it is something that is not going to finish — and it is the one
 * failure a viewer cannot wait out, because nothing on screen ever changes.
 */
const GIVE_UP_AFTER_MS = 35000;

/**
 * How long a passing notice stays on screen.
 *
 * Long enough to read a sentence, short enough that it cannot be mistaken for a lasting state.
 */
const WARNING_MS = 6000;

/** How many times a lost source is rebuilt before the loss is reported as a fault. */
const MAX_REBUILDS = 3;

/**
 * How far past a position that has already killed the source a rebuild resumes.
 *
 * Reading the identical bytes again is a guaranteed way to die again, and the record proves it:
 * three rebuilds each re-read the same 5.5 MB segment and each lost the source ten milliseconds
 * after appending it. More than the longest gap between keyframes in this library, so the
 * resumed read starts on a different segment rather than the same one.
 */
const REBUILD_STEP_SECONDS = 12;

/** Two rebuild positions this close together are the same place. */
const SAME_PLACE_SECONDS = 3;

/**
 * Milliseconds since a moment, or null when there is no moment.
 *
 * Ticks only while something is actually pending: an idle player runs no timer at all, which is
 * the point of taking a start time rather than a boolean.
 */
function useElapsedSince(startedAt: number | null): number | null {
  // The clock is sampled by the timer and kept in state, never read while rendering: a render
  // that reads the time is not a pure function of its inputs, and writing the state from inside
  // the effect instead is the other way to get this wrong. Between the start and the first tick
  // the answer is simply zero, which is well inside the threshold below which nothing is shown.
  const [sampledAt, setSampledAt] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setSampledAt(Date.now()), 100);
    return () => clearInterval(id);
  }, [startedAt]);

  return startedAt === null ? null : Math.max(0, sampledAt - startedAt);
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      {/* Leaders, so an eye can travel from a label to a value twenty rows down without losing
          the line — the same reason a table of contents has them. */}
      <span aria-hidden className="mx-1 min-w-3 flex-1 translate-y-[-3px] border-b border-dotted border-white/10" />
      <dd className="text-right font-mono text-[11px] leading-4 text-slate-200">{value}</dd>
    </div>
  );
}

/** A titled group of rows. Twenty of them in one list is a list; in five groups it is an answer. */
function InfoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-white/5 pt-2.5 first:border-0 first:pt-0">
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

/**
 * The one line worth seeing before any other: which of the four paths is running.
 *
 * Coloured by how much of the work the device is doing rather than by whether anything failed —
 * the two are not the same, and the panel exists to tell them apart.
 */
function PathBadge({ path }: { path: "remux" | "webcodecs" | "direct" | null }) {
  const known = {
    direct: ["Lecture directe", "aucun remultiplexage", "emerald"],
    remux: ["Remultiplexage", "décodage matériel, HDR natif", "emerald"],
    webcodecs: ["WebCodecs → canvas", "décodage logiciel", "amber"],
  }[path ?? "webcodecs"];
  const [name, detail, tone] = path === null ? ["En cours d'examen", "le fichier n'a pas encore parlé", "slate"] : known;
  const colours =
    tone === "emerald"
      ? "bg-emerald-500/10 text-emerald-300 ring-emerald-400/20"
      : tone === "amber"
        ? "bg-amber-500/10 text-amber-200 ring-amber-400/20"
        : "bg-slate-500/10 text-slate-300 ring-slate-400/20";
  return (
    <div className={`rounded-lg px-3 py-2 ring-1 ring-inset ${colours}`}>
      <p className="text-[13px] font-medium leading-tight">{name}</p>
      <p className="mt-0.5 text-[11px] opacity-70">{detail}</p>
    </div>
  );
}

/** "1 h 12" — where the film will pick up, said the way a viewer thinks of it. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min ${String(sec).padStart(2, "0")}`;
}

/** "Français — VFF", falling back to whatever the file actually gives us. */
function trackLabel(track: EngineTrack): string {
  const parts = [track.language ?? undefined, track.name ?? undefined].filter(Boolean);
  const label = parts.join(" — ");
  return label || `Piste ${track.number}`;
}

const TRANSITION =
  "top 300ms cubic-bezier(0.4,0,0.2,1), left 300ms cubic-bezier(0.4,0,0.2,1), width 300ms cubic-bezier(0.4,0,0.2,1), height 300ms cubic-bezier(0.4,0,0.2,1), border-radius 300ms cubic-bezier(0.4,0,0.2,1)";

/**
 * The experimental player: the same chrome as the stable one, over a canvas fed by the WebCodecs
 * engine instead of a <video> element playing an HLS stream.
 *
 * Two rules it follows deliberately, both asked for:
 *
 *  * No silent fallback. If anything in the direct-decode path fails, it says what failed and
 *    offers a manual switch. A player that quietly repaired itself would never tell us which
 *    files this pipeline actually cannot handle, which is the whole reason it exists.
 *  * The controls are the stable player's, unmodified — see mediaFacade.ts.
 */
export function ExperimentalPlayerHost({
  session,
  mode,
  onFallback,
}: {
  session: NonNullable<ReturnType<typeof usePlayback>["session"]>;
  mode: "full" | "mini";
  onFallback: (reason: string) => void;
}) {
  const t = useT();
  const playback = usePlayback();
  const { itemId, title: openedAs } = session;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoElRef = useRef<HTMLVideoElement>(null);
  const remuxRef = useRef<RemuxPlayback | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const facadeRef = useRef<MediaElementFacade | null>(null);
  const positionRef = useRef(0);

  const [ready, setReady] = useState(false);
  // Only failures that happen *during* playback are state. The two that are already known from
  // the fetch — the server refusing the file, and the fetch itself failing — are derived below,
  // because pushing them into state from an effect is both a cascading render and a second
  // source of truth for the same fact.
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  /**
   * Steps aside for the stable player, once, without asking.
   *
   * A viewer cannot act on "the browser refused an operation on the buffer", and a button that
   * says so is a dead end wearing the costume of a choice. The stable player negotiates with the
   * server and will play this file; that is what a viewer wants and it is not a decision.
   *
   * The record is not softened with it. The reason travels to the player that takes over and is
   * written into the trace, so a step down still leaves an account of itself — which was always
   * the point of refusing silent fallbacks, rather than making anybody click.
   */
  /**
   * The network is gone, and the film is waiting for it rather than for anything else.
   *
   * Kept apart from every other failure because the answer is the opposite one: nothing about
   * this file or this browser is wrong, so stepping aside would abandon hardware decoding for a
   * reason that has nothing to do with it — and hand the file to a player needing the very same
   * network. There is nothing to do but wait, and say so.
   */
  const [networkLost, setNetworkLost] = useState<{
    message: string;
    /** Where the film stopped, and what the viewer was listening to — captured at the cut. */
    at: number;
    audio: number | null;
  } | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);

  const steppedAside = useRef(false);
  /**
   * The record's view of what is playing, read through refs.
   *
   * `fallToStable` must stay stable for the life of the player — a caller passing an inline arrow
   * once turned every render into a rebuilt pipeline — so it cannot close over any of this
   * directly. These are filled in by effects below, once there is something to describe.
   */
  const describeFileRef = useRef<() => Record<string, unknown>>(() => ({}));
  const pathRef = useRef<"remux" | "webcodecs" | "direct" | null>(null);
  // Read through a ref so this function is stable for the life of the player. The pipeline is
  // built by an effect that depends on it, and a caller passing an inline arrow — which the one
  // above did — turned every one of its own renders into a teardown and a rebuild.
  const onFallbackRef = useRef(onFallback);
  useEffect(() => {
    onFallbackRef.current = onFallback;
  }, [onFallback]);
  const fallToStable = useCallback((reason: string) => {
    if (steppedAside.current) return;
    steppedAside.current = true;
    trace(`repli : passage au lecteur stable — ${reason}`);
    // Written down before anything else. A step down nobody is told about is a step down nobody
    // can fix, and on a server with eighteen accounts this is the only place it will be noticed.
    reportPlayback("fallback", { ...describeFileRef.current(), reason, path: pathRef.current ?? "non décidé" });
    onFallbackRef.current(reason);
  }, []);
  /**
   * A passing notice, with the moment it was raised.
   *
   * The moment matters twice. It is what withdraws the notice on its own, and it is what makes a
   * repeat of the same sentence a new notice rather than an unchanged value that re-arms nothing.
   */
  const [warning, setWarning] = useState<{ text: string; at: number } | null>(null);
  const showWarning = useCallback((text: string | null) => {
    setWarning(text ? { text, at: Date.now() } : null);
  }, []);
  const [closing, setClosing] = useState(false);
  const [facade, setFacade] = useState<MediaElementFacade | null>(null);
  const [playing, setPlaying] = useState(false);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  // Mirrored into state from the engine so the controls' menus can be driven by props, the way
  // they already are for the stable player.
  const [tracks, setTracks] = useState<{ audio: EngineTrack[]; subtitles: EngineTrack[] }>({ audio: [], subtitles: [] });
  const [currentAudio, setCurrentAudio] = useState<number | null>(null);
  const [currentSubtitle, setCurrentSubtitle] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Record<string, string>>({});
  // Answered once and kept: none of it changes while the page is open.
  const [capabilities, setCapabilities] = useState<Record<string, string> | null>(null);
  // Which of the two pipelines is running. Null until the file has been examined — the element
  // that shows the picture differs between them, so both are mounted and one is hidden.
  const [path, setPath] = useState<"remux" | "webcodecs" | "direct" | null>(null);
  // When playback was asked to start, and has not yet. Reported by the pipeline as a measured
  // fact rather than guessed from the platform: on a desktop it clears within a frame, so none
  // of what follows ever appears there.
  const [startingAt, setStartingAt] = useState<number | null>(null);
  // Why this file is being played the way it is. Kept for the panel on *both* paths: a fallback
  // whose reason is only visible on the path that was not taken explains nothing at all.
  const [pathReason, setPathReason] = useState<string | null>(null);
  // A change of audio track holds the picture still until there is sound to go with it. Without
  // this the controls read the held element as simply paused and offer the play button, which is
  // both wrong and an invitation to make it worse.
  const [switchingAudio, setSwitchingAudio] = useState(false);
  // Two of the three paths put a real <video> on screen and are driven through it; only the
  // WebCodecs one paints a canvas and needs the façade in front of it.
  const onElement = path === "remux" || path === "direct";
  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  // Bumped to build the pipeline again from scratch. iOS takes the media resources back when the
  // page goes to the background, and a MediaSource it has closed cannot be reopened — so coming
  // back from a locked screen means starting over, at the position the viewer left.
  const [rebuildCount, setRebuildCount] = useState(0);
  const rebuildAtRef = useRef<number | null>(null);
  // Bounded, so a source that closes the instant it opens cannot become a rebuild loop.
  const rebuildsRef = useRef(0);
  const lastRebuildAtRef = useRef<number | null>(null);
  /**
   * What the viewer chose, so a restart gives it back to them.
   *
   * A pipeline built again is a pipeline that knows nothing: it opens on the file's own default
   * track with no subtitles, which after a network cut means coming back to a film in the wrong
   * language. These outlive the pipeline because they belong to the viewer, not to it.
   */
  const wantedAudioRef = useRef<number | null>(null);
  const wantedSubtitleRef = useRef<number | null>(null);
  /**
   * The subtitle file being shown, when it is one that came from beside the film rather than
   * from inside it.
   *
   * Held here rather than in a pipeline because it belongs to neither: it is fetched from the
   * media server, it is the same file whichever way the picture is being decoded, and it must
   * survive a rebuild after a network cut exactly as the chosen language does.
   */
  const externalSubtitleRef = useRef<ExternalSubtitleTrack | null>(null);
  /** Abandons a subtitle file still in flight when the player closes, or another is chosen. */
  const subtitleFetchRef = useRef<AbortController | null>(null);

  /**
   * Chooses a subtitle, from the menu or from the viewer's account.
   *
   * Both pipelines are told, and neither branches on which one is running: only one of the two
   * refs is ever set, and on the direct path neither is — where the only subtitles there can be
   * are the ones beside the film anyway.
   */
  const chooseSubtitle = useCallback(
    (id: number | null, sources: ExternalSubtitleSource[]) => {
      wantedSubtitleRef.current = id;
      setCurrentSubtitle(id);
      setSubtitle(null);

      // Whichever is chosen, the other is turned off first: the pipeline showing a track from
      // the container and a file showing its own would both write the same line.
      const external = id !== null && isExternalTrack(id);
      remuxRef.current?.selectSubtitleTrack(external ? null : id);
      engineRef.current?.setSubtitleTrack(external ? null : id);

      if (!external) {
        externalSubtitleRef.current = null;
        return;
      }
      const source = sources.find((candidate) => candidate.id === id);
      if (!source) return;
      // Fetched on being chosen rather than up front: a film may carry half a dozen of these
      // and the viewer will read one of them.
      subtitleFetchRef.current?.abort();
      const fetching = new AbortController();
      subtitleFetchRef.current = fetching;
      void ExternalSubtitleTrack.load(source, fetching.signal)
        .then((loaded) => {
          // Unless the viewer has moved on while it was in flight.
          if (wantedSubtitleRef.current === id) externalSubtitleRef.current = loaded;
        })
        .catch(() => {
          // An abandoned fetch is not a failure to report: the viewer asked for something else,
          // or closed the film.
          if (!fetching.signal.aborted) showWarning("Sous-titres externes indisponibles.");
        });
    },
    [showWarning]
  );

  /**
   * What to write under the picture at this instant.
   *
   * An external file, once chosen, is the only source: the pipeline was told to show nothing, so
   * asking it would only ever produce null, and letting it answer at all would mean two sources
   * racing to set the same line.
   */
  const showSubtitleAt = useCallback((seconds: number, fromContainer: () => string | null) => {
    const external = externalSubtitleRef.current;
    setSubtitle(external ? external.textAt(seconds) : fromContainer());
  }, []);

  // Reset for every attempt, not fixed at the mount. A rebuild lowers `ready`, and measured from
  // the mount the wait was instantly minutes long — so a rebuild that takes half a second
  // announced itself as "still working", which is a spinner lying about what it knows.
  const [openedAt, setOpenedAt] = useState(() => Date.now());

  /** Builds the pipeline again from where the viewer is, keeping what they had chosen. */
  const restart = useCallback((at: number, why: string) => {
    trace(`reprise : ${why} — reconstruction à ${at.toFixed(1)} s`);
    traceKeepAcrossReset();
    rebuildAtRef.current = at;
    setOpenedAt(Date.now());
    setNetworkLost(null);
    setReady(false);
    setRuntimeError(null);
    setRebuildCount((count) => count + 1);
  }, []);

  // Fetched once and then left alone. The description of a file does not change while it is
  // being watched, and every revalidation handed back a fresh object — which the effect below
  // depends on, so the whole pipeline was torn down and rebuilt behind the viewer's back: a
  // second decoder, a second encoder, a second MediaSource, and the first one's read loop still
  // running against buffers its source had already released.
  const { data: info, error: infoError } = useSWR<DirectPlayInfo>(`/api/jellyfin/direct/${itemId}`, fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
  });
  const error =
    runtimeError ??
    info?.refusedReason ??
    (infoError ? "Impossible de récupérer les informations du fichier." : null);
  // The server's own name for it, which is the only one that knows an episode is an episode.
  // Whatever the caller passed stands until it arrives, so the title never blinks in empty.
  const title = info?.title ?? openedAs;

  /** The file, as every entry in the server's record wants it described. */
  const describeFile = useCallback(
    () => ({
      itemId,
      title: info?.title ?? openedAs,
      container: info?.container ?? "?",
      video: `${info?.video?.codec ?? "?"} ${info?.video?.width ?? "?"}x${info?.video?.height ?? "?"} ${info?.video?.bitDepth ?? "?"}bit`,
      range: info?.video?.rangeType ?? "SDR",
      agent: typeof navigator === "undefined" ? "?" : navigator.userAgent,
    }),
    [itemId, info, openedAs]
  );

  useEffect(() => {
    describeFileRef.current = describeFile;
  }, [describeFile]);

  const resizing = useViewportResizing();
  const isMini = mode === "mini";

  // The two waits this player has, measured the same way: opening a file, and restarting after a
  // pause. Both are usually too short to be worth saying anything about, and occasionally are not.
  const startingFor = useElapsedSince(startingAt);
  const openingFor = useElapsedSince(ready || error ? null : openedAt);
  const waitingFor = openingFor ?? startingFor;
  // Nothing has failed, so there is no error screen — and this is exactly the case that leaves
  // nothing at all behind: a spinner that never stops, on a device with no console.
  const stuck = openingFor !== null && openingFor >= STUCK_AFTER_MS;

  const stopPlaybackNow = usePlaybackSession(
    useCallback(() => positionRef.current, []),
    // The engine talks to the file directly, so there is no Jellyfin transcode session — but
    // progress still has to be reported, or resume points would stop updating for this player.
    // It announces its own start for the same reason: nothing else tells the server this film is
    // being watched, so without it the reports described a session Jellyfin had never heard of.
    ready
      ? {
          itemId,
          playSessionId: `cine-engine-${itemId}`,
          mediaSourceId: itemId,
          playMethod: "DirectPlay",
          client: PLAYBACK_CLIENTS.engine,
          announce: true,
        }
      : null,
    useCallback(() => !playing, [playing])
  );

  useEffect(() => () => subtitleFetchRef.current?.abort(), []);

  const handleClose = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    stopPlaybackNow();
    setClosing(true);
    setTimeout(() => playback.close(), 200);
  }, [playback, stopPlaybackNow]);

  const nextEpisode = session.getNextEpisode?.(itemId) ?? null;

  // Swaps to the next episode in place: the current one's final position is reported first, as
  // on a manual close, but the player stays open so there is no close/reopen flicker between
  // episodes.
  const handleAdvance = useCallback(() => {
    if (!nextEpisode) return;
    stopPlaybackNow();
    playback.advance(nextEpisode);
  }, [nextEpisode, playback, stopPlaybackNow]);

  const handleExpand = useCallback(() => playback.expand(), [playback]);
  const { pos, size, isDragging, handlers } = useMiniPlayerDrag(isMini, handleExpand);

  // Polled only while the panel is open: it is a debugging surface, not something to run twice a
  // second behind a closed drawer.
  useEffect(() => {
    if (!showInfo && !error && !stuck) return;
    const read = () => {
      try {
        setDiagnostics(remuxRef.current?.diagnostics ?? engineRef.current?.diagnostics ?? { Moteur: "non démarré" });
      } catch (error) {
        // A panel that silently shows nothing is worse than one that shows why.
        setDiagnostics({ "Diagnostic indisponible": error instanceof Error ? error.message : "erreur" });
      }
    };
    read(); // straight away, not after the first tick
    const id = setInterval(read, 500);
    return () => clearInterval(id);
  }, [showInfo, error, stuck]);

  // What this device actually accepts, asked of the platform rather than assumed. It is the only
  // way to know whether a codec the browser cannot decode could still be played by decoding it
  // here and handing back something the browser will take.
  useEffect(() => {
    if (!showInfo || capabilities) return;
    let cancelled = false;
    void probeCapabilities()
      .then((found) => {
        if (!cancelled) setCapabilities(describeCapabilities(found));
      })
      .catch(() => {
        if (!cancelled) setCapabilities({ "Sonde des capacités": "échec" });
      });
    return () => {
      cancelled = true;
    };
  }, [showInfo, capabilities]);

  // iOS starts every AudioContext suspended and only lets it resume from the task of a real
  // interaction. The player's own container already tries on each pointer down, but a tap can
  // land on a control that stops propagation, or on browser chrome — so the document is watched
  // too, in the capture phase, for as long as the player is open. Resuming an already-running
  // context costs nothing, which is why this can afford to be indiscriminate.
  useEffect(() => {
    const resume = () => void engineRef.current?.resumeAudio();
    document.addEventListener("pointerdown", resume, true);
    document.addEventListener("touchend", resume, true);
    return () => {
      document.removeEventListener("pointerdown", resume, true);
      document.removeEventListener("touchend", resume, true);
    };
  }, []);

  // Sets up the whole pipeline once the file's description has arrived. Everything it can refuse
  // is refused here, with the reason, rather than deeper down where the message would be opaque.
  useEffect(() => {
    if (!info && infoError) {
      fallToStable("les informations du fichier n'ont pas pu être récupérées");
      return;
    }
    // Nothing is started for a file the server already refused: it named the reason, and the
    // stable player is the one that can negotiate around it.
    if (info?.refusedReason) {
      fallToStable(info.refusedReason);
      return;
    }
    if (!info || !canvasRef.current || !videoElRef.current) return;

    let cancelled = false;
    let unsubscribes: (() => void)[] = [];

    // A pipeline that has just become ready cannot owe a resume or a track change: whatever the
    // previous one was waiting for died with it, and a wait nobody will ever answer is a spinner
    // that never stops. Cleared where readiness is declared rather than in an effect watching
    // for it, so nothing is left hanging for a render.
    /**
     * Opens the film on the tracks the viewer's Jellyfin account asks for.
     *
     * Only when they have not chosen anything themselves: a rebuild after a network cut must
     * give back what *they* picked, not what their account would have picked. Which is also why
     * the outcome is written into those same refs — from here on it is their choice.
     *
     * Deliberately does nothing when the preference cannot be honoured. A viewer who asked for
     * French and is handed the only other track has been given a film in a language they did not
     * ask for, and told nothing about it.
     */
    const applyPreferences = (audio: EngineTrack[], subtitles: EngineTrack[]): number | null => {
      const preferences = info.preferences;
      if (!preferences || wantedAudioRef.current !== null || wantedSubtitleRef.current !== null) return null;

      const wantedAudio = chooseAudioTrack(audio, preferences);
      const spoken = trackLanguage(wantedAudio ?? audio.find((track) => track.isDefault) ?? audio[0] ?? {
        language: null,
        name: null,
        isDefault: false,
        isForced: false,
      });
      const wantedSubtitle = chooseSubtitleTrack(
        [...subtitles, ...(info.externalSubtitles ?? []).map(externalToEngineTrack)],
        preferences,
        spoken
      );
      trace(
        `préférences du compte : audio ${preferences.audioLanguage ?? "—"}, sous-titres ` +
          `${preferences.subtitleLanguage ?? "—"} (${preferences.subtitleMode ?? "Default"}) → ` +
          `piste ${wantedAudio?.number ?? "inchangée"}, sous-titres ${wantedSubtitle?.number ?? "aucun"}`
      );

      if (wantedSubtitle) chooseSubtitle(wantedSubtitle.number, info.externalSubtitles ?? []);
      return wantedAudio?.number ?? null;
    };

    // Timed from here rather than from the `openedAt` state: that one is reset by a restart, so
    // depending on it would make every restart rebuild the pipeline a second time.
    const attemptStartedAt = Date.now();
    let announced = false;
    /** Written once per pipeline: what was actually chosen, and how long it took to get there. */
    const announceStart = (chosen: "remux" | "webcodecs" | "direct", why: string | null) => {
      if (announced) return;
      announced = true;
      reportPlayback("start", {
        ...describeFileRef.current(),
        path: chosen,
        reason: why ?? "",
        openedInMs: Date.now() - attemptStartedAt,
        at: startSeconds,
        rebuild: rebuildCount,
      });
    };

    const declareReady = () => {
      setStartingAt(null);
      setSwitchingAudio(false);
      // The position this pipeline was built to resume at has now been used, and is cleared here
      // rather than from an effect watching readiness. That effect could land *after* a newer
      // failure had already written the next position — and it did: a source lost in the same
      // tick as the start had its position wiped, so the film began again from zero instead of
      // resuming. Cleared at the exact moment the pipeline that consumed it is running, nothing
      // written afterwards can be undone by it.
      rebuildAtRef.current = null;
      setReady(true);
    };
    // Where to open. A rebuild that asked for a position gets it; otherwise the film resumes
    // where it actually is, and only a player that has never played anything falls back to where
    // it was told to start. Without that last part, a rebuild nobody asked for — and there was
    // one, every time the player was minimised — sent the film back to where it began.
    const startSeconds =
      rebuildAtRef.current ?? (positionRef.current > 0 ? positionRef.current : session.resumeAt ?? info.resumeSeconds ?? 0);

    // The file decides which pipeline runs, not a setting: repackaging it for the browser's own
    // decoder is better on every axis when the codecs allow it, and decoding it ourselves is the
    // fallback for when they do not. Whichever loses says why, in the technical panel.
    const startRemux = async (element: HTMLVideoElement, begin: (video: HTMLVideoElement) => Promise<RemuxPlayback>) => {
      const playback = await begin(element);
      if (cancelled) return playback.destroy();

      remuxRef.current = playback;
      setPath("remux");
      announceStart("remux", "remultiplexage → lecteur natif");
      setTracks({ audio: playback.audioTracks, subtitles: playback.subtitleTracks });

      // Given back what the viewer had chosen, if this pipeline is a replacement for one that
      // had it. A film that comes back after a network cut in the wrong language, with the
      // subtitles gone, has not really come back.
      // What the viewer chose, if this pipeline replaces one that had it — and otherwise what
      // their account asks for, which is what a first opening gets.
      const preferred = applyPreferences(playback.audioTracks, playback.subtitleTracks);
      const wantedAudio = wantedAudioRef.current ?? preferred;
      const wantedSubtitle = wantedSubtitleRef.current;
      // A track number from a file beside the film means nothing to a pipeline reading the
      // file itself; it is answered here instead, out of what was already fetched.
      if (wantedSubtitle !== null && !isExternalTrack(wantedSubtitle)) playback.selectSubtitleTrack(wantedSubtitle);
      setCurrentSubtitle(wantedSubtitle);
      setCurrentAudio(playback.currentAudioTrack);
      declareReady();
      if (wantedAudio !== null && wantedAudio !== playback.currentAudioTrack) {
        wantedAudioRef.current = wantedAudio;
        setSwitchingAudio(true);
        void playback
          .selectAudioTrack(wantedAudio)
          .then(() => setCurrentAudio(playback.currentAudioTrack))
          .catch(() => {})
          .finally(() => setSwitchingAudio(false));
      }

      const onTime = () => {
        positionRef.current = element.currentTime;
        showSubtitleAt(element.currentTime, () => playback.subtitleAt(element.currentTime));
      };
      // A warning about not being able to reach a position is obsolete the instant pictures are
      // moving again. Leaving it up made a recovered hiccup look like a lasting fault.
      const onPlay = () => {
        setPlaying(true);
        showWarning(null);
      };
      const onPause = () => setPlaying(false);
      element.addEventListener("timeupdate", onTime);
      element.addEventListener("play", onPlay);
      element.addEventListener("pause", onPause);
      element.addEventListener("ended", onPause);
      unsubscribes.push(() => {
        element.removeEventListener("timeupdate", onTime);
        element.removeEventListener("play", onPlay);
        element.removeEventListener("pause", onPause);
        element.removeEventListener("ended", onPause);
      });

      await element.play().catch(() => {});
    };

    /**
     * The shortest path there is: hand the element the URL and get out of the way.
     *
     * An ISO base media file needs none of this machinery — it is already the packaging the
     * remux path spends its time producing. The browser fetches its own ranges, decodes in
     * hardware, seeks and shows HDR, and does all of it better than anything that could be put
     * in front of it. What is given up is the track and subtitle menus, which are read out of a
     * Matroska container this player never opens here; those files carry one audio track.
     */
    const startDirect = async (element: HTMLVideoElement) => {
      setPath("direct");
      setPathReason("lecture directe — le conteneur est déjà celui du navigateur");
      announceStart("direct", "le conteneur est déjà celui du navigateur");
      setTracks({ audio: [], subtitles: [] });
      setCurrentAudio(null);
      // Nothing here opens the container, so the only tracks to choose between are the subtitle
      // files beside the film — which is exactly what this path would otherwise have none of.
      applyPreferences([], []);

      const onTime = () => {
        positionRef.current = element.currentTime;
        // The only subtitles this path can have are the ones beside the file: nothing here opens
        // the container, so there is nothing else to read them out of.
        showSubtitleAt(element.currentTime, () => null);
      };
      const onPlay = () => {
        setPlaying(true);
        showWarning(null);
      };
      const onPause = () => setPlaying(false);
      // The element's own verdict, which is the only one there is on this path.
      const onFailure = () => {
        const failure = element.error;
        const said = `Ce navigateur n'a pas pu lire ce fichier${failure?.message ? ` : ${failure.message}` : ` (code ${failure?.code ?? "?"})`}.`;
        reportPlayback("error", { ...describeFileRef.current(), reason: said, at: positionRef.current });
        setRuntimeError(said);
      };
      // Set once the element knows how long the film is: asking earlier is ignored.
      const onMetadata = () => {
        if (startSeconds > 1) element.currentTime = startSeconds;
        declareReady();
      };
      element.addEventListener("timeupdate", onTime);
      element.addEventListener("play", onPlay);
      element.addEventListener("pause", onPause);
      element.addEventListener("ended", onPause);
      element.addEventListener("error", onFailure);
      element.addEventListener("loadedmetadata", onMetadata, { once: true });
      unsubscribes.push(() => {
        element.removeEventListener("timeupdate", onTime);
        element.removeEventListener("play", onPlay);
        element.removeEventListener("pause", onPause);
        element.removeEventListener("ended", onPause);
        element.removeEventListener("error", onFailure);
        element.removeEventListener("loadedmetadata", onMetadata);
        element.removeAttribute("src");
        element.load();
      });

      element.src = info.streamUrl;
      await element.play().catch(() => {});
    };

    const startEngine = async (reason: string | null) => {
      setPathReason(reason);
      // Only now is this refusal real. The native path would have shown this file's HDR without
      // converting anything; it is landing on the canvas that makes tone mapping — and therefore
      // the viewer's consent to it — necessary.
      if (info.canvasHdrRefusal) {
        setPath("webcodecs");
        fallToStable(info.canvasHdrRefusal);
        return;
      }

      const engine = new PlaybackEngine(canvasRef.current!);
      engineRef.current = engine;
      setPath("webcodecs");
      announceStart("webcodecs", reason);

      unsubscribes = [
        // The engine distinguishes the two itself, rather than the host guessing from the
        // wording: a warning is degraded playback that continues, an error stops it.
        engine.on("error", (payload) => fallToStable(typeof payload === "string" ? payload : "Lecture interrompue.")),
        engine.on("warning", (payload) => showWarning(typeof payload === "string" ? payload : null)),
        engine.on("timeupdate", () => {
          positionRef.current = engine.currentTime;
          if (externalSubtitleRef.current) showSubtitleAt(engine.currentTime, () => null);
        }),
        engine.on("playing", () => setPlaying(true)),
        engine.on("pause", () => setPlaying(false)),
        engine.on("ended", () => setPlaying(false)),
        engine.on("subtitle", (payload) => {
          // Silenced while a file beside the film is showing, which the engine knows nothing of.
          if (externalSubtitleRef.current) return;
          setSubtitle(typeof payload === "string" ? payload : null);
        }),
        // Controls appear as soon as the file is understood — duration, tracks — rather than
        // waiting for the whole pipeline to fill. Anything that goes wrong afterwards replaces
        // them with the error panel, so there is no window where a broken player looks usable.
        engine.on("loadedmetadata", () => {
          setTracks({ audio: engine.audioTracks, subtitles: engine.subtitleTracks });
          setCurrentAudio(engine.currentAudioTrack);
          declareReady();
        }),
      ];

      await engine.load(info.streamUrl, { hdr: info.video?.isHdr ?? false, startSeconds });
      if (cancelled) return;

      const built = new MediaElementFacade(engine);
      facadeRef.current = built;
      setFacade(built);
      setTracks({ audio: engine.audioTracks, subtitles: engine.subtitleTracks });
      const preferred = applyPreferences(engine.audioTracks, engine.subtitleTracks);
      if (preferred !== null && preferred !== engine.currentAudioTrack) {
        wantedAudioRef.current = preferred;
        await engine.setAudioTrack(preferred).catch(() => {});
      }
      setCurrentAudio(engine.currentAudioTrack);
      declareReady();
      await engine.play().catch(() => {});
    };

    const element = videoElRef.current;
    probePlaybackPath({
      streamUrl: info.streamUrl,
      startSeconds,
      onError: (message, kind) => {
        // A network failure is not this path's fault and not this path's to fix.
        if (kind === "network") {
          trace(`réseau : lecture interrompue — ${message}`);
          reportPlayback("network", { ...describeFileRef.current(), reason: message, at: positionRef.current });
          setNetworkLost({ message, at: positionRef.current, audio: wantedAudioRef.current });
          return;
        }
        // A closed source is not a fault to report, it is a pipeline to build again. Safari
        // closes one from time to time — a decode failure it will not explain, sometimes on a
        // seek, sometimes at a change of track — and everything that follows is wreckage. The
        // machinery for the sleep case already knows how to come back at the right position, so
        // it is used here too, and only a loss that keeps happening is finally reported.
        if (remuxRef.current?.lost && rebuildsRef.current < MAX_REBUILDS) {
          rebuildsRef.current += 1;
          const where = remuxRef.current.position || positionRef.current;
          // The same place twice means the media there is what the platform cannot take. Reading
          // it again would fail again, identically — the record shows three rebuilds doing
          // exactly that — so the film resumes past it instead.
          const again = lastRebuildAtRef.current !== null && Math.abs(where - lastRebuildAtRef.current) < SAME_PLACE_SECONDS;
          const at = again ? where + REBUILD_STEP_SECONDS : where;
          lastRebuildAtRef.current = where;
          reportPlayback("rebuild", {
            ...describeFileRef.current(),
            reason: message,
            at,
            attempt: rebuildsRef.current,
            skipped: again,
          });
          restart(
            at,
            `la source a été perdue (${rebuildsRef.current})` +
              (again ? `, au-delà de ${where.toFixed(1)} s qui vient d'échouer` : "")
          );
          // Only the first of these is the viewer's business: a passage of the film is being
          // skipped, and a jump nobody explained looks like a fault. Rebuilding in place and
          // carrying on is not something they need to be told about — it is in the record.
          if (again) showWarning("Un passage de ce fichier n'a pas pu être décodé : la lecture reprend juste après.");
          return;
        }
        fallToStable(message);
      },
      onWarning: (message) => showWarning(message),
      onStarting: (at) => setStartingAt(at),
    })
      .then((probe) => {
        if (cancelled) {
          // Abandoned before it could be used, and it is holding a decoder, an encoder and an
          // open stream. Nothing else will ever come back for them.
          probe.discard();
          return;
        }
        if (probe.path === "remux") return startRemux(element, probe.start);
        if (probe.path === "direct") return startDirect(element);
        return startEngine(describePath(probe.chosen));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "Le fichier n'a pas pu être ouvert.";
        // A file that could not even be opened because there is no network is not a file this
        // player cannot play. It gets the waiting screen, like a cut that happens mid-film.
        if (isNetworkFailure(cause)) {
          trace(`réseau : ouverture impossible — ${message}`);
          setNetworkLost({ message, at: positionRef.current, audio: wantedAudioRef.current });
          return;
        }
        fallToStable(message);
      });

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      remuxRef.current?.destroy();
      remuxRef.current = null;
      facadeRef.current?.destroy();
      facadeRef.current = null;
      setFacade(null);
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [info, infoError, fallToStable, restart, session.resumeAt, rebuildCount, showSubtitleAt, showWarning, chooseSubtitle]);

  // Watches for the platform having taken the source away while the page was not on screen. The
  // check runs on returning to the foreground, and once more a moment later: on iOS the closure
  // is not always visible in the same task as the visibility change.
  useEffect(() => {
    if (path !== "remux") return;
    const check = () => {
      const playback = remuxRef.current;
      if (!playback?.lost || rebuildAtRef.current !== null) return;
      if (rebuildsRef.current >= MAX_REBUILDS) return;
      rebuildsRef.current += 1;
      restart(playback.position || positionRef.current, "la plateforme a fermé la source");
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      check();
      setTimeout(check, 400);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [path, restart]);

  // Watched only while something is waiting on it: an idle player has no use for the news.
  useEffect(() => {
    if (!networkLost) return;
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [networkLost]);

  // Back on its own, so the viewer does not have to notice before the film can.
  useEffect(() => {
    if (!networkLost || !online) return;
    const at = networkLost.at;
    const id = setTimeout(() => restart(at, "le réseau est revenu"), 800);
    return () => clearTimeout(id);
  }, [networkLost, online, restart]);

  /**
   * A notice withdraws itself.
   *
   * Every one of these describes a moment, not a state: a segment refused and re-fetched, a
   * position reached the second way round, a subtitle file that did not come. Left on screen
   * they outlive what they were about — a warning that the film could not reach a position sat
   * there for the rest of the film, while the film played. What raised it is kept in the
   * technical panel and in the trace, which is where a lasting record belongs.
   */
  useEffect(() => {
    if (!warning) return;
    const id = setTimeout(() => setWarning(null), WARNING_MS);
    return () => clearTimeout(id);
  }, [warning]);

  // A player that never starts is the one failure a viewer cannot wait out: nothing on screen
  // changes, so there is nothing to react to. On a timer rather than derived from the clock, so
  // stepping aside happens on its own account and not in the middle of a render.
  useEffect(() => {
    // Never while waiting on the network. The whole point of that screen is that the film is not
    // lost and nothing about this file or this browser is wrong; giving up into the stable
    // player — which needs the very same network — would abandon hardware decoding for a reason
    // that has nothing to do with it, and after thirty-five seconds of an outage, silently.
    if (ready || runtimeError || networkLost) return;
    const id = setTimeout(
      () => fallToStable(`aucune image après ${GIVE_UP_AFTER_MS / 1000} s`),
      Math.max(0, openedAt + GIVE_UP_AFTER_MS - Date.now())
    );
    return () => clearTimeout(id);
  }, [ready, runtimeError, networkLost, openedAt, fallToStable]);


  // Below the threshold nothing is shown, and a resume that takes a moment reads as instant
  // rather than as a flash of spinner drawing attention to itself.
  //
  // The two waits are answered in different places, and deliberately never both at once: opening
  // has no controls on screen yet, so it gets this component's own overlay, while a resume
  // borrows the spinner the controls already put in place of the button. Driving both from one
  // flag stacked one spinner on top of the other.
  const openingSpinner = openingFor !== null && openingFor >= SPINNER_AFTER_MS;
  const resumeSpinner = startingFor !== null && startingFor >= SPINNER_AFTER_MS;
  const waitingWord =
    waitingFor === null || waitingFor < WORD_AFTER_MS
      ? null
      : waitingFor >= STILL_WORKING_AFTER_MS
        ? t("player.experimental.stillWorking")
        : openingFor !== null
          ? t("player.experimental.loading")
          : t("player.experimental.preparing");

  const report: ReportInput = {
    error,
    elapsedMs: openingFor,
    title,
    itemId,
    file: (info as unknown as Record<string, unknown>) ?? null,
    pathReason,
    diagnostics: {
      ...diagnostics,
      // The spinner's own state. It has told the viewer it was working when it was not, and
      // nothing in the report said which of the three reasons was holding it up.
      Attente: [
        ready ? null : "démarrage",
        startingAt !== null ? "reprise" : null,
        switchingAudio ? "changement de piste" : null,
      ]
        .filter(Boolean)
        .join(" · ") || "aucune",
    },
    running: ready && !error,
  };

  if (typeof document === "undefined") return null;

  const style: React.CSSProperties = isMini
    ? {
        position: "fixed",
        top: pos.y,
        left: pos.x,
        width: size.width,
        height: size.height,
        borderRadius: 16,
        zIndex: 80,
        overflow: "hidden",
        boxShadow: "0 10px 30px rgba(0,0,0,.5)",
        transition: isDragging || resizing ? "none" : TRANSITION,
        touchAction: "none",
      }
    : {
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        borderRadius: 0,
        zIndex: 80,
        background: "black",
        transition: resizing ? "opacity 200ms ease-out" : `${TRANSITION}, opacity 200ms ease-out`,
        opacity: closing ? 0 : 1,
      };

  return createPortal(
    <div
      ref={containerRef}
      style={style}
      className={isMini ? "animate-fade-in-scale" : "app-viewport"}
      // Every touch is an opportunity to unblock the audio hardware — see resumeAudio(). Capture
      // phase and pointerdown specifically, so the permission is used before any control's own
      // handler has a chance to await something and lose it.
      onPointerDownCapture={() => void engineRef.current?.resumeAudio()}
      {...(isMini ? handlers : {})}
    >
      {/* Both surfaces are mounted from the start, because the element that shows the picture is
          only known once the file has been examined and the remux path needs a <video> to attach
          to before it can begin. The unused one holds nothing and is hidden. */}
      <video
        ref={videoElRef}
        playsInline
        hidden={!onElement}
        className={isMini ? "h-full w-full object-cover" : "h-full w-full object-contain"}
      />
      <canvas
        ref={canvasRef}
        hidden={onElement}
        className={isMini ? "h-full w-full object-cover" : "h-full w-full object-contain"}
      />

      {subtitle && !isMini && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-center px-8">
          <p
            className="max-w-4xl whitespace-pre-line text-center text-lg font-medium leading-snug text-white sm:text-2xl"
            // Drawn with a shadow rather than a box: a background plate is heavier over a moving
            // picture, and this is what every player converges on.
            style={{ textShadow: "0 2px 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,1)" }}
          >
            {subtitle}
          </p>
        </div>
      )}

      {/* A network cut is not a fault to report, it is a wait to sit through — so it gets its own
          screen rather than the error one. The film is not lost: the position, the language and
          the subtitles are all still here, and pressing the button gives them back. */}
      {networkLost && !isMini && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
          <WifiOff className={online ? "text-slate-500" : "text-amber-400"} size={32} />
          <div>
            <p className="text-base font-medium text-white">
              {online ? "La connexion est revenue" : "Connexion perdue"}
            </p>
            <p className="mt-1 max-w-md text-sm leading-6 text-slate-400">
              {online
                ? "La lecture reprend là où elle s'était arrêtée."
                : "La lecture reprendra exactement ici, dans la même langue, dès que le réseau sera de retour."}
            </p>
          </div>
          <p className="text-xs text-slate-500">
            {`Reprise à ${formatClock(networkLost.at)}`}
            {networkLost.audio !== null &&
              ` · ${tracks.audio.find((a) => a.number === networkLost.audio)?.language ?? "piste choisie"}`}
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => restart(networkLost.at, "réessai demandé")}
              className="btn-primary inline-flex items-center gap-2"
            >
              <RotateCw size={16} />
              Réessayer
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20"
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      )}

      {error && !networkLost && !isMini && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
          <AlertTriangle className="text-amber-400" size={32} />
          <p className="text-base font-medium text-white">{t("player.experimental.title")}</p>
          <p className="max-w-lg text-sm leading-6 text-slate-300">{error}</p>
          <ExperimentalPlayerReport input={report} />
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <button type="button" onClick={() => onFallback(error ?? "demandé par le spectateur")} className="btn-primary">
              {t("player.experimental.switchToStable")}
            </button>
            <button type="button" onClick={handleClose} className="rounded-lg bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20">
              {t("common.close")}
            </button>
          </div>
        </div>
      )}

      {warning && !error && !isMini && (
        <div className="pointer-events-none absolute inset-x-0 top-16 z-10 flex justify-center">
          <span className="rounded-full bg-amber-500/15 px-3 py-1.5 text-xs text-amber-200 ring-1 ring-amber-400/30">
            {warning.text}
          </span>
        </div>
      )}

      {/* The technical panel is this player's own: the stable one's reads Jellyfin's transcode
          session, and there is no transcode session here — everything below is what the browser
          is actually doing. */}
      {showInfo && !isMini && (
        <div className="absolute right-4 top-16 z-20 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/90 p-4 text-xs text-slate-300 backdrop-blur-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-white">{t("player.experimental.badge")}</p>
            {/* The panel sits over the controls, so without this the only way out was to close
                the player. */}
            <button
              type="button"
              onClick={() => setShowInfo(false)}
              aria-label={t("common.close")}
              className="-mr-1 -mt-1 rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>
          <PathBadge path={path} />
          {/* Shown whether or not the path succeeded: a step down whose reason is invisible is
              the same as one that happened silently. */}
          {pathReason && <p className="mt-2 text-[11px] leading-4 text-slate-400">{pathReason}</p>}

          <div className="mt-3 space-y-2.5">
            <InfoSection title="Le fichier">
              <InfoRow label="Conteneur" value={info?.container?.toUpperCase() ?? "?"} />
              <InfoRow
                label="Vidéo"
                value={`${info?.video?.codec ?? "?"} · ${info?.video?.width ?? "?"}×${info?.video?.height ?? "?"} · ${info?.video?.bitDepth ?? "?"} bits`}
              />
              <InfoRow label="Plage" value={info?.video?.rangeType ?? "SDR"} />
              <InfoRow label="Pistes" value={`${tracks.audio.length} audio · ${tracks.subtitles.length} sous-titres`} />
            </InfoSection>

            <InfoSection title="Le son">
              <InfoRow
                label="Piste"
                value={
                  currentAudio !== null
                    ? tracks.audio.find((a) => a.number === currentAudio)?.codecId.replace("A_", "") ?? "?"
                    : "aucune piste décodable"
                }
              />
              {AUDIO_ROWS.filter((k) => k in diagnostics).map((k) => (
                <InfoRow key={k} label={k} value={diagnostics[k]} />
              ))}
            </InfoSection>

            <InfoSection title="Le flux">
              <InfoRow label="Transcodage serveur" value="aucun" />
              {Object.entries(diagnostics)
                .filter(([label]) => !AUDIO_ROWS.includes(label))
                .map(([label, value]) => (
                  <InfoRow key={label} label={label} value={value} />
                ))}
            </InfoSection>

            {capabilities && (
              <InfoSection title="Ce que l'appareil accepte">
                {Object.entries(capabilities).map(([label, value]) => (
                  <InfoRow key={label} label={label} value={value} />
                ))}
              </InfoSection>
            )}
          </div>

          {/* The record of how this file was opened, kept where it can be reached while playing:
              the faults left to chase are the ones that happen *after* a successful start. */}
          <ExperimentalPlayerReport input={report} />
        </div>
      )}

      {isMini ? (
        <MiniPlayerChrome
          title={title}
          playing={playing}
          onTogglePlay={() => {
            const element = videoElRef.current;
            if (onElement && element) {
              if (element.paused) void element.play();
              else element.pause();
              return;
            }
            const engine = engineRef.current;
            if (!engine) return;
            if (engine.paused) void engine.play();
            else engine.pause();
          }}
          onClose={handleClose}
        />
      ) : (
        ready &&
        (facade || onElement) &&
        !error && (
          <PlayerControls
            // On the remux path this is a real media element, so seeking, volume and rate are the
            // browser's own; the facade exists only to give the canvas pipeline the same shape.
            videoRef={onElement ? videoElRef : { current: facade ? asVideoElement(facade) : null }}
            containerRef={containerRef}
            itemId={itemId}
            title={title}
            onClose={handleClose}
            onMinimize={() => playback.minimize()}
            // Straight from the container the engine is reading, not from Jellyfin's view of the
            // file: those are the tracks it can actually switch between.
            audioTracks={tracks.audio.map((track) => ({ id: track.number, label: trackLabel(track) }))}
            currentAudioId={currentAudio}
            onChangeAudio={(id) => {
              setCurrentAudio(id);
              if (path === "remux") {
                // The menu follows what actually happened rather than what was asked for: a track
                // the browser turns out not to be able to open leaves the previous one playing.
                wantedAudioRef.current = id;
                setSwitchingAudio(true);
                void remuxRef.current
                  ?.selectAudioTrack(id)
                  .then(() => setCurrentAudio(remuxRef.current?.currentAudioTrack ?? id))
                  .finally(() => setSwitchingAudio(false));
              } else {
                void engineRef.current?.setAudioTrack(id);
              }
            }}
            subtitleTracks={[...tracks.subtitles, ...(info?.externalSubtitles ?? []).map(externalToEngineTrack)].map(
              (track) => ({ id: track.number, label: trackLabel(track) })
            )}
            currentSubtitleId={currentSubtitle}
            onChangeSubtitle={(id) => chooseSubtitle(id, info?.externalSubtitles ?? [])}
            onTogglePlaybackInfo={() => setShowInfo((open) => !open)}
            hidden={false}
            // The controls already answer this by swapping the button for a spinner, so restarting
            // after a pause borrows the same treatment rather than growing a second indicator.
            loading={!ready || resumeSpinner || switchingAudio}
            // Jellyfin's own analysis of the episode, fetched alongside the file's description.
            // Playback speed needs nothing here: on the native path these controls hold a real
            // media element, so it is the browser's own.
            introSkip={info?.introSkip ?? null}
            creditsStart={info?.creditsStart ?? null}
            nextEpisode={nextEpisode}
            onAdvance={handleAdvance}
          />
        )
      )}

      {openingSpinner && !error && !isMini && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            {/* Silent while the wait is too short to read. A sentence that appears and goes before
                it can be finished is noise, not company. */}
            {waitingWord && <p className="text-sm text-slate-400">{waitingWord}</p>}
          </div>
        </div>
      )}

      {/* The wait has gone past explaining itself. The report is pointer-enabled where the
          spinner above is not: it exists to be selected and copied. */}
      {stuck && !error && !isMini && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-black/95 to-transparent px-6 pb-6 pt-16">
          <ExperimentalPlayerReport input={report} />
        </div>
      )}

      {/* A resume long enough to deserve a word gets the word only: the controls are already
          showing the spinner, and a second one beside it is what this looked like at first. */}
      {!openingSpinner && resumeSpinner && waitingWord && !error && !isMini && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 mt-10 flex justify-center">
          <p className="text-sm text-slate-400">{waitingWord}</p>
        </div>
      )}
    </div>,
    document.body
  );
}
