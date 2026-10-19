"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SubtitleLayer } from "@/components/player/SubtitleLayer";
import { subtitleStyleStore, type ChromeEdges } from "@/lib/subtitleStyle";
import { useOfflineSubtitles } from "./useOfflineSubtitles";
import { useOfflineTrickplay } from "./useOfflineTrickplay";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { usePlayback, type PlaybackSession } from "@/components/PlaybackProvider";
import { PlayerControls } from "@/components/PlayerControls";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { PlaybackIntro, type IntroPhase } from "@/components/player/PlaybackIntro";
import { finishIntro, introAllowedFor, introCaption, introFinished, introKey, startIntroClock } from "@/lib/playbackIntro";
import { useIntroPlaybackStarted } from "@/lib/introEnd";
import { useLocale, useT } from "@/components/TranslationProvider";
import { PlaybackInfoPanel, type PlaybackPanelData } from "@/components/PlaybackInfoPanel";
import { formatFileSize } from "@/lib/format";
import type { OfflineDownload } from "@/lib/offline/downloads";
import { useToast } from "@/components/Toast";
import { usePlayerBackClose } from "@/lib/playerHistory";
import { usePlayerFocus } from "@/lib/usePlayerFocus";
import { deviceStore } from "@/lib/offline/deviceStore";
import { markOfflineWatched, offlineAccount, offlineDownloadById, saveOfflinePosition, useOfflineDownloads } from "@/lib/offline/downloads";
import { OfflineEngine } from "@/lib/offline/offlineEngine";
import { reportClientError } from "@/lib/reportClientError";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { PLAYBACK_CLIENTS } from "@/lib/playbackClients";
import { refreshAfterPlayback } from "@/lib/swr";
import { refreshResumeThresholds } from "@/lib/offline/resumeRules";
import { autoNextDue, downloadNextEpisode, offlineNextTarget, useOnline, watchedThrough } from "@/lib/offline/episodeDownloads";
import { offlinePlayable, useTrackLabeller } from "@/components/offline/OfflineDownloadControl";
import { useNextEpisodeFromCache } from "@/lib/useNextEpisodeFromCache";

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
function offlineSourceFor(account: string, id: string, counts: { device: number; server: number }) {
  const local = () => offlineDownloadById(id)?.bytes ?? 0;
  const online = () => typeof navigator === "undefined" || navigator.onLine !== false;
  return {
    available: () => {
      const d = offlineDownloadById(id);
      if (!d) return 0;
      return d.state === "done" ? d.bytes : Math.max(d.bytes, online() ? d.serverBytes : 0);
    },
    complete: () => offlineDownloadById(id)?.state === "done",
    localAvailable: local,
    // Pendant le téléchargement, avec du réseau : l'index d'un coup, lu sur le disque du serveur.
    // Fini, ou sans réseau : sur l'appareil.
    scan: async (from: number) => {
      const d = offlineDownloadById(id);
      if (!d || d.state === "done" || !online()) return null;
      const res = await fetch(`/api/offline/jobs/${id}/index?from=${from}`, { cache: "no-store" });
      if (!res.ok) return null;
      const body = (await res.json()) as { fragments: { offset: number; size: number; time: number }[]; next: number; generation: number };
      return body.generation === d.generation ? { fragments: body.fragments, next: body.next } : null;
    },
    read: async (offset: number, length: number): Promise<Uint8Array> => {
      const have = local();
      const fromDevice = async () => {
        const bytes = await deviceStore.readVideo(account, id, offset, length);
        counts.device += bytes.byteLength;
        return bytes;
      };
      if (offset + length <= have || !online()) return fromDevice();
      try {
        const res = await fetch(`/api/offline/jobs/${id}/file`, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, cache: "no-store" });
        if (res.status === 206) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          counts.server += bytes.byteLength;
          return bytes;
        }
      } catch {
        /* réseau perdu en route : ce que l'appareil a */
      }
      return fromDevice();
    },
  };
}

