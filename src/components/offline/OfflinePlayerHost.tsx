"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { usePlayback, type PlaybackSession } from "@/components/PlaybackProvider";
import { PlayerControls } from "@/components/PlayerControls";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { ActionSheet } from "@/components/ActionSheet";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { usePlayerBackClose } from "@/lib/playerHistory";
import { usePlayerFocus } from "@/lib/usePlayerFocus";
import { deviceStore } from "@/lib/offline/deviceStore";
import { markOfflineWatched, offlineAccount, offlineDownloadById, saveOfflinePosition, useOfflineDownloads } from "@/lib/offline/downloads";
import { OfflineEngine } from "@/lib/offline/offlineEngine";

/**
 * Le lecteur des téléchargements hors ligne (bêta, 19/10/2026) — un hôte à part, voulu par Louis :
 * il ne partage avec le lecteur en ligne que ses commandes (`PlayerControls`) et le mini-lecteur, et
 * rien de son chemin de lecture (`OfflineEngine` au lieu du remultiplexeur). Il ne demande rien au
 * serveur : le fichier, la piste, les affiches sont sur l'appareil.
 *
 * Une seule piste son est dans le fichier ; le menu montre toutes celles du film. En choisir une
 * autre propose la lecture en ligne à la même position — ou dit qu'on est hors ligne. La position
 * est gardée avec le téléchargement (`saveOfflinePosition`), pas encore renvoyée à Jellyfin.
 */
/**
 * Le fichier tel que le lecteur le lit : ce qui est sur l'appareil d'abord, et pendant le
 * téléchargement, avec du réseau, la suite depuis la copie du serveur — les mêmes octets
 * (`/api/offline/jobs/<id>/file`, bornés à ce qui est écrit). Demandé par Louis le 19/10/2026 : lire
 * le fichier téléchargé avant qu'il soit fini. Sans réseau, seulement ce qui est arrivé.
 */
function offlineSourceFor(account: string, id: string) {
  const local = () => offlineDownloadById(id)?.bytes ?? 0;
  const online = () => typeof navigator === "undefined" || navigator.onLine !== false;
  return {
    available: () => {
      const d = offlineDownloadById(id);
      if (!d) return 0;
      return d.state === "done" ? d.bytes : Math.max(d.bytes, online() ? d.serverBytes : 0);
    },
    complete: () => offlineDownloadById(id)?.state === "done",
    read: async (offset: number, length: number): Promise<Uint8Array> => {
      const have = local();
      if (offset + length <= have || !online()) return deviceStore.readVideo(account, id, offset, length);
      try {
        const res = await fetch(`/api/offline/jobs/${id}/file`, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, cache: "no-store" });
        if (res.status === 206) return new Uint8Array(await res.arrayBuffer());
      } catch {
        /* réseau perdu en route : ce que l'appareil a */
      }
      return deviceStore.readVideo(account, id, offset, length);
    },
  };
}

