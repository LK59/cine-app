"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play, PictureInPicture2, Smartphone, Volume2, VolumeX, X, Cast } from "lucide-react";
import { usePlayback, type PlaybackSession } from "@/components/PlaybackProvider";
import { useT, useLocale } from "@/components/TranslationProvider";
import { formatTime } from "@/lib/playerClock";
import { usePlaybackSession, stopOrphanSession } from "@/lib/usePlaybackSession";
import { PLAYBACK_CLIENTS } from "@/lib/playbackClients";
import { advanceTo, closePlayerSession } from "@/components/player/playerClose";
import { reportPlayback } from "@/lib/reportPlayback";
import { touchHintHeaders } from "@/lib/deviceLabel";
import { labelAudioTracks, labelSubtitleTracks } from "@/lib/trackLabel";
import { SessionTally, WatchedClock, newPlayerSessionId } from "@/lib/playerSessionTally";
import { useWatchedClockRun } from "@/components/player/session/useWatchedClockRun";
import { noteWatching } from "@/lib/resumeRewind";
import type { StableTakeover } from "@/lib/useStableFallback";
import {
  castEndedFields,
  castEstablishedFields,
  serverFailureFields,
  serverStartFields,
  serverStopFields,
  type ServerPlayerContext,
  type ServerStartWhy,
  type ServerStopWhy,
} from "@/lib/serverPlayerLog";
import {
  chromecastGlobals,
  currentChromecastSession,
  endChromecastSession,
  errorCode,
  type CastSession,
  type RemotePlayerController,
  type RemotePlayerState,
} from "@/lib/chromecast/framework";
import { chromecastErrorReason, chromecastMediaSpec, idleOutcome, isSideLoadable, subtitleTrackId, toLoadRequest, type ChromecastSubtitleFacts } from "@/lib/chromecast/media";
import { usePlayerBackClose } from "@/lib/playerHistory";

/**
 * Le plafond de débit demandé à Jellyfin pour un Chromecast.
 *
 * Pas celui du téléphone (`pickMaxBitrate`, qui suit son réseau) : c'est le téléviseur qui va
 * chercher le flux, sur la connexion de la maison. 20 Mb/s couvre un 1080p H.264 transcodé — le
 * plafond du profil (`buildChromecastProfile`) — avec de la marge, sans réclamer un 4K qu'il n'a
 * pas annoncé.
 */
export const CHROMECAST_MAX_BITRATE = 20_000_000;

interface Track {
  id: number;
  label: string;
}

interface RemoteView {
  currentTime: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  /** Le récepteur charge ou rattrape (`BUFFERING`, ou pas encore de média). */
  waiting: boolean;
}

const NO_REMOTE: RemoteView = { currentTime: 0, duration: 0, paused: false, volume: 1, muted: false, waiting: true };

type Phase = "negotiating" | "loading" | "playing" | "error";

interface StartOptions {
  resumeAt: number;
  audioStreamIndex?: number;
  /** Un sous-titre en images, incrusté par le serveur ; un sous-titre texte n'en passe pas par là. */
  burnedSubtitle?: number;
  /** Le sous-titre texte à allumer dès le chargement. */
  textSubtitle?: number | null;
  why: ServerStartWhy;
}

/**
 * La diffusion vers un Chromecast, pilotée depuis la page — DECISIONS.md §64.
 *
 * Ce n'est pas un lecteur : le récepteur lit lui-même le flux que Jellyfin lui prépare, par
 * l'adresse signée du serveur (`castUrl`, laissez-passer de six heures). La page en est la
 * télécommande : lecture/pause, saut, volume, pistes, et « Reprendre sur cet appareil ».
 *
 * Il prend le relais du lecteur natif exactement comme le lecteur serveur pour AirPlay — `cast:
 * true`, donc un choix et non un échec, donc un retour possible (`onCastEnded` → `stepBack`) — et
 * écrit les mêmes lignes au journal, marquées `target: "chromecast"`. Ce qui le distingue :
 *
 *   - **La reprise** est rapportée à Jellyfin depuis la page avec le temps du récepteur, par le
 *     même `usePlaybackSession` que les autres lecteurs.
 *   - **Une piste son** relance le flux à la même position (nouvelle négociation, comme AirPlay) ;
 *     **un sous-titre texte** s'allume sur le récepteur sans relance ; un sous-titre en images est
 *     incrusté par le serveur, donc relance.
 *   - **La fin du film** enchaîne l'épisode suivant si la page est là, sinon ferme.
 *   - **Une session perdue** (téléviseur éteint, diffusion arrêtée depuis un autre appareil) rend
 *     la main au lecteur natif, en pause, à la dernière position connue — la règle d'AirPlay.
 */
