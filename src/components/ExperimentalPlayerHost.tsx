"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { AlertTriangle, X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { usePlayback } from "@/components/PlaybackProvider";
import { PlayerControls } from "@/components/PlayerControls";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { useViewportResizing } from "@/lib/useViewportResizing";
import { useT } from "@/components/TranslationProvider";
import { PlaybackEngine } from "@/lib/webcodecs/engine";
import { MediaElementFacade, asVideoElement } from "@/lib/webcodecs/mediaFacade";
import { probePlaybackPath, type RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";
import { describePath } from "@/lib/webcodecs/pathSelector";
import { describeCapabilities, probeCapabilities } from "@/lib/webcodecs/capabilities";
import type { EngineTrack } from "@/lib/webcodecs/engine";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";

/** How long a threshold has to be crossed before anything is shown at all. */
const SPINNER_AFTER_MS = 120;

/** And before the wait is worth a sentence, then before it is worth admitting it is long. */
const WORD_AFTER_MS = 1000;
const STILL_WORKING_AFTER_MS = 3000;

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
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-200">{value}</dd>
    </div>
  );
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
  onFallback: () => void;
}) {
  const t = useT();
  const playback = usePlayback();
  const { itemId, title } = session;

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
  const [warning, setWarning] = useState<string | null>(null);
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
  const [path, setPath] = useState<"remux" | "webcodecs" | null>(null);
  // When playback was asked to start, and has not yet. Reported by the pipeline as a measured
  // fact rather than guessed from the platform: on a desktop it clears within a frame, so none
  // of what follows ever appears there.
  const [startingAt, setStartingAt] = useState<number | null>(null);
  // Why this file is being played the way it is. Kept for the panel on *both* paths: a fallback
  // whose reason is only visible on the path that was not taken explains nothing at all.
  const [pathReason, setPathReason] = useState<string | null>(null);
  const [openedAt] = useState(() => Date.now());

  const { data: info, error: infoError } = useSWR<DirectPlayInfo>(`/api/jellyfin/direct/${itemId}`, fetcher);
  const error =
    runtimeError ??
    info?.refusedReason ??
    (infoError ? "Impossible de récupérer les informations du fichier." : null);
  const resizing = useViewportResizing();
  const isMini = mode === "mini";

  const stopPlaybackNow = usePlaybackSession(
    useCallback(() => positionRef.current, []),
    // The engine talks to the file directly, so there is no Jellyfin transcode session — but
    // progress still has to be reported, or resume points would stop updating for this player.
    ready ? { itemId, playSessionId: `webcodecs-${itemId}`, mediaSourceId: itemId, playMethod: "DirectPlay" } : null
  );

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
    if (!showInfo) return;
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
  }, [showInfo]);

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
    // Nothing is started for a file the server already refused — the reason is displayed
    // instead, derived above.
    if (!info || info.refusedReason || !canvasRef.current || !videoElRef.current) return;

    let cancelled = false;
    let unsubscribes: (() => void)[] = [];
    const startSeconds = session.resumeAt ?? info.resumeSeconds ?? 0;

    // The file decides which pipeline runs, not a setting: repackaging it for the browser's own
    // decoder is better on every axis when the codecs allow it, and decoding it ourselves is the
    // fallback for when they do not. Whichever loses says why, in the technical panel.
    const startRemux = async (element: HTMLVideoElement, begin: (video: HTMLVideoElement) => Promise<RemuxPlayback>) => {
      const playback = await begin(element);
      if (cancelled) return playback.destroy();

      remuxRef.current = playback;
      setPath("remux");
      setTracks({ audio: playback.audioTracks, subtitles: playback.subtitleTracks });
      setCurrentAudio(playback.currentAudioTrack);
      setCurrentSubtitle(null);
      setReady(true);

      const onTime = () => {
        positionRef.current = element.currentTime;
        setSubtitle(playback.subtitleAt(element.currentTime));
      };
      // A warning about not being able to reach a position is obsolete the instant pictures are
      // moving again. Leaving it up made a recovered hiccup look like a lasting fault.
      const onPlay = () => {
        setPlaying(true);
        setWarning(null);
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

    const startEngine = async (reason: string | null) => {
      setPathReason(reason);
      // Only now is this refusal real. The native path would have shown this file's HDR without
      // converting anything; it is landing on the canvas that makes tone mapping — and therefore
      // the viewer's consent to it — necessary.
      if (info.canvasHdrRefusal) {
        setPath("webcodecs");
        setRuntimeError(info.canvasHdrRefusal);
        return;
      }

      const engine = new PlaybackEngine(canvasRef.current!);
      engineRef.current = engine;
      setPath("webcodecs");

      unsubscribes = [
        // The engine distinguishes the two itself, rather than the host guessing from the
        // wording: a warning is degraded playback that continues, an error stops it.
        engine.on("error", (payload) => setRuntimeError(typeof payload === "string" ? payload : "Lecture interrompue.")),
        engine.on("warning", (payload) => setWarning(typeof payload === "string" ? payload : null)),
        engine.on("timeupdate", () => {
          positionRef.current = engine.currentTime;
        }),
        engine.on("playing", () => setPlaying(true)),
        engine.on("pause", () => setPlaying(false)),
        engine.on("ended", () => setPlaying(false)),
        engine.on("subtitle", (payload) => setSubtitle(typeof payload === "string" ? payload : null)),
        // Controls appear as soon as the file is understood — duration, tracks — rather than
        // waiting for the whole pipeline to fill. Anything that goes wrong afterwards replaces
        // them with the error panel, so there is no window where a broken player looks usable.
        engine.on("loadedmetadata", () => {
          setTracks({ audio: engine.audioTracks, subtitles: engine.subtitleTracks });
          setCurrentAudio(engine.currentAudioTrack);
          setReady(true);
        }),
      ];

      await engine.load(info.streamUrl, { hdr: info.video?.isHdr ?? false, startSeconds });
      if (cancelled) return;

      const built = new MediaElementFacade(engine);
      facadeRef.current = built;
      setFacade(built);
      setTracks({ audio: engine.audioTracks, subtitles: engine.subtitleTracks });
      setCurrentAudio(engine.currentAudioTrack);
      setReady(true);
      await engine.play().catch(() => {});
    };

    const element = videoElRef.current;
    probePlaybackPath({
      streamUrl: info.streamUrl,
      startSeconds,
      onError: (message) => setRuntimeError(message),
      onWarning: (message) => setWarning(message),
      onStarting: (at) => setStartingAt(at),
    })
      .then((probe) => {
        if (cancelled) return;
        return probe.path === "remux" ? startRemux(element, probe.start) : startEngine(describePath(probe.chosen));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setRuntimeError(cause instanceof Error ? cause.message : "Le fichier n'a pas pu être ouvert.");
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
  }, [info, session.resumeAt]);

  // The two waits this player has, measured the same way: opening a file, and restarting after a
  // pause. Both are usually too short to be worth saying anything about, and occasionally are not.
  const startingFor = useElapsedSince(startingAt);
  const openingFor = useElapsedSince(ready || error ? null : openedAt);
  const waitingFor = openingFor ?? startingFor;

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
        hidden={path !== "remux"}
        className={isMini ? "h-full w-full object-cover" : "h-full w-full object-contain"}
      />
      <canvas
        ref={canvasRef}
        hidden={path === "remux"}
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

      {!isMini && (
        <span className="pointer-events-none absolute left-4 top-4 z-10 rounded-full bg-fuchsia-500/20 px-2.5 py-1 text-xs font-medium text-fuchsia-200 ring-1 ring-fuchsia-400/30">
          {t("player.experimental.badge")}
        </span>
      )}

      {error && !isMini && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
          <AlertTriangle className="text-amber-400" size={32} />
          <p className="text-base font-medium text-white">{t("player.experimental.title")}</p>
          <p className="max-w-lg text-sm leading-6 text-slate-300">{error}</p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <button type="button" onClick={onFallback} className="btn-primary">
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
          <span className="rounded-full bg-amber-500/15 px-3 py-1.5 text-xs text-amber-200 ring-1 ring-amber-400/30">{warning}</span>
        </div>
      )}

      {/* The technical panel is this player's own: the stable one's reads Jellyfin's transcode
          session, and there is no transcode session here — everything below is what the browser
          is actually doing. */}
      {showInfo && !isMini && (
        <div className="absolute right-4 top-16 z-20 max-h-[70vh] w-72 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/90 p-4 text-xs text-slate-300 backdrop-blur-sm">
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
          <dl className="space-y-1.5">
            <InfoRow
              label="Méthode"
              value={path === "remux" ? "Remultiplexage → lecteur natif" : "Décodage direct (WebCodecs)"}
            />
            <InfoRow label="Conteneur" value={info?.container?.toUpperCase() ?? "?"} />
            <InfoRow
              label="Vidéo"
              value={`${info?.video?.codec ?? "?"} ${info?.video?.width ?? "?"}×${info?.video?.height ?? "?"} ${info?.video?.bitDepth ?? "?"} bits`}
            />
            <InfoRow label="Plage" value={info?.video?.rangeType ?? "SDR"} />
            <InfoRow
              label="Audio"
              value={
                currentAudio !== null
                  ? tracks.audio.find((a) => a.number === currentAudio)?.codecId.replace("A_", "") ?? "?"
                  : "aucune piste décodable"
              }
            />
            <InfoRow label="Pistes" value={`${tracks.audio.length} audio, ${tracks.subtitles.length} sous-titres`} />
            <InfoRow label="Transcodage serveur" value="aucun" />
            {/* Shown here too, not only on the path that succeeded: a step down whose reason is
                invisible is the same as one that happened silently. */}
            {pathReason && <InfoRow label="Chemin" value={pathReason} />}
            {Object.entries(diagnostics).map(([label, value]) => (
              <InfoRow key={label} label={label} value={value} />
            ))}
            {capabilities && (
              <>
                <dt className="pt-2 text-[11px] uppercase tracking-wide text-slate-500">Capacités de l&apos;appareil</dt>
                {Object.entries(capabilities).map(([label, value]) => (
                  <InfoRow key={label} label={label} value={value} />
                ))}
              </>
            )}
          </dl>
        </div>
      )}

      {isMini ? (
        <MiniPlayerChrome
          title={title}
          playing={playing}
          onTogglePlay={() => {
            const element = videoElRef.current;
            if (path === "remux" && element) {
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
        (facade || path === "remux") &&
        !error && (
          <PlayerControls
            // On the remux path this is a real media element, so seeking, volume and rate are the
            // browser's own; the facade exists only to give the canvas pipeline the same shape.
            videoRef={path === "remux" ? videoElRef : { current: facade ? asVideoElement(facade) : null }}
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
                void remuxRef.current
                  ?.selectAudioTrack(id)
                  .then(() => setCurrentAudio(remuxRef.current?.currentAudioTrack ?? id));
              } else {
                void engineRef.current?.setAudioTrack(id);
              }
            }}
            subtitleTracks={tracks.subtitles.map((track) => ({ id: track.number, label: trackLabel(track) }))}
            currentSubtitleId={currentSubtitle}
            onChangeSubtitle={(id) => {
              setCurrentSubtitle(id);
              setSubtitle(null);
              if (path === "remux") remuxRef.current?.selectSubtitleTrack(id);
              else engineRef.current?.setSubtitleTrack(id);
            }}
            onTogglePlaybackInfo={() => setShowInfo((open) => !open)}
            hidden={false}
            // The controls already answer this by swapping the button for a spinner, so restarting
            // after a pause borrows the same treatment rather than growing a second indicator.
            loading={!ready || resumeSpinner}
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