export function OfflinePlayerHost({ session, mode }: { session: PlaybackSession; mode: "full" | "mini" }) {
  const t = useT();
  const toast = useToast();
  const playback = usePlayback();
  const id = session.offline!.id;
  // Suivi en direct : la barre montre ce qui arrive pendant la lecture d'un téléchargement en cours.
  const download = useOfflineDownloads().find((d) => d.id === id) ?? offlineDownloadById(id);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [switchTo, setSwitchTo] = useState<number | null>(null);
  const isMini = mode === "mini";

  // Le moteur, ouvert une fois pour cette séance.
  useEffect(() => {
    const video = videoRef.current;
    const account = offlineAccount();
    const meta = offlineDownloadById(id);
    if (!video || !account || !meta) {
      setError(t("player.downloads.playFailed", { error: "téléchargement introuvable sur cet appareil" }));
      return;
    }
    const engine = new OfflineEngine(
      video,
      offlineSourceFor(account, id),
      meta.runtimeSeconds || null,
      { onError: (message) => setError(t("player.downloads.playFailed", { error: message })) }
    );
    let cancelled = false;
    const start = session.resumeAt ?? meta.positionSeconds ?? 0;
    engine
      .open(start)
      .then(() => {
        if (cancelled) return;
        setReady(true);
        if (!session.startPaused) void video.play().catch(() => {});
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(t("player.downloads.playFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
      });
    return () => {
      cancelled = true;
      if (video.currentTime > 0) saveOfflinePosition(id, video.currentTime);
      engine.close();
    };
    // Une seule ouverture par séance : la clé de l'hôte change avec elle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // La position gardée avec le téléchargement, toutes les dix secondes et à la pause.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let last = 0;
    const onTime = () => {
      if (Math.abs(video.currentTime - last) >= 10) {
        last = video.currentTime;
        saveOfflinePosition(id, video.currentTime);
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      saveOfflinePosition(id, video.currentTime);
    };
    // Vu jusqu'au bout : noté avec le téléchargement (le téléchargement automatique en efface
    // l'épisode quand le suivant est là — `markOfflineWatched`).
    const onEnded = () => void markOfflineWatched(id);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
    };
  }, [id]);

  const handleClose = useCallback(() => {
    if (closing) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setClosing(true);
    const openId = session.openId;
    setTimeout(() => playback.close(openId), 200);
  }, [closing, playback, session.openId]);
  usePlayerBackClose(handleClose);

  const handleExpand = useCallback(() => playback.expand(), [playback]);
  const { pos, size, isDragging, handlers } = useMiniPlayerDrag(isMini, handleExpand);
  usePlayerFocus(containerRef, !isMini);

  // Une autre piste que celle du fichier : la lecture en ligne, ou rien sans réseau (Louis).
  const changeAudio = (index: number) => {
    if (index === download?.audioIndex) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      toast.error(t("player.downloads.audioOffline"));
      return;
    }
    setSwitchTo(index);
  };
  const goOnline = () => {
    if (switchTo === null || !download) return;
    const at = videoRef.current?.currentTime ?? 0;
    saveOfflinePosition(id, at);
    playback.play({ itemId: download.itemId, title: download.title, resumeAt: at, initialAudioStreamIndex: switchTo });
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
        transition: isDragging ? "none" : "all 300ms cubic-bezier(0.32, 0.72, 0, 1)",
        touchAction: "none",
      }
    : {
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        zIndex: 80,
        background: "black",
        transition: "opacity 220ms ease-out",
        opacity: closing ? 0 : 1,
      };

  return createPortal(
    <div ref={containerRef} style={style} className={isMini ? "animate-fade-in-scale" : "app-viewport"} {...(isMini ? handlers : {})}>
      <video
        ref={videoRef}
        playsInline
        className={`h-full w-full ${isMini ? "object-cover" : "object-contain"} transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-0"}`}
      />
      {error && !isMini && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
          <AlertTriangle className="text-amber-400" size={32} />
          <p className="max-w-lg text-sm leading-6 text-slate-300">{error}</p>
          <button type="button" onClick={handleClose} className="btn-primary">
            {t("common.close")}
          </button>
        </div>
      )}
      {isMini ? (
        <MiniPlayerChrome
          title={session.title}
          playing={playing}
          onTogglePlay={() => {
            const video = videoRef.current;
            if (!video) return;
            if (video.paused) void video.play();
            else video.pause();
          }}
          onClose={handleClose}
        />
      ) : (
        ready &&
        !error && (
          <div className="absolute inset-0 z-10">
            <PlayerControls
              lab
              downloadedFraction={download ? (download.state === "done" ? 1 : download.bytes / Math.max(1, download.expectedBytes)) : undefined}
              videoRef={videoRef}
              containerRef={containerRef}
              itemId={session.itemId}
              title={session.title}
              onClose={handleClose}
              onMinimize={() => playback.minimize()}
              onTogglePlaybackInfo={() => {}}
              audioTracks={(download?.audioTracks ?? []).map((a) => ({ id: a.index, label: a.label }))}
              currentAudioId={download?.audioIndex ?? null}
              onChangeAudio={changeAudio}
              subtitleTracks={[]}
              currentSubtitleId={null}
              onChangeSubtitle={() => {}}
              hidden={false}
              loading={false}
              introSkip={null}
              creditsStart={null}
              nextEpisode={null}
              onAdvance={() => {}}
            />
          </div>
        )
      )}
      <ActionSheet
        open={switchTo !== null}
        onClose={() => setSwitchTo(null)}
        role="alertdialog"
        centerOnWide
        title={session.title}
        subtitle={t("player.downloads.switchOnline")}
        actions={[
          { label: t("player.downloads.switchOnlineConfirm"), onClick: goOnline, noAutoFocus: true },
          { label: t("common.cancel"), onClick: () => {} },
        ]}
      />
    </div>,
    document.body
  );
}