export function ChromecastPlayer({
  session,
  mode,
  takeover,
  continuesSession,
  onCastEnded,
}: {
  session: PlaybackSession;
  mode: "full" | "mini";
  takeover: StableTakeover | null;
  continuesSession?: string;
  onCastEnded: (resumeAt: number, paused?: boolean) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const playback = usePlayback();
  const { itemId, bench } = session;
  const nextEpisode = session.getNextEpisode?.(itemId) ?? null;

  const [phase, setPhase] = useState<Phase>("negotiating");
  /** Pourquoi le téléviseur ne lit pas, en mots pour le journal — l'écran, lui, dit une phrase traduite. */
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteView>(NO_REMOTE);
  const [device, setDevice] = useState<string | null>(() => deviceOf(currentChromecastSession()));
  const [serverTitle, setServerTitle] = useState<string | null>(null);
  const title = serverTitle ?? session.title;
  const [audioTracks, setAudioTracks] = useState<Track[]>([]);
  const [currentAudio, setCurrentAudio] = useState<number | null>(null);
  const [subtitles, setSubtitles] = useState<ChromecastSubtitleFacts[]>([]);
  const [currentSubtitle, setCurrentSubtitle] = useState<number | null>(null);
  const [playSession, setPlaySession] = useState<{
    itemId: string;
    playSessionId: string;
    mediaSourceId: string;
    playMethod?: "DirectPlay" | "DirectStream" | "Transcode";
  } | null>(null);

  // La position, qui n'avance qu'avec le récepteur : semée au point de reprise, pour qu'un arrêt
  // pendant le chargement ne rapporte pas 0:00 — la même règle que le lecteur serveur.
  const lastKnownTime = useRef(takeover?.resumeAt ?? session.resumeAt ?? 0);
  const pausedRef = useRef(false);
  const generation = useRef(0);
  /** Fermé par la croix ou la fin : plus rien à rapporter ni à rendre. */
  const closedRef = useRef(false);
  /** La main est rendue au lecteur natif : la fin de session qui suit n'est pas un incident. */
  const handedBackRef = useRef(false);
  /** Un chargement est en cours : l'arrêt de l'ancien média qu'il provoque n'est pas une fin. */
  const loadingRef = useRef(false);
  /** Une image a joué sur le récepteur dans cette séance — la ligne `cast` part une fois. */
  const establishedRef = useRef(false);
  const currentAudioRef = useRef<number | null>(null);
  const currentSubtitleRef = useRef<number | null>(null);
  const subtitlesRef = useRef<ChromecastSubtitleFacts[]>([]);

  // Le journal : une séance par titre, la même que celle du lecteur natif qui a passé la main.
  const agent = typeof navigator === "undefined" ? undefined : navigator.userAgent;
  const [firstSession] = useState(() => continuesSession ?? newPlayerSessionId());
  const logSession = useRef({ itemId, id: firstSession });
  const logContext = useRef<ServerPlayerContext>({ itemId, title, cast: true, target: "chromecast", bench, session: firstSession, agent });
  const tallyRef = useRef(new SessionTally());
  const restartsRef = useRef<Partial<Record<ServerStartWhy, number>>>({});
  const subtitleSwitchesRef = useRef(0);
  const [watched] = useState(() => new WatchedClock());
  useEffect(() => {
    if (logSession.current.itemId !== itemId) {
      logSession.current = { itemId, id: newPlayerSessionId() };
      tallyRef.current = new SessionTally();
      restartsRef.current = {};
      subtitleSwitchesRef.current = 0;
      establishedRef.current = false;
    }
    logContext.current = { itemId, title, cast: true, target: "chromecast", bench, session: logSession.current.id, agent };
  }, [itemId, title, bench, agent]);

  const playing = phase === "playing" && !remote.paused && !remote.waiting;
  useWatchedClockRun(watched, playing);

  const { stop: stopPlaybackNow } = usePlaybackSession(
    useCallback(() => lastKnownTime.current, []),
    // Rien pour un banc d'essai, comme les deux autres lecteurs.
    playSession && !bench ? { ...playSession, client: PLAYBACK_CLIENTS.stable } : null,
    useCallback(() => pausedRef.current, [])
  );

  const stopFields = useCallback(
    (why: ServerStopWhy, ended = false) =>
      serverStopFields(logContext.current, why, lastKnownTime.current, watched.take(Date.now()), {
        duration: remote.duration || null,
        ended,
        tally: tallyRef.current.summary(Date.now()),
        subtitleSwitches: subtitleSwitchesRef.current,
        restarts: restartsRef.current,
        error,
      }),
    [watched, remote.duration, error]
  );

  /** Rend la main au lecteur natif, à la dernière position connue. */
  const handBack = useCallback(
    (source: string, paused: boolean) => {
      if (handedBackRef.current || closedRef.current) return;
      handedBackRef.current = true;
      generation.current++;
      const at = lastKnownTime.current;
      reportPlayback("fallback", castEndedFields(logContext.current, source, at, watched.take(Date.now())));
      if (!bench) noteWatching(itemId);
      onCastEnded(at, paused);
    },
    [onCastEnded, watched, itemId, bench]
  );

  /**
   * Négocie le flux pour le Chromecast puis le charge sur le récepteur.
   *
   * Chaque appel prend un numéro ; un appel dépassé (une piste choisie pendant qu'une autre se
   * négociait) abandonne, et referme chez Jellyfin la séance qu'il venait d'ouvrir — comme le
   * lecteur serveur (`stopOrphanSession`).
   */
  const start = useCallback(
    async (opts: StartOptions) => {
      const mine = ++generation.current;
      setPhase("negotiating");
      setError(null);
      if (opts.why !== "open" && opts.why !== "handover") restartsRef.current[opts.why] = (restartsRef.current[opts.why] ?? 0) + 1;
      let data: Record<string, unknown>;
      try {
        const res = await fetch("/api/jellyfin/playback/start", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...touchHintHeaders() },
          body: JSON.stringify({
            itemId,
            maxBitrate: CHROMECAST_MAX_BITRATE,
            ...(opts.audioStreamIndex !== undefined ? { audioStreamIndex: opts.audioStreamIndex } : {}),
            ...(opts.burnedSubtitle !== undefined ? { subtitleStreamIndex: opts.burnedSubtitle } : {}),
            ...(opts.resumeAt > 0 ? { startTicks: Math.floor(opts.resumeAt * 10_000_000) } : {}),
            codecSupport: { video: {}, audio: {} },
            nativeHls: true,
            castTarget: "chromecast",
            ...(bench ? { bench: true } : {}),
          }),
        });
        data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
      } catch (e) {
        if (mine !== generation.current) return;
        const reason = e instanceof Error ? e.message : "négociation impossible";
        reportPlayback("error", serverFailureFields(logContext.current, `chromecast : négociation refusée — ${reason}`));
        setError(`négociation refusée — ${reason}`);
        setPhase("error");
        return;
      }
      const negotiated = {
        itemId,
        playSessionId: String(data.playSessionId ?? ""),
        mediaSourceId: String(data.mediaSourceId ?? ""),
        playMethod: ((data.playbackInfo as { playMethod?: string } | undefined)?.playMethod ?? "Transcode") as "DirectPlay" | "DirectStream" | "Transcode",
      };
      if (mine !== generation.current || closedRef.current || handedBackRef.current) {
        void stopOrphanSession({ ...negotiated, client: PLAYBACK_CLIENTS.stable }, opts.resumeAt);
        return;
      }
      const castUrl = typeof data.castUrl === "string" ? data.castUrl : null;
      const isDirectPlay = data.isDirectPlay === true;
      if (typeof data.title === "string") setServerTitle(data.title);

      const audioFacts = (Array.isArray(data.audioTracks) ? data.audioTracks : []) as {
        index: number;
        language: string | null;
        title: string | null;
        codec: string | null;
        channels: number | null;
        profile: string | null;
        isDefault: boolean;
      }[];
      setAudioTracks(
        labelAudioTracks(
          audioFacts.map((a) => ({
            number: a.index,
            language: a.language,
            name: a.title,
            isDefault: a.isDefault,
            isForced: false,
            codecId: a.codec,
            channels: a.channels,
            profile: a.profile,
          })),
          {
            locale,
            originalLanguage: typeof data.originalLanguage === "string" ? data.originalLanguage : null,
            canaux: (n: number) => t("player.trackLabel.channels", { n }),
            piste: (n: number) => t("player.trackLabel.track", { n }),
          }
        ).map((e) => ({ id: e.number, label: e.label }))
      );
      const audio = opts.audioStreamIndex ?? audioFacts.find((a) => a.isDefault)?.index ?? null;
      currentAudioRef.current = audio;
      setCurrentAudio(audio);

      const subtitleFacts = (Array.isArray(data.subtitleTracks) ? data.subtitleTracks : []) as {
        index: number;
        url: string;
        language: string | null;
        title: string | null;
        isDefault: boolean;
        isForced?: boolean;
        isHearingImpaired?: boolean;
        isExternal?: boolean;
        isText?: boolean | null;
      }[];
      const labels = new Map(
        labelSubtitleTracks(
          subtitleFacts.map((st) => ({
            number: st.index,
            language: st.language ?? null,
            name: st.title ?? null,
            isDefault: st.isDefault,
            isForced: st.isForced ?? false,
            isHearingImpaired: st.isHearingImpaired,
            isExternal: st.isExternal,
          })),
          {
            locale,
            forces: t("player.trackLabel.forced"),
            complets: t("player.trackLabel.full"),
            malentendants: t("player.trackLabel.sdh"),
            externe: t("player.trackLabel.external"),
            piste: (n: number) => t("player.trackLabel.track", { n }),
          }
        ).map((e) => [e.number, e.label])
      );
      const facts: ChromecastSubtitleFacts[] = subtitleFacts.map((st) => ({
        index: st.index,
        url: st.url,
        label: labels.get(st.index) ?? String(st.index),
        language: st.language ?? null,
        isText: st.isText ?? null,
      }));
      subtitlesRef.current = facts;
      setSubtitles(facts);
      const subtitle = opts.burnedSubtitle ?? opts.textSubtitle ?? null;
      currentSubtitleRef.current = subtitle;
      setCurrentSubtitle(subtitle);

      setPlaySession(negotiated);
      const cast = currentChromecastSession();
      const globals = chromecastGlobals();
      reportPlayback("start", {
        ...serverStartFields(logContext.current, { directPlay: isDirectPlay, nativeHls: true, resumeAt: opts.resumeAt, audioStreamIndex: opts.audioStreamIndex }, { why: opts.why }),
        hls: isDirectPlay ? "aucun" : "récepteur",
        ...(device ? { device } : {}),
      });
      if (!castUrl || !cast || !globals) {
        // Plus de session : le téléviseur s'est éteint ou la liste a été fermée entre-temps.
        handBack("session perdue avant le chargement", true);
        return;
      }

      setPhase("loading");
      loadingRef.current = true;
      const spec = chromecastMediaSpec({
        castUrl,
        isDirectPlay,
        title: typeof data.title === "string" ? data.title : session.title,
        startSeconds: opts.resumeAt,
        subtitles: facts,
        selectedSubtitle: opts.textSubtitle ?? null,
        origin: window.location.origin,
      });
      try {
        const answer = await cast.loadMedia(toLoadRequest(globals.chromeCast, spec));
        if (typeof answer === "string" && answer) throw answer;
      } catch (e) {
        loadingRef.current = false;
        if (mine !== generation.current) return;
        const code = errorCode(e);
        reportPlayback("error", serverFailureFields(logContext.current, `chromecast : ${chromecastErrorReason(code)}`, { code, ...(device ? { device } : {}) }));
        setError(chromecastErrorReason(code));
        setPhase("error");
        return;
      }
      loadingRef.current = false;
      if (mine !== generation.current) return;
      setPhase("playing");
      if (!establishedRef.current) {
        establishedRef.current = true;
        reportPlayback("cast", { ...castEstablishedFields(logContext.current, opts.resumeAt), ...(device ? { device } : {}) });
      }
    },
    [itemId, bench, locale, t, session.title, device, handBack]
  );

  // L'ouverture, puis chaque épisode suivant (le même composant, un autre `itemId`).
  const takeoverRef = useRef(takeover);
  useEffect(() => {
    const first = takeoverRef.current;
    takeoverRef.current = null;
    void start({
      resumeAt: first?.resumeAt ?? session.resumeAt ?? 0,
      audioStreamIndex: first?.audioStreamIndex ?? session.initialAudioStreamIndex,
      why: first ? "handover" : "open",
    });
    // Une nouvelle séance par épisode, rien d'autre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  // Le récepteur, tel que le kit le décrit : position, pause, volume, état — et sa fin.
  const controllerRef = useRef<{ player: RemotePlayerState; controller: RemotePlayerController } | null>(null);
  const finishRef = useRef<() => void>(() => {});
  useEffect(() => {
    const globals = chromecastGlobals();
    if (!globals) return;
    let player: RemotePlayerState;
    let controller: RemotePlayerController;
    try {
      player = new globals.framework.RemotePlayer();
      controller = new globals.framework.RemotePlayerController(player);
    } catch {
      return;
    }
    controllerRef.current = { player, controller };
    const events = globals.framework.RemotePlayerEventType;
    const read = () => {
      const loaded = player.isMediaLoaded;
      if (loaded && Number.isFinite(player.currentTime) && player.currentTime > 0 && !loadingRef.current) lastKnownTime.current = player.currentTime;
      pausedRef.current = player.isPaused;
      setRemote({
        currentTime: loaded ? player.currentTime : lastKnownTime.current,
        duration: loaded ? player.duration : 0,
        paused: player.isPaused,
        volume: player.volumeLevel,
        muted: player.isMuted,
        waiting: !loaded || player.playerState === "BUFFERING",
      });
      setDevice(deviceOf(currentChromecastSession()) ?? null);
    };
    const onConnected = () => {
      // Le téléviseur s'est éteint, ou la diffusion a été arrêtée depuis Chrome ou un autre
      // appareil : la règle d'AirPlay — le film revient sur la page, en pause.
      if (!player.isConnected) handBack("téléviseur", true);
    };
    const onState = () => {
      read();
      if (player.playerState !== "IDLE" || loadingRef.current) return;
      const outcome = idleOutcome(currentChromecastSession()?.getMediaSession()?.idleReason);
      if (outcome === "finished") finishRef.current();
      else if (outcome === "error") {
        reportPlayback("error", serverFailureFields(logContext.current, "chromecast : le récepteur a interrompu la lecture sur une erreur"));
        setError("le récepteur a interrompu la lecture sur une erreur");
        setPhase("error");
      } else if (outcome === "stopped") handBack("arrêté sur le téléviseur", true);
    };
    controller.addEventListener(events.ANY_CHANGE, read);
    controller.addEventListener(events.IS_CONNECTED_CHANGED, onConnected);
    controller.addEventListener(events.PLAYER_STATE_CHANGED, onState);
    read();
    return () => {
      controller.removeEventListener(events.ANY_CHANGE, read);
      controller.removeEventListener(events.IS_CONNECTED_CHANGED, onConnected);
      controller.removeEventListener(events.PLAYER_STATE_CHANGED, onState);
      controllerRef.current = null;
    };
  }, [handBack]);

  /**
   * Fermer : le bilan, l'arrêt chez Jellyfin, et le téléviseur arrêté — comme la croix d'AirPlay. La
   * suite commune aux quatre hôtes (`closePlayerSession`, DECISIONS.md §114), sans fondu ni plein
   * écran : la page n'est ici qu'une télécommande.
   */
  const close = useCallback(
    (ended = false) => {
      closePlayerSession({
        // Une main rendue au lecteur natif porte déjà la séance : rien à fermer d'ici.
        claim: () => {
          if (closedRef.current || handedBackRef.current) return false;
          closedRef.current = true;
          generation.current++;
          return true;
        },
        leaveFullscreen: false,
        reportStop: () => reportPlayback("stop", stopFields("close", ended)),
        stopReporting: stopPlaybackNow,
        release: () => endChromecastSession(true),
        playback,
        openId: session.openId,
        itemId,
        refresh: true,
      });
    },
    [stopFields, stopPlaybackNow, session.openId, playback, itemId]
  );
  // Retour ferme la télécommande comme sa croix, téléviseur arrêté compris (`playerHistory.ts`).
  const closeByBack = useCallback(() => close(), [close]);
  usePlayerBackClose(closeByBack);

  // La fin du film : l'épisode suivant si la page est là pour l'enchaîner, sinon la fermeture.
  useEffect(() => {
    finishRef.current = () => {
      if (closedRef.current || handedBackRef.current) return;
      lastKnownTime.current = Math.max(lastKnownTime.current, remote.duration || 0);
      // La garde de la séance close est juste au-dessus, avant la position de fin.
      const advanced = advanceTo(nextEpisode, {
        over: false,
        reportStop: () => reportPlayback("stop", stopFields("next", true)),
        stopReporting: stopPlaybackNow,
        playback,
      });
      if (!advanced) close(true);
    };
  }, [nextEpisode, stopFields, stopPlaybackNow, playback, close, remote.duration]);

  // Démonté sans fermeture ni retour (un autre film lancé, la page qui s'en va) : le téléviseur est
  // arrêté et le bilan écrit. Différé d'un tour : le double montage du mode strict de React ne
  // doit pas couper la diffusion qu'il vient d'ouvrir.
  // Un seul objet pour toute la vie de l'instance : chaque montage le lit et l'incrémente, et le tour
  // différé y relit le dernier compte — un remontage entre-temps annule l'arrêt.
  const lifeRef = useRef({ mounts: 0 });
  const stopFieldsRef = useRef(stopFields);
  useEffect(() => {
    stopFieldsRef.current = stopFields;
  }, [stopFields]);
  useEffect(() => {
    const life = lifeRef.current;
    const token = ++life.mounts;
    return () => {
      setTimeout(() => {
        if (life.mounts !== token || closedRef.current || handedBackRef.current) return;
        closedRef.current = true;
        reportPlayback("stop", stopFieldsRef.current("unmount"));
        endChromecastSession(true);
      }, 0);
    };
  }, []);

  const resumeHere = useCallback(() => {
    // Le téléviseur s'arrête : le film reprend ici, là où il en était, et continue.
    const wasClosed = closedRef.current || handedBackRef.current;
    handBack("retour demandé sur l'appareil", false);
    if (!wasClosed) endChromecastSession(true);
  }, [handBack]);

  const togglePlay = () => controllerRef.current?.controller.playOrPause();
  const seekTo = (seconds: number) => {
    const c = controllerRef.current;
    if (!c) return;
    c.player.currentTime = seconds;
    c.controller.seek();
    lastKnownTime.current = seconds;
  };
  const setVolume = (level: number) => {
    const c = controllerRef.current;
    if (!c) return;
    c.player.volumeLevel = level;
    c.controller.setVolumeLevel();
  };
  const toggleMute = () => controllerRef.current?.controller.muteOrUnmute();

  const changeAudio = (id: number) => {
    if (id === currentAudioRef.current) return;
    tallyRef.current.audioSwitched();
    const burned = burnedOf(currentSubtitleRef.current, subtitlesRef.current);
    void start({
      resumeAt: lastKnownTime.current,
      audioStreamIndex: id,
      ...(burned !== null ? { burnedSubtitle: burned } : { textSubtitle: currentSubtitleRef.current }),
      why: "audio",
    });
  };

  const changeSubtitle = (id: number | null) => {
    if (id === currentSubtitleRef.current) return;
    subtitleSwitchesRef.current += 1;
    const wasBurned = burnedOf(currentSubtitleRef.current, subtitlesRef.current) !== null;
    const target = id === null ? null : subtitlesRef.current.find((s) => s.index === id) ?? null;
    const needsStream = wasBurned || (target !== null && !isSideLoadable(target));
    if (!needsStream) {
      // Du texte vers du texte (ou rien) : allumé sur le récepteur, sans relancer le flux.
      currentSubtitleRef.current = id;
      setCurrentSubtitle(id);
      editTracks(currentChromecastSession(), id === null ? [] : [subtitleTrackId(id)]);
      return;
    }
    void start({
      resumeAt: lastKnownTime.current,
      ...(currentAudioRef.current !== null ? { audioStreamIndex: currentAudioRef.current } : {}),
      ...(target && !isSideLoadable(target) ? { burnedSubtitle: target.index } : { textSubtitle: id }),
      why: "audio",
    });
  };

  if (mode === "mini") {
    return (
      <div className="player-liquid fixed bottom-4 right-4 z-[60] flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full p-1 player-pill" data-chromecast="mini">
        <span className="flex min-w-0 items-center gap-2 pl-3 text-sm text-white">
          <Cast size={16} className="shrink-0" />
          <span className="truncate">{title}</span>
        </span>
        <button type="button" onClick={togglePlay} aria-label={remote.paused ? t("player.play") : t("player.pause")} className="player-pill-btn">
          {remote.paused ? <Play size={20} /> : <Pause size={20} />}
        </button>
        <button type="button" onClick={() => playback.expand()} aria-label={t("player.chromecast.expand")} className="player-pill-btn">
          <PictureInPicture2 size={20} />
        </button>
      </div>
    );
  }

  const busy = phase === "negotiating" || phase === "loading" || (phase === "playing" && remote.waiting);
  return (
    <div className="player-liquid fixed inset-0 z-[60] flex flex-col bg-black text-white" data-chromecast="full" role="dialog" aria-label={title}>
      <div className="flex items-center justify-between gap-3 p-4" style={{ paddingTop: "max(1rem, calc(env(safe-area-inset-top) + 1rem))" }}>
        <button type="button" onClick={() => close()} aria-label={t("common.close")} className="player-pill player-pill-btn player-pill-solo">
          <X size={24} />
        </button>
        <button type="button" onClick={() => playback.minimize()} aria-label={t("player.minimize")} className="player-pill player-pill-btn player-pill-solo">
          <PictureInPicture2 size={22} />
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <Cast size={40} className="text-subtle" aria-hidden />
        <div className="flex max-w-xl flex-col gap-2">
          <h2 className="text-balance text-xl font-semibold sm:text-2xl">{title}</h2>
          {/* « Bêta » tant qu'aucune diffusion n'a été vue réussir au journal (DECISIONS §64) : ouvert à
              tous sans essai sur un vrai récepteur, un échec doit se lire comme un essai. */}
          <span className="mx-auto rounded-full border border-white/20 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {t("player.chromecast.beta")}
          </span>
          <p className="text-sm text-muted" data-chromecast-status>
            {phase === "error"
              ? t("player.chromecast.failed")
              : phase === "playing"
                ? t("player.chromecast.playingOn", { device: device ?? t("player.chromecast.tv") })
                : t("player.chromecast.loading")}
          </p>
        </div>

        {phase === "error" ? (
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              className="player-capsule"
              onClick={() => void start({ resumeAt: lastKnownTime.current, ...(currentAudioRef.current !== null ? { audioStreamIndex: currentAudioRef.current } : {}), why: "retry" })}
            >
              {t("player.chromecast.retry")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={togglePlay}
            disabled={phase !== "playing"}
            aria-label={remote.paused ? t("player.play") : t("player.pause")}
            className="player-pill player-center-btn rounded-full disabled:opacity-50"
            data-size="main"
          >
            {busy ? <Loader2 size={32} className="animate-spin" /> : remote.paused ? <Play size={32} /> : <Pause size={32} />}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-3 p-4" style={{ paddingBottom: "max(1rem, calc(env(safe-area-inset-bottom) + 1rem))" }}>
        <div className="flex items-center gap-3 text-xs tabular-nums text-muted">
          <span className="w-14 shrink-0 text-left">{formatTime(remote.currentTime)}</span>
          <input
            type="range"
            aria-label={t("player.chromecast.position")}
            className="h-5 min-w-0 flex-1 accent-white"
            min={0}
            max={Math.max(remote.duration, 1)}
            step={1}
            value={Math.min(remote.currentTime, Math.max(remote.duration, 1))}
            disabled={phase !== "playing" || !remote.duration}
            onChange={(e) => seekTo(Number(e.target.value))}
          />
          <span className="w-14 shrink-0 text-right">{formatTime(remote.duration)}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {audioTracks.length > 1 && (
              <label className="player-pill flex items-center gap-2 px-3 py-1 text-sm">
                <span className="text-subtle">{t("player.audio")}</span>
                <select
                  className="max-w-[12rem] bg-transparent text-white"
                  value={currentAudio ?? ""}
                  onChange={(e) => changeAudio(Number(e.target.value))}
                  disabled={phase === "negotiating"}
                >
                  {audioTracks.map((a) => (
                    <option key={a.id} value={a.id} className="text-black">
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {subtitles.length > 0 && (
              <label className="player-pill flex items-center gap-2 px-3 py-1 text-sm">
                <span className="text-subtle">{t("player.subtitles")}</span>
                <select
                  className="max-w-[12rem] bg-transparent text-white"
                  value={currentSubtitle ?? ""}
                  onChange={(e) => changeSubtitle(e.target.value === "" ? null : Number(e.target.value))}
                  disabled={phase === "negotiating"}
                >
                  <option value="" className="text-black">
                    {t("player.none")}
                  </option>
                  {subtitles.map((s) => (
                    <option key={s.index} value={s.index} className="text-black">
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="player-pill flex items-center gap-1 p-1">
              <button type="button" onClick={toggleMute} aria-label={t("player.mute")} className="player-pill-btn">
                {remote.muted || remote.volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
              </button>
              <input
                type="range"
                aria-label={t("player.volume")}
                className="h-5 w-24 accent-white"
                min={0}
                max={1}
                step={0.05}
                value={remote.muted ? 0 : remote.volume}
                onChange={(e) => setVolume(Number(e.target.value))}
              />
            </div>
          </div>
          <button type="button" onClick={resumeHere} className="player-pill flex items-center gap-2 px-4 py-2 text-sm">
            <Smartphone size={18} />
            {t("player.chromecast.resumeHere")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Le nom du récepteur, tel qu'il se présente. */
function deviceOf(session: CastSession | null): string | null {
  try {
    return session?.getCastDevice()?.friendlyName?.trim() || null;
  } catch {
    return null;
  }
}

/** Le sous-titre en cours, s'il est en images (donc incrusté par le serveur) — sinon `null`. */
function burnedOf(current: number | null, subtitles: ChromecastSubtitleFacts[]): number | null {
  if (current === null) return null;
  const track = subtitles.find((s) => s.index === current);
  return track && !isSideLoadable(track) ? current : null;
}

/** Allume une piste texte sur le récepteur, sans relancer le flux. Un refus ne casse rien. */
function editTracks(session: CastSession | null, activeTrackIds: number[]): void {
  const globals = chromecastGlobals();
  const media = session?.getMediaSession();
  if (!globals || !media) return;
  try {
    media.editTracksInfo(new globals.chromeCast.media.EditTracksInfoRequest(activeTrackIds), () => {}, () => {});
  } catch {
    // Le récepteur garde sa piste.
  }
}