export function OfflinePlayerHost({ session, mode }: { session: PlaybackSession; mode: "full" | "mini" }) {
  const t = useT();
  const { locale } = useLocale();
  const toast = useToast();
  const playback = usePlayback();
  const id = session.offline!.id;
  // Suivi en direct : la barre montre ce qui arrive pendant la lecture d'un téléchargement en cours.
  const downloads = useOfflineDownloads();
  // Ce que le téléchargement était à l'ouverture : un épisode vu jusqu'au bout peut quitter
  // l'appareil pendant que le lecteur est encore là (`markOfflineWatched`), et « Épisode suivant »
  // doit encore savoir où aller.
  const [opened] = useState(() => offlineDownloadById(id));
  const download = downloads.find((d) => d.id === id) ?? offlineDownloadById(id) ?? opened;
  // Vu à 95 % (ou fini) : noté à la fermeture plutôt qu'à l'instant, pour ne pas effacer le fichier
  // pendant le générique qu'on regarde encore. `marked` : déjà fait par `ended`.
  const watchedRef = useRef({ reached: false, marked: false });
  const labeller = useTrackLabeller();
  const online = useOnline();
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const subs = useOfflineSubtitles(download ?? null, videoRef);
  const trickplay = useOfflineTrickplay(download ?? null);
  const subtitleStyle = useSyncExternalStore(subtitleStyleStore.subscribe, subtitleStyleStore.snapshot, subtitleStyleStore.serverSnapshot);
  const [chromeEdges, setChromeEdges] = useState<ChromeEdges | null>(null);
  const [panel, setPanel] = useState<PlaybackPanelData | null>(null);
  const countsRef = useRef({ device: 0, server: 0 });
  const engineRef = useRef<OfflineEngine | null>(null);
  // Le panneau ouvert se relit chaque seconde (octets lus, tampon).
  useEffect(() => {
    if (!showInfo) return;
    const read = () => {
      const d = offlineDownloadById(id);
      setPanel(d ? offlinePanelData(d, engineRef.current, videoRef.current, countsRef.current, locale) : null);
    };
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, [showInfo, id, locale]);
  const isMini = mode === "mini";

  // Le moteur, ouvert une fois pour cette séance.
  useEffect(() => {
    const video = videoRef.current;
    const watched = watchedRef.current;
    const account = offlineAccount();
    const meta = offlineDownloadById(id);
    if (!video || !account || !meta) {
      setError(t("player.downloads.playFailed", { error: "téléchargement introuvable sur cet appareil" }));
      return;
    }
    const engine = new OfflineEngine(
      video,
      offlineSourceFor(account, id, countsRef.current),
      meta.runtimeSeconds || null,
      {
        onError: (message) => setError(t("player.downloads.playFailed", { error: message })),
        onBeyond: () => toast.error(t("player.downloads.notReadyYet")),
      }
    );
    engineRef.current = engine;
    let cancelled = false;
    // Un échec dit où il s'est produit, à l'écran et au journal (`server.log`, scope client) : les
    // premiers essais sur iPhone et sur Chrome se sont arrêtés sur un écran noir sans rien dire.
    const fail = (message: string) => {
      if (cancelled) return;
      setError(t("player.downloads.playFailed", { error: message }));
      reportClientError(new Error(`lecture hors ligne : ${message}`), "component:lecteur-hors-ligne", {
        stage: engine.stage,
        mime: engine.describe().mime ?? meta.codec,
        state: offlineDownloadById(id)?.state ?? "?",
        bytes: String(offlineDownloadById(id)?.bytes ?? 0),
      });
    };
    const onMediaError = () => {
      const err = video.error;
      if (err) fail(`le navigateur n'a pas pu décoder la vidéo (${err.code}${err.message ? ` : ${err.message}` : ""})`);
    };
    video.addEventListener("error", onMediaError);
    // Ouvert mais sans image au bout de quinze secondes : ce n'est pas une attente, c'est une panne.
    let pictureTimer: ReturnType<typeof setTimeout> | null = null;
    const start = session.resumeAt ?? meta.positionSeconds ?? 0;
    engine
      .open(start)
      .then(() => {
        if (cancelled) return;
        setReady(true);
        if (!session.startPaused)
          void video.play().catch(() => {
            // Lecture automatique refusée : l'ouverture s'efface sur l'image arrêtée (`playbackRefused`).
            startingRef.current = false;
          });
        else startingRef.current = false;
        pictureTimer = setTimeout(() => {
          if (video.readyState < 2 && !video.error) fail(`aucune image après 15 s (étape « ${engine.stage} »)`);
        }, 15_000);
      })
      .catch((cause: unknown) => fail(cause instanceof Error ? cause.message : String(cause)));
    // Ni ouvert ni en erreur au bout de vingt secondes : l'ouverture elle-même est bloquée.
    const openTimer = setTimeout(() => {
      if (!cancelled && engine.stage !== "premier fragment") fail(`ouverture bloquée à l'étape « ${engine.stage} »`);
    }, 20_000);
    return () => {
      cancelled = true;
      clearTimeout(openTimer);
      if (pictureTimer) clearTimeout(pictureTimer);
      video.removeEventListener("error", onMediaError);
      if (!watched.marked && video.currentTime > 0) saveOfflinePosition(id, video.currentTime);
      // Vu au-delà de 95 % : noté vu en partant — le téléchargement automatique l'efface si la suite
      // est déjà là (`markOfflineWatched`).
      if (watched.reached && !watched.marked) void markOfflineWatched(id);
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
    let askedNext = false;
    const onTime = () => {
      if (Math.abs(video.currentTime - last) >= 10) {
        last = video.currentTime;
        saveOfflinePosition(id, video.currentTime);
      }
      const d = offlineDownloadById(id);
      const runtime = d?.runtimeSeconds || video.duration || 0;
      if (watchedThrough(video.currentTime, runtime)) watchedRef.current.reached = true;
      // Le téléchargement automatique (§109) : à mi-épisode, le suivant se demande — une fois par
      // séance, sans bruit hors ligne ; un échec va au journal, pas à l'écran.
      if (!askedNext && d?.episode?.autoNext && autoNextDue(video.currentTime, runtime)) {
        askedNext = true;
        void downloadNextEpisode(d, labeller).catch((error: unknown) => reportClientError(error, "component:hors-ligne", { download: id, stage: "épisode suivant" }));
      }
    };
    const onPlay = () => {
      startingRef.current = false;
      setPlaying(true);
    };
    const onPause = () => {
      setPlaying(false);
      saveOfflinePosition(id, video.currentTime);
    };
    // Vu jusqu'au bout : noté avec le téléchargement (le téléchargement automatique en efface
    // l'épisode quand le suivant est là — `markOfflineWatched`).
    const onEnded = () => {
      watchedRef.current.marked = true;
      void markOfflineWatched(id);
    };
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
  }, [id, labeller]);

  // La lecture rapportée à Jellyfin comme par le lecteur en ligne, sous le même nom (« engine ») :
  // annonce, battements, arrêt — Jellyfin applique lui-même ses seuils de reprise, et la position est
  // la même des deux côtés, à la seconde (Louis, 19/10/2026). Sans réseau, chaque rapport manqué garde
  // la position sur l'appareil et part au retour du réseau (`unsentPosition.ts`).
  const positionRef = useRef(session.resumeAt ?? 0);
  const getPosition = useCallback(() => positionRef.current, []);
  const getPaused = useCallback(() => videoRef.current?.paused ?? true, []);
  const itemId = session.itemId;
  const reporting = useMemo(
    () => (ready ? { itemId, playSessionId: `cine-offline-${id}`, mediaSourceId: itemId, playMethod: "DirectPlay" as const, client: PLAYBACK_CLIENTS.engine, announce: true } : null),
    [ready, itemId, id]
  );
  const { stop: stopReporting } = usePlaybackSession(getPosition, reporting, getPaused);
  useEffect(() => {
    void refreshResumeThresholds();
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      if (!video.seeking) positionRef.current = video.currentTime;
    };
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, []);

  const handleClose = useCallback(() => {
    if (closing) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setClosing(true);
    const reported = stopReporting();
    const openId = session.openId;
    setTimeout(() => playback.close(openId), 200);
    // La fiche et « Reprendre » se relisent une fois l'arrêt pris par Jellyfin, comme après le lecteur en ligne.
    void refreshAfterPlayback(reported, itemId);
  }, [closing, playback, session.openId, stopReporting, itemId]);
  usePlayerBackClose(handleClose);

  const handleExpand = useCallback(() => playback.expand(), [playback]);

  /**
   * « Épisode suivant » d'un épisode téléchargé (§109) : le fichier sur l'appareil s'il est lisible —
   * une nouvelle séance hors ligne —, sinon la lecture en ligne s'il y a du réseau, sinon pas de
   * bouton. La suite en ligne garde son propre « Épisode suivant » par la liste que la fiche de la
   * série a laissée dans la réserve de SWR.
   */
  const nextTarget = offlineNextTarget(download, downloads, online, offlinePlayable);
  const seriesItemId = download?.episode?.seriesItemId;
  const getNextOnline = useNextEpisodeFromCache(seriesItemId ? `/api/cinema/series/${seriesItemId}/episodes` : "");
  const advance = () => {
    if (!nextTarget) return;
    if (nextTarget.offlineId) {
      // Depuis le début, comme `advance` en ligne : c'est la suite qu'on enchaîne.
      playback.play({ itemId: nextTarget.itemId, title: nextTarget.title, resumeAt: 0, offline: { id: nextTarget.offlineId } });
      return;
    }
    playback.play({ itemId: nextTarget.itemId, title: nextTarget.title, resumeAt: 0, ...(seriesItemId ? { getNextEpisode: getNextOnline } : {}) });
  };
  const { pos, size, isDragging, handlers } = useMiniPlayerDrag(isMini, handleExpand);
  usePlayerFocus(containerRef, !isMini);

  // L'ouverture du lecteur en ligne, à l'identique : visuel, logo, ligne de chargement, croix en verre
  // en haut à gauche — plus « Lecture du fichier téléchargé » sous le texte habituel (Louis, 19/10/2026).
  const thisIntro = introKey(session.openId, itemId);
  const [introEligible] = useState(() => introAllowedFor(session) && !introFinished(thisIntro));
  const [introStartedAt] = useState(() => startIntroClock(thisIntro));
  const startingRef = useRef(true);
  const introPlaying = useIntroPlaybackStarted(ready, videoRef, startingRef);
  useEffect(() => {
    if (introPlaying) finishIntro(thisIntro);
  }, [introPlaying, thisIntro]);
  const introPhase: IntroPhase = !introEligible || isMini ? "gone" : introPlaying ? "picture" : error ? "gone" : "waiting";

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
      {introPhase !== "gone" && (
        <PlaybackIntro
          phase={introPhase}
          startedAt={introStartedAt}
          clockKey={thisIntro}
          art={session.introArt ?? null}
          imageShown={ready}
          fallbackName={session.title}
          caption={[...introCaption({ ...session.introArt, resumeSeconds: session.resumeAt ?? null }, t), t("player.downloads.introCaption")]}
          onClose={handleClose}
          closeLabel={t("common.close")}
          className="absolute inset-0 z-[15]"
        />
      )}
      {/* Sans ouverture (déjà jouée, mouvement réduit) : une attente qui se voit, et toujours une sortie
          — le premier essai sur iPhone n'avait que le retour du navigateur. */}
      {introPhase === "gone" && !ready && !error && !isMini && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-5 bg-black">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" aria-hidden />
          <button type="button" onClick={handleClose} className="btn btn-ghost px-4 py-2">
            {t("common.close")}
          </button>
        </div>
      )}
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
              downloadedFraction={download ? (download.state === "done" ? 1 : download.bytes / Math.max(1, download.expectedBytes)) : undefined}
              offlineTrickplay={trickplay}
              videoRef={videoRef}
              containerRef={containerRef}
              itemId={session.itemId}
              title={session.title}
              onClose={handleClose}
              onMinimize={() => playback.minimize()}
              onTogglePlaybackInfo={() => setShowInfo((open) => !open)}
              // Une seule piste son dans un téléchargement : pas de menu (Louis, 19/10/2026 — un bouton
              // qui ne fait rien n'a pas sa place).
              audioTracks={[]}
              currentAudioId={null}
              onChangeAudio={() => {}}
              subtitleTracks={subs.tracks}
              currentSubtitleId={subs.current}
              onChangeSubtitle={subs.choose}
              onChromeEdges={setChromeEdges}
              hidden={false}
              loading={false}
              introSkip={null}
              creditsStart={null}
              nextEpisode={nextTarget ? { itemId: nextTarget.itemId, title: nextTarget.title } : null}
              onAdvance={advance}
            />
          </div>
        )
      )}
      {!isMini && <SubtitleLayer primary={subs.text} style={subtitleStyle} chromeEdges={chromeEdges} />}
      <PlaybackInfoPanel open={showInfo && !isMini} onClose={() => setShowInfo(false)} data={panel} />
    </div>,
    document.body
  );
}

