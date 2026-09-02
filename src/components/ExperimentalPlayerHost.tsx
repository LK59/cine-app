"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { AlertTriangle } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { usePlayback } from "@/components/PlaybackProvider";
import { PlayerControls } from "@/components/PlayerControls";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { useViewportResizing } from "@/lib/useViewportResizing";
import { useT } from "@/components/TranslationProvider";
import { PlaybackEngine } from "@/lib/webcodecs/engine";
import { MediaElementFacade, asVideoElement } from "@/lib/webcodecs/mediaFacade";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";

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

  const handleExpand = useCallback(() => playback.expand(), [playback]);
  const { pos, size, isDragging, handlers } = useMiniPlayerDrag(isMini, handleExpand);

  // Sets up the whole pipeline once the file's description has arrived. Everything it can refuse
  // is refused here, with the reason, rather than deeper down where the message would be opaque.
  useEffect(() => {
    // Nothing is started for a file the server already refused — the reason is displayed
    // instead, derived above.
    if (!info || info.refusedReason || !canvasRef.current) return;

    let cancelled = false;
    const engine = new PlaybackEngine(canvasRef.current);
    engineRef.current = engine;

    const unsubscribes = [
      engine.on("error", (payload) => {
        const message = typeof payload === "string" ? payload : "Lecture interrompue.";
        // A missing audio codec is a degraded playback, not a dead one — the engine keeps going
        // silently, so it is shown as a warning rather than replacing the picture with an error.
        if (message.includes("audio")) setWarning(message);
        else setRuntimeError(message);
      }),
      engine.on("timeupdate", () => {
        positionRef.current = engine.currentTime;
      }),
      engine.on("playing", () => setPlaying(true)),
      engine.on("pause", () => setPlaying(false)),
      engine.on("ended", () => setPlaying(false)),
    ];

    engine
      .load(info.streamUrl, {
        hdr: info.video?.isHdr ?? false,
        startSeconds: session.resumeAt ?? info.resumeSeconds ?? 0,
      })
      .then(async () => {
        if (cancelled) return;
        const built = new MediaElementFacade(engine);
        facadeRef.current = built;
        setFacade(built);
        setReady(true);
        await engine.play().catch(() => {});
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setRuntimeError(cause instanceof Error ? cause.message : "Le fichier n'a pas pu être ouvert.");
      });

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      facadeRef.current?.destroy();
      facadeRef.current = null;
      setFacade(null);
      engine.destroy();
      engineRef.current = null;
    };
  }, [info, session.resumeAt]);

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
      {...(isMini ? handlers : {})}
    >
      <canvas ref={canvasRef} className={isMini ? "h-full w-full object-cover" : "h-full w-full object-contain"} />

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

      {isMini ? (
        <MiniPlayerChrome
          title={title}
          playing={playing}
          onTogglePlay={() => {
            const engine = engineRef.current;
            if (!engine) return;
            if (engine.paused) void engine.play();
            else engine.pause();
          }}
          onClose={handleClose}
        />
      ) : (
        ready &&
        facade &&
        !error && (
          <PlayerControls
            videoRef={{ current: asVideoElement(facade) }}
            containerRef={containerRef}
            itemId={itemId}
            title={title}
            onClose={handleClose}
            onMinimize={() => playback.minimize()}
            audioTracks={(info?.audio ?? []).map((track) => ({
              id: track.index,
              label: track.displayTitle ?? track.language ?? `Piste ${track.index}`,
            }))}
            currentAudioId={info?.audio.find((a) => a.isDefault)?.index ?? null}
            onChangeAudio={() => {}}
            subtitleTracks={[]}
            currentSubtitleId={null}
            onChangeSubtitle={() => {}}
            onTogglePlaybackInfo={() => {}}
            hidden={false}
            loading={!ready}
            // Intro/credits markers and episode chaining come from the stable player's own
            // Jellyfin negotiation; wiring them here is a later step rather than a half-working
            // approximation now.
            introSkip={null}
            creditsStart={null}
            nextEpisode={null}
            onAdvance={() => {}}
          />
        )
      )}

      {!ready && !error && !isMini && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            <p className="text-sm text-slate-400">{t("player.experimental.loading")}</p>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