/**
 * Le panneau technique du lecteur hors ligne : d'où viennent les octets (l'appareil, ou la copie du
 * serveur pendant un téléchargement en cours), ce que contient le fichier, ce que MediaSource a reçu.
 * Les intitulés en français, comme ceux des autres lecteurs : c'est une surface de diagnostic.
 */
function offlinePanelData(
  d: OfflineDownload,
  engine: OfflineEngine | null,
  video: HTMLVideoElement | null,
  counts: { device: number; server: number },
  locale: string
): PlaybackPanelData {
  const size = (n: number) => formatFileSize(n, locale);
  const described = engine?.describe();
  const now = video?.currentTime ?? 0;
  let ahead = 0;
  if (video) for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= now + 0.5 && video.buffered.end(i) >= now) ahead = video.buffered.end(i) - now;
  const done = d.state === "done";
  return {
    headline: done
      ? { name: "Hors ligne", detail: "fichier téléchargé, lu depuis l'appareil", tone: "good" }
      : { name: "Hors ligne — téléchargement en cours", detail: "l'appareil d'abord, la copie du serveur pour la suite", tone: "neutral" },
    notes: [],
    sections: [
      {
        title: "Fichier",
        rows: [
          { label: "Chemin", value: "téléchargement (MP4 fragmenté → MediaSource)" },
          { label: "Qualité", value: d.quality === "high" ? "Haute · 1080p · 4 Mb/s" : "Standard · 720p · 2 Mb/s" },
          { label: "Codec", value: described?.mime ?? d.codec },
          { label: "Piste son", value: d.audioLabel },
          { label: "Sur l'appareil", value: done ? size(d.bytes) : `${size(d.bytes)} / ${size(d.expectedBytes)}` },
          { label: "Préparé sur le serveur", value: d.serverDone ? "oui" : size(d.serverBytes) },
        ],
      },
      {
        title: "Lecture",
        rows: [
          { label: "Lu depuis l'appareil", value: size(counts.device) },
          { label: "Lu depuis le serveur", value: size(counts.server) },
          { label: "Fragments indexés", value: described ? `${described.fragments}${described.lastFragmentAt !== null ? ` (jusqu'à ${Math.round(described.lastFragmentAt)} s)` : ""}` : "—" },
          { label: "Image", value: video?.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "—" },
          { label: "Tampon devant", value: `${ahead.toFixed(1)} s` },
          { label: "Réseau", value: typeof navigator !== "undefined" && navigator.onLine === false ? "hors ligne" : "en ligne" },
        ],
      },
    ],
    report: null,
  };
}
