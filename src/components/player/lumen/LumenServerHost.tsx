"use client";

/**
 * Lumen serveur dans l'application (étape 4 de docs/remux-serveur/, DECISIONS.md §180) : le film remultiplexé
 * par le serveur, servi en HLS fMP4 sans état, lu par le HLS natif de WebKit (`<video src="….m3u8">`).
 *
 * Monté par `PlayerHost` quand `choosePlayer` rend `"lumen"` : l'option d'appareil de l'administrateur, WebKit
 * avec son HLS natif, une page qui n'a jamais servi de MediaSource, un titre jamais rendu, et seulement là où
 * la route serait `"native"`. Clé `lumen:${itemId}:${openId}` : un épisode = un nouvel hôte, un nouvel élément,
 * une nouvelle séance HLS (ce qui marche sur WebKit — fait 3 de 3-client.md).
 *
 * **Un hôte à part**, pas un mode du lecteur serveur (`ActivePlayer`) : celui-ci est monté par ses empreintes, et
 * 60 % de son code (négociation Jellyfin, échelle audio, hls.js, version allégée) ne concerne pas ce chemin. On
 * assemble ici les pièces déjà sorties pour être partagées — le bilan et l'arrêt gardé (`useServerSessionRecord`,
 * `useServerStopOnLeave`), la position (`useServerPositionWatch`), la chronologie (`useServerTimeline`), les
 * étiquettes (`serverTracks`), l'ouverture animée (`ServerPlayerIntro`), les sous-titres dessinés par la page
 * (`useLumenSubtitleLines`, §190), la fermeture (`closePlayerSession`, `advanceTo`), la minuterie, `PlayerControls` tel
 * quel (Media Session, « À l'écran », questions, « Jusqu'ici », passage rejoué, saga, épisode suivant).
 *
 * **Le repli** (3-client.md §3), un seul point de contrôle (`fallTo`, une fois, jamais pendant la fermeture) :
 * - **avant la première image** — refus du serveur, langue du compte non servie, code 4, 20 s sans image,
 *   description ou position indisponibles — : le lecteur actuel, dans la même page (MediaSource après HLS natif :
 *   marche), et le titre rendu pour le reste de la page (`declineLumen`) ;
 * - **après** : le lecteur serveur Jellyfin, par le relais existant (`handOver` de `PlayerHost`, qui recharge la
 *   page sur WebKit — `shouldReloadDirect`), la position et la piste emportées.
 * Une seule relance en place pour une erreur passagère (un 503 « occupé » qu'AVFoundation n'a pas réessayé, une
 * coupure) : un élément neuf à la même position une seconde plus tard, puis le repli.
 *
 * **Ce qui diffère exprès du lecteur serveur** : §24 appliqué (c'est une lecture, pas une diffusion — sauf pendant
 * AirPlay) ; AirPlay depuis l'élément même (§186 : l'adresse porte le laissez-passer d'une Apple TV, `tv.{jeton}`),
 * le lecteur serveur seulement pour diffuser avec des sous-titres ; pas d'échelle audio, pas de version allégée.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { PlayerControls, type Track } from "@/components/PlayerControls";
import { PlaybackInfoPanel, type PlaybackPanelData } from "@/components/PlaybackInfoPanel";
import { usePlayback } from "@/components/PlaybackProvider";
import { useLocale, useT } from "@/components/TranslationProvider";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { SubtitleLayer } from "@/components/player/SubtitleLayer";
import { ServerPlayerIntro } from "@/components/player/server/ServerPlayerIntro";
import { ServerWaitPill } from "@/components/player/server/ServerPlayerScreens";
import { releaseHlsElement, withStartFragment } from "@/components/player/server/serverElement";
import { serverSubtitleTracks, subtitleFacts, subtitleFactsOf, type ExternalSubtitleTrack } from "@/components/player/server/serverTracks";
import { useServerSessionRecord, useServerStopOnLeave } from "@/components/player/server/useServerSessionRecord";
import { useServerPositionWatch } from "@/components/player/server/useServerPositionWatch";
import { useServerTimeline } from "@/components/player/server/useServerTimeline";
import { useCastRoute } from "@/components/player/server/useCastRoute";
import { useFrameFit } from "@/lib/frameFit";
import { readDialogueMode, writeDialogueMode } from "@/lib/dialoguePreference";
import type { DialogueMode } from "@/lib/webcodecs/dialogueEnhance";
import { NativeWarning } from "@/components/playerNative/NativeOverlays";
import { isGeneratingTrack } from "@/lib/subtitleGen/generation";
import type { ExternalSubtitleSource } from "@/lib/webcodecs/externalSubtitles";
import { languageName } from "@/lib/trackLabel";
import { useLumenSubtitleGeneration } from "./useLumenSubtitleGeneration";
import { useLumenSubtitleLines } from "./useLumenSubtitleLines";
import { applyInbandModes, castStaysOnLumen, castSubtitleCarried, castSubtitleWanted, withCastSubtitle } from "./castSubtitles";
import { describeLumenServerPlayback, receivedOf } from "@/lib/lumenPanel";
import { formatTime } from "@/lib/playerClock";
import { useWatchedClockRun } from "@/components/player/session/useWatchedClockRun";
import { secondAllowed, secondSurvives } from "@/components/player/session/dualSubtitleRules";
import { recordsResume } from "@/components/player/session/habitWatch";
import { seekElapsed, seekStart, type SeekStart } from "@/components/player/session/seekElapsed";
import { claimOnce, advanceTo, closePlayerSession, reopenAt } from "@/components/player/playerClose";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { useSceneMode } from "@/lib/sceneMode";
import { PLAYBACK_CLIENTS } from "@/lib/playbackClients";
import { reportPlayback } from "@/lib/reportPlayback";
import { restoreRememberedVolume } from "@/lib/rememberedVolume";
import { usePlayerFocus } from "@/lib/usePlayerFocus";
import { useViewportResizing } from "@/lib/useViewportResizing";
import { useWakeLock } from "@/lib/useWakeLock";
import { useSleepTimer } from "@/lib/useSleepTimer";
import type { SleepMode } from "@/lib/sleepTimer";
import { usePlayerBackClose } from "@/lib/playerHistory";
import { PLAYER_FRAME_TRANSITION } from "@/lib/playerFrame";
import { CastResume } from "@/lib/castResume";
import { SessionTally, WatchedClock, newPlayerSessionId, watchElementWaits } from "@/lib/playerSessionTally";
import { ServerStartup } from "@/lib/serverStartup";
import { SlowLog, type LighterStep } from "@/lib/slowLinkPolicy";
import type { LinkMeter } from "@/lib/slowLink";
import { serverSleepFields, type ServerPlayerContext, type ServerStartWhy } from "@/lib/serverPlayerLog";
import { HostSeek, describeBufferedAround } from "@/lib/hostSeek";
import { BackgroundWatch } from "@/lib/backgroundReturn";
import { directInfoForOpening } from "@/lib/directInfo";
import { fetchPlaybackState, takePrefetchedPlaybackState } from "@/lib/playbackPrefetch";
import { openingPosition } from "@/lib/resumeRewind";
import { noteSeriesLanguage } from "@/lib/noteSeriesLanguage";
import { pickReplaySubtitle } from "@/lib/replaySubtitles";
import { subtitleStyleStore, type ChromeEdges } from "@/lib/subtitleStyle";
import { dualSubtitleMemory, pickRememberedDual, rememberDual } from "@/lib/dualSubtitles";
import { labelAudioTracks } from "@/lib/trackLabel";
import { toJellyfinLanguage, trackLanguage, type TrackPreferences } from "@/lib/trackPreferences";
import { declineLumen, lumenKeepAwakeOn } from "@/lib/lumenServerChoice";
import { AudioKeepAwake } from "./audioKeepAwake";
import { readLumenPrepared } from "@/lib/lumenSheetPrepare";
import type { StableTakeover } from "@/lib/useStableFallback";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import {
  audioChoicesOf,
  audioTrackPosition,
  enabledAudioNumber,
  jellyfinIndexOf,
  matroskaNumberOf,
  openingAudioOf,
  openingSubtitleOf,
  parseMasterAudio,
  processingOf,
  textSubtitles,
  verdictRefusal,
  type AudioTrackLike,
  type LumenAudioFacts,
  type LumenAudioChoice,
  type LumenDialogueMode,
  type LumenVerdict,
  type MasterAudio,
} from "./lumenOpening";
import {
  bufferedText,
  lumenAudioFields,
  lumenCastSubtitleFields,
  lumenContext,
  lumenErrorFields,
  lumenFallbackFields,
  lumenRebuildFields,
  lumenOpeningFields,
  lumenReason,
  lumenRequestsSeen,
  lumenSeekFields,
  lumenStallFields,
  lumenStartFields,
  mediaErrorText,
  watchLumenRequests,
  type LumenFallbackTarget,
  type LumenStartWhy,
} from "./lumenLog";

type Session = NonNullable<ReturnType<typeof usePlayback>["session"]>;

/** Sans image en vingt secondes de page visible : le lecteur actuel reprend (la règle du lecteur serveur). */
export const LUMEN_PICTURE_WATCHDOG_MS = 20_000;
/** Une horloge figée en lecture : la ligne `stall` à 5 s (une par minute au plus), le relais à 35 s. */
export const LUMEN_STALL_LINE_MS = 5000;
export const LUMEN_STALL_RECOVER_MS = 35_000;
/** Ce qu'on attend un serveur qui redémarre (un déploiement) avant de dire la lecture interrompue. */
export const LUMEN_SERVER_WAIT_MS = 90_000;
const LUMEN_SERVER_POLL_MS = 3000;
/** Au-delà, la séance passe au lecteur serveur : un chemin qui se rouvre en boucle ne se répare pas ainsi. */
export const LUMEN_MAX_REOPENS = 3;
const STALL_LINE_EVERY_MS = 60_000;
/** Le délai de la relance en place après une erreur passagère (un 503 « occupé », une coupure brève). */
export const LUMEN_RETRY_DELAY_MS = 1000;
/** Ce qu'on accorde au verdict du serveur : un index à froid se construit en ~0,2 s depuis les Cues (§158). */
const VERDICT_WAIT_MS = 8000;
/** Après un changement de piste par `audioTracks`, le temps laissé à Safari avant de juger `applied`. */
const AUDIO_SETTLE_MS = 2000;

/** Une réponse du serveur de Lumen : le verdict, ou pourquoi il n'y en a pas. */
async function fetchVerdict(itemId: string, s: string, audio: number | null, mux: boolean, dialogue?: LumenDialogueMode | null): Promise<LumenVerdict | { failed: string; refused?: boolean }> {
  // `tv=1` : l'adresse munie du laissez-passer d'une Apple TV (§186) — le bouton AirPlay tend la `src` au téléviseur.
  const params = new URLSearchParams({ s, wait: String(VERDICT_WAIT_MS), tv: "1" });
  if (audio !== null) params.set("audio", String(audio));
  if (mux) params.set("mux", "1");
  // « Améliorer les dialogues » (§193) : la liste maître des rendus traités par le serveur, s'il peut.
  if (dialogue) params.set("dialogue", dialogue);
  try {
    const res = await fetch(`/api/lumen/${itemId}/eligibility?${params}`, { signal: AbortSignal.timeout(VERDICT_WAIT_MS + 6000) });
    // 403 : un compte qui n'est pas administrateur sur un appareil où l'option est allumée — un refus attendu.
    if (res.status !== 200 && res.status !== 202) return { failed: `éligibilité : HTTP ${res.status}`, refused: res.status === 403 };
    return (await res.json()) as LumenVerdict;
  } catch (error) {
    return { failed: `éligibilité : ${error instanceof Error ? error.message : "réseau"}`.slice(0, 160) };
  }
}

interface PistesAnswer {
  mediaSourceId: string | null;
  subtitleTracks: Omit<ExternalSubtitleTrack, "label">[];
  /** Le son multiplexé dans les segments vidéo (essai `m1`, `LUMEN_MUX_AUDIO=1`), coupé par défaut. */
  mux?: boolean;
}

async function fetchPistes(itemId: string): Promise<PistesAnswer> {
  try {
    const res = await fetch(`/api/lumen/${itemId}/pistes`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { mediaSourceId: null, subtitleTracks: [] };
    return (await res.json()) as PistesAnswer;
  } catch {
    // Sans la liste, le film se lit sans sous-titres plutôt que de renoncer.
    return { mediaSourceId: null, subtitleTracks: [] };
  }
}

/** Les étiquettes des pistes son, comme la liste maître et les deux autres lecteurs (`trackLabel.ts`). */
function audioLabels(audio: readonly LumenAudioChoice[], hlsChannels: Map<number, string | null>, originalLanguage: string | null, locale: string, t: ReturnType<typeof useT>): Map<number, string> {
  return new Map(
    labelAudioTracks(
      audio.map((a) => ({
        number: a.number,
        language: a.language,
        name: a.name,
        isDefault: a.isDefault,
        isForced: false,
        codecId: a.codec,
        channels: a.channels,
        profile: hlsChannels.get(a.number)?.endsWith("/JOC") ? "Dolby Digital Plus + Dolby Atmos" : null,
      })),
      { locale, originalLanguage, canaux: (n: number) => t("player.trackLabel.channels", { n }), piste: (n: number) => t("player.trackLabel.track", { n }) }
    ).map((l) => [l.number, l.label])
  );
}

/** Un changement de piste servi par réouverture, en attente de sa première image (§185). */
interface PendingAudio {
  from: number | null;
  to: number;
  at: number;
  fromTrack: string;
  toTrack: string;
  processing: string;
  /** Le geste (le menu), et l'adresse posée. */
  startedAt0: number;
  startedAt: number;
  srcAt: number;
  /** `audioTracks` essayé d'abord : pourquoi il n'a pas suffi. */
  first?: string;
  /** L'image d'avant a pu être figée par-dessus. */
  frozen: boolean;
  /** En pause au moment du changement : rouvert en pause. */
  keepPaused: boolean;
  /** La première image de la nouvelle séance (ms depuis l'adresse posée). */
  pictureMs?: number;
  /** « Améliorer les dialogues » (§193) : la force servie par la liste rouverte, pour la ligne `audio`. */
  dialogue?: DialogueMode;
}

/**
 * L'image affichée, figée dans une image (`blob:`), à poser par-dessus l'élément pendant une réouverture. WebKit
 * dessine une vidéo HLS native dans un `<canvas>` (même origine) ; `null` si rien n'est dessinable (pas encore
 * d'image, refus) — la réouverture se fait alors sans, comme avant.
 */
function freezeFrame(video: HTMLVideoElement): string | null {
  try {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return null;
    // Au plus 1280 px de large : une image de transition de moins d'une seconde, pas un instantané.
    const scale = Math.min(1, 1280 / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    // `toDataURL` plutôt que `toBlob` : synchrone, l'image est là avant que l'adresse ne change (~10 ms en JPEG).
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  }
}

export function LumenServerHost({
  session,
  mode,
  serverFallback,
  onFallback,
}: {
  session: Session;
  mode: "full" | "mini";
  /** L'installation a-t-elle un lecteur serveur ? Sans lui, un repli après l'image devient un écran d'erreur. */
  serverFallback: boolean;
  /** Le relais au lecteur serveur (`handOver` de `PlayerHost`), après la première image. */
  onFallback: (reason: string, takeover?: StableTakeover, sessionId?: string) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const playback = usePlayback();
  const { itemId, title: openedAs, bench, fromReload } = session;

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scene = useSceneMode(
    session,
    useCallback(() => {
      const video = videoRef.current;
      return !!video && !video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    }, [])
  );
  const isSceneRef = useRef(scene.isScene);
  useEffect(() => {
    isSceneRef.current = scene.isScene;
  }, [scene.isScene]);

  // Une séance du journal par hôte — donc par épisode. Un rechargement pour changer de piste poursuit celle
  // d'avant (`reloadCarry.continues`). Son identifiant est aussi celui de la lecture côté serveur (`s` dans
  // l'adresse) : la route du journal y retrouve le relevé (`srv.*`) sans table de correspondance.
  const [logId] = useState(() => session.reloadCarry?.continues ?? newPlayerSessionId());
  const [lumenSession] = useState(() => (/^[A-Za-z0-9_-]{4,64}$/.test(logId) ? logId : `ls${Date.now().toString(36)}`));
  const logSession = useRef({ itemId, id: logId });
  const agent = typeof navigator === "undefined" ? undefined : navigator.userAgent;
  const [serverTitle, setServerTitle] = useState<string | null>(null);
  const title = serverTitle ?? openedAs;
  const logContext = useRef<ServerPlayerContext>(lumenContext({ itemId, title, cast: false, bench, scene: scene.logFields, session: logId, agent }));
  useEffect(() => {
    logContext.current = lumenContext({ itemId, title, cast: false, bench, scene: scene.logFields, session: logId, agent });
  }, [itemId, title, bench, scene.logFields, logId, agent]);

  // Le décompte de la séance (`SessionTally`, celui des deux autres lecteurs) et ce que le bilan partagé lit.
  // Les mesures du lien (§77-78) n'existent pas ici : leurs références restent vides, et le bilan n'en dit rien.
  const tallyRef = useRef(new SessionTally());
  const restartsRef = useRef<Partial<Record<ServerStartWhy, number>>>({});
  const subtitleSwitchesRef = useRef(0);
  const sessionPlayedRef = useRef(false);
  const [mountedAt] = useState(() => Date.now());
  const sessionStartedAtRef = useRef(mountedAt);
  const errorRef = useRef<string | null>(null);
  const handedOverRef = useRef(false);
  const closedRef = useRef(false);
  const slowLogRef = useRef(new SlowLog());
  const switchGapRef = useRef<number | null>(null);
  const reloadGapRef = useRef<number | null>(null);
  const lighterClearedRef = useRef(false);
  const linkMeterRef = useRef<LinkMeter | null>(null);
  const streamNeedRef = useRef<number | null>(null);
  const startupRef = useRef<ServerStartup | null>(null);
  const negotiatedStepRef = useRef<LighterStep | null>(null);
  const carriedOnlyRef = useRef(false);
  const [watched] = useState(() => new WatchedClock());
  const [castResume] = useState(() => new CastResume());
  const [seeks] = useState(() => new HostSeek());
  const [background] = useState(() => new BackgroundWatch());

  // Semée au point de reprise demandé : fermer pendant l'ouverture ne rapporte pas zéro (règle des deux lecteurs).
  const lastKnownTime = useRef(session.resumeAt ?? 0);
  // La cible d'un saut en cours plutôt que la position d'avant (`intendedPosition`, §115, avec la cible demandée
  // par les commandes — `HostSeek`, comme le lecteur actuel).
  const positionNow = useCallback(() => seeks.intendedPosition(videoRef.current, lastKnownTime.current), [seeks]);

  const [videoKey, setVideoKey] = useState(0);
  /**
   * L'élément dont la première image est arrivée : ses `<track>` ne sont posés qu'à ce moment. Un `<video>` qui porte
   * des `<track>` au moment où son adresse HLS est posée est refusé par Safari sur iPhone (code 4 après la liste
   * maître et la liste vidéo, sans liste son ni segment) : 5 lectures sur 5 dans l'application le 17/11/2026, et la
   * passe « Comme l'app » de `/lumen-test` l'a isolé — `tracks` seul échoue, tout le reste sans lui passe.
   */
  const [tracksFor, setTracksFor] = useState(-1);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [introCovering, setIntroCovering] = useState(false);
  const [loadingLong, setLoadingLong] = useState(false);
  const [closing, setClosing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [chromeEdges, setChromeEdges] = useState<ChromeEdges | null>(null);
  const [showPlaybackInfo, setShowPlaybackInfo] = useState(false);
  const [audioTracks, setAudioTracks] = useState<Track[]>([]);
  const [currentAudioId, setCurrentAudioId] = useState<number | null>(null);
  const [externalSubtitleTracks, setExternalSubtitleTracks] = useState<ExternalSubtitleTrack[]>([]);
  const [currentSubtitleId, setCurrentSubtitleId] = useState<number | null>(null);
  const [secondSubtitleId, setSecondSubtitleId] = useState<number | null>(null);
  /**
   * Les décalages du menu (±0,5 s), tenus par l'hôte qui dessine (§190), comme le lecteur natif : appliqués à la
   * recherche de la réplique, jamais aux répliques des `<track>` — un élément neuf (réouverture pour une piste son)
   * rechargeait les répliques d'origine, et le chiffre du menu ne disait plus ce qu'on voyait. Remis à zéro au
   * changement de piste (la correction d'une piste recalée, §141, est déjà dans son WebVTT).
   */
  const [subtitleOffset, setSubtitleOffset] = useState(0);
  const [secondOffset, setSecondOffset] = useState(0);
  /** Le passage rejoué (§150) : la piste que l'aide montre à la place du principal, le temps du passage. */
  const [replayId, setReplayId] = useState<number | null>(null);
  const [introSkip, setIntroSkip] = useState<{ start: number; end: number } | null>(null);
  const [recapSkip, setRecapSkip] = useState<{ start: number; end: number } | null>(null);
  const [creditsStart, setCreditsStart] = useState<number | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(session.introArt?.logoUrl ?? null);
  const [playSession, setPlaySession] = useState<{ itemId: string; playSessionId: string; mediaSourceId: string } | null>(null);
  /** Ce que le panneau technique montre de l'ouverture (§189) ; le reste est lu à l'ouverture du panneau. */
  const [panel, setPanel] = useState<{
    video: { codec: string | null; width: number | null; height: number | null; rangeType: string | null } | null;
    container: string | null;
    master: string;
    segments: number;
    targetS: number;
    version: string;
    resumeBy: string;
    cut: string | null;
    /** Les pistes son : faits du serveur, choix, étiquettes — lus au rendu, donc tenus dans l'état. */
    audioFacts: LumenAudioFacts[];
    choices: LumenAudioChoice[];
    labels: Map<number, string>;
  } | null>(null);
  /** Les incidents de la séance, en mots, pour le panneau : relances, réouvertures, pistes, AirPlay (§189). */
  const [events, setEvents] = useState<string[]>([]);
  const noteEvent = useCallback((text: string) => setEvents((previous) => [...previous.slice(-9), text]), []);
  const noteEventRef = useRef(noteEvent);
  const [serverStats, setServerStats] = useState<Record<string, number | string> | null>(null);
  const [received, setReceived] = useState<ReturnType<typeof receivedOf>>(null);

  const subtitleStyle = useSyncExternalStore(subtitleStyleStore.subscribe, subtitleStyleStore.snapshot, subtitleStyleStore.serverSnapshot);
  /** L'image d'avant, figée par-dessus l'élément pendant une réouverture pour changer de piste (§185). */
  const [freezeUrl, setFreezeUrl] = useState<string | null>(null);
  /** Les fichiers à côté du film (description Jellyfin, `generated` compris) : le menu « Générer » en tient compte (§187). */
  const [externals, setExternals] = useState<ExternalSubtitleSource[]>([]);
  /** Un message passager (une génération refusée) : jamais l'écran d'erreur. */
  const [warning, setWarning] = useState<string | null>(null);
  /**
   * AirPlay (§186) : la route sans fil prise par l'élément — le téléviseur lit lui-même l'adresse munie du laissez-
   * passer. Écoutée par `useCastRoute` (celle du lecteur serveur), sans séance « ouverte pour diffuser » : rien n'est
   * rendu au téléphone à la fin, la lecture continue ici.
   */
  const [castActive, setCastActive] = useState(false);
  const castActiveRef = useRef(false);
  const castAttemptedRef = useRef(false);
  const lastPlaybackOptsRef = useRef<{ resumeAt?: number } | undefined>(undefined);
  const pendingAudioRef = useRef<PendingAudio | null>(null);
  /**
   * Le sous-titre du téléviseur en train de changer (§191) : la liste rouverte avec `?st=`, en attente de son image.
   * `keepPaused` : en pause au moment du changement, rouvert en pause (le téléviseur ne doit pas repartir seul).
   */
  const pendingCastSubtitleRef = useRef<{ st: number | null; fromSt: number | null; label: string | null; at: number; srcAt: number; keepPaused: boolean } | null>(null);
  const audioSettleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * « Améliorer les dialogues » (§193). `dialogueMode` : le réglage de l'appareil, lu une fois à l'ouverture (un banc
   * mesure le chemin sans traitement), puis tenu par le menu. `servedDialogue` : ce que la liste posée sur l'élément
   * sert vraiment — la liste maître des rendus traités par le serveur à cette force (`?dialogue=`), ou null : la liste
   * ordinaire. Les deux diffèrent quand la piste choisie n'a pas de rendu traité (le menu dit alors « Sans effet »).
   */
  const [dialogueMode, setDialogueMode] = useState<DialogueMode>(() => (bench ? "off" : readDialogueMode()));
  const dialogueModeRef = useRef<DialogueMode>(dialogueMode);
  const [servedDialogue, setServedDialogue] = useState<LumenDialogueMode | null>(null);
  const servedDialogueRef = useRef<LumenDialogueMode | null>(null);
  const dialogueSwitchingRef = useRef(false);

  /** Ce que les écouteurs, posés une fois, lisent de la séance. */
  const currentSubtitleRef = useRef<number | null>(null);
  const secondSubtitleRef = useRef<number | null>(null);
  const audioFactsRef = useRef<LumenAudioChoice[]>([]);
  const jellyfinAudioRef = useRef<DirectPlayInfo["audio"] | undefined>(undefined);
  const masterAudioRef = useRef<MasterAudio[]>([]);
  const masterRef = useRef<string | null>(null);
  const versionRef = useRef("");
  const pendingPlaySessionRef = useRef<{ itemId: string; playSessionId: string; mediaSourceId: string } | null>(null);
  /** Le son multiplexé (essai `m1`) : relu tel quel par une réouverture. */
  const muxRef = useRef(false);
  const currentAudioRef = useRef<number | null>(null);
  const audioLabelsRef = useRef<Map<number, string>>(new Map());
  /** La première image de la séance : le partage du repli entre « avant » (lecteur actuel) et « après » (serveur). */
  const pictureRef = useRef(false);
  const fellRef = useRef(false);
  const retriedRef = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** L'instant où l'adresse a été posée, et la position voulue — l'ouverture et sa ligne en partent. */
  const srcSetRef = useRef<{ at: number; resumeAt: number; fragment: boolean } | null>(null);
  /** Le saut de secours, quand Safari a ignoré `#t=` : pas un geste du spectateur. */
  const safetySeekRef = useRef(false);
  /** L'essai « Garder le son éveillé pendant la pause » (`audioKeepAwake.ts`), une veille par hôte, fermée au démontage. */
  const keepAwakeRef = useRef<AudioKeepAwake | null>(null);
  useEffect(() => {
    // Arrière-plan ou écran verrouillé pendant une pause : la veille se tait aussitôt, elle ne garderait éveillés que
    // la sortie audio et la page, pour personne.
    const onHidden = () => {
      if (document.visibilityState === "hidden") keepAwakeRef.current?.stop();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      keepAwakeRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  const { stop: stopPlaybackNow, resume: resumePlaybackSession, savePaused, reportNow: reportPositionNow } = usePlaybackSession(
    positionNow,
    // Comme le lecteur actuel : Jellyfin ne sait rien de cette lecture (aucune négociation), la séance s'annonce
    // elle-même — à la première image seulement, pour qu'un repli d'ouverture ne laisse pas d'annonce orpheline.
    // `DirectStream` : le fichier est remultiplexé, ni transcodé ni lu tel quel. Rien pour un banc ni une scène.
    playSession && !bench && !scene.active ? { ...playSession, playMethod: "DirectStream", client: PLAYBACK_CLIENTS.engine, announce: true } : null,
    useCallback(() => videoRef.current?.paused ?? false, [])
  );

  const nextEpisode = scene.active ? null : (session.getNextEpisode?.(itemId) ?? null);
  const onSlept = useCallback(
    (sleptMode: SleepMode) => {
      reportPlayback("pause", serverSleepFields(logContext.current, sleptMode, lastKnownTime.current));
      savePaused();
    },
    [savePaused]
  );
  const { holdAtEnd } = useSleepTimer(videoRef, onSlept);

  const { stopFields, markHandedOver, stopAlreadySent, reportStop } = useServerSessionRecord({
    videoRef,
    logContext,
    positionNow,
    watched,
    tallyRef,
    subtitleSwitchesRef,
    restartsRef,
    errorRef,
    sessionPlayedRef,
    sessionStartedAtRef,
    slowLogRef,
    switchGapRef,
    reloadGapRef,
    lighterClearedRef,
    linkMeterRef,
    streamNeedRef,
    startupRef,
    negotiatedStepRef,
    carriedOnlyRef,
    handedOverRef,
    // Ce que le bilan de Lumen serveur ajoute : la lecture côté serveur (la route y joint `srv.*`) et le décodage.
    extraStopFields: useCallback(() => {
      const quality = videoRef.current?.getVideoPlaybackQuality?.();
      return {
        lumenSession,
        ...(quality ? { "frames.total": quality.totalVideoFrames, "frames.dropped": quality.droppedVideoFrames } : {}),
      };
    }, [lumenSession]),
  });

  const clearTimers = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const takeoverNow = useCallback(
    (): StableTakeover => ({
      resumeAt: positionNow(),
      audioStreamIndex: jellyfinIndexOf(audioFactsRef.current, jellyfinAudioRef.current, currentAudioRef.current),
    }),
    [positionNow]
  );

  /**
   * Le point de contrôle du repli — une fois (`fellRef`), jamais pendant la fermeture. Avant la première image,
   * le lecteur actuel (`declineLumen` : `PlayerHost` se redessine sur lui, même `openId`) ; après, le lecteur
   * serveur par le relais existant. Une ligne `fallback` dit lequel et pourquoi ; ni `stop` ici ni bilan gardé
   * (`markHandedOver`) : la séance continue ailleurs, ou finit sur cette ligne.
   */
  const fallTo = useCallback(
    (target: LumenFallbackTarget, reason: string, opts: { planned?: boolean; stage?: string; mediaError?: string | null; takeover?: StableTakeover; cast?: boolean } = {}) => {
      if (closedRef.current || fellRef.current) return;
      // Sans lecteur serveur sur l'installation, un repli d'après l'image n'a personne à qui passer : écran d'erreur.
      if (target === "serveur" && !serverFallback) {
        reportPlayback("error", lumenErrorFields(logContext.current, lumenReason(reason), { ...(opts.mediaError ? { mediaError: opts.mediaError } : {}), lumenSession }));
        setError(t("player.playbackInterrupted"));
        setLoading(false);
        return;
      }
      fellRef.current = true;
      clearTimers();
      const now = Date.now();
      const takeover = target === "serveur" ? (opts.takeover ?? takeoverNow()) : undefined;
      reportPlayback(
        "fallback",
        lumenFallbackFields(
          logContext.current,
          {
            to: target,
            planned: opts.planned === true,
            reason: lumenReason(reason),
            watched: watched.take(now),
            stage: opts.stage,
            mediaError: opts.mediaError,
            takeover,
            cast: opts.cast,
            // Un refus de l'élément ou une image qui ne vient pas : ce que Safari a demandé avant de renoncer.
            seen: opts.planned ? undefined : lumenRequestsSeen(lumenSession),
          },
          lumenSession,
          tallyRef.current.backgroundFacts(now)
        )
      );
      markHandedOver();
      const video = videoRef.current;
      if (target === "natif") {
        // La séance HLS coupée avant de monter le lecteur actuel : iOS continuerait sinon de demander des segments.
        try {
          if (video) releaseHlsElement(video);
        } catch {
          // Déjà démonté.
        }
        declineLumen(itemId);
        return;
      }
      // L'arrêt de cette séance-ci chez Jellyfin, avant que le lecteur serveur n'annonce la sienne en négociant.
      void stopPlaybackNow();
      try {
        if (video && !opts.cast) releaseHlsElement(video);
      } catch {
        // Déjà démonté.
      }
      onFallback(lumenReason(reason), takeover ? { ...takeover, ...(opts.cast ? { cast: true } : {}) } : undefined, logSession.current.id);
    },
    [serverFallback, clearTimers, takeoverNow, watched, lumenSession, markHandedOver, itemId, stopPlaybackNow, onFallback, t]
  );
  const fallToRef = useRef(fallTo);
  useEffect(() => {
    fallToRef.current = fallTo;
  }, [fallTo]);

  /**
   * Poser une adresse sur un élément neuf (la clé : WebKit tient une séance HLS par élément), à la position voulue
   * en `#t=`. Pour une relance d'avant l'image, une ligne `start` (`why: "retry"`) ; après, une ligne `rebuild`
   * avec sa raison — la lecture continue sur ce chemin, ce n'est pas un repli.
   */
  const reopen = useCallback(
    (master: string, at: number, reason: string, version: string) => {
      if (closedRef.current || fellRef.current) return;
      const fromVersion = versionRef.current;
      masterRef.current = master;
      versionRef.current = version;
      if (pictureRef.current) {
        reportPlayback("rebuild", lumenRebuildFields(logContext.current, { reason, at, fromVersion, toVersion: version }, lumenSession, tallyRef.current.backgroundFacts(Date.now())));
        noteEvent(t("player.info.lumen.eventReopen", { at: formatTime(at), reason }));
      } else {
        noteEvent(t("player.info.lumen.eventRetry", { reason }));
        restartsRef.current.retry = (restartsRef.current.retry ?? 0) + 1;
        reportPlayback("start", { ...lumenStartFields(logContext.current, { why: "retry", at, audioTrack: currentAudioRef.current, lumenSession, version, fragment: at > 0, negotiateMs: 0 }), trigger: reason.slice(0, 160) });
      }
      srcSetRef.current = { at: Date.now(), resumeAt: at, fragment: at > 0 };
      lastKnownTime.current = at;
      setError(null);
      setLoading(true);
      setVideoKey((k) => k + 1);
      setSrc(withStartFragment(master, at));
    },
    [lumenSession, noteEvent, t]
  );

  /** Avant la première image : une relance à la même adresse une seconde plus tard (un segment « occupé »), une fois. */
  const retryOpening = useCallback(
    (cause: string): boolean => {
      const master = masterRef.current;
      if (retriedRef.current || !master || closedRef.current || fellRef.current) return false;
      retriedRef.current = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        reopen(master, srcSetRef.current?.resumeAt ?? 0, cause, versionRef.current);
      }, LUMEN_RETRY_DELAY_MS);
      return true;
    },
    [reopen]
  );

  /**
   * Après la première image : la lecture se rétablit **sur ce chemin** tant que le serveur le permet — un
   * déploiement (plusieurs par jour) ne doit jamais casser une lecture (Louis, 17/11/2026).
   *
   * Le serveur est relu (`eligibility`, la piste en cours), borné à `LUMEN_SERVER_WAIT_MS` :
   * - injoignable, 502/503 (redémarrage), hors ligne : on attend et on redemande toutes les 3 s ; si l'horloge
   *   repart entre-temps (Safari a réessayé seul ses segments), on s'arrête là, sans rien toucher ;
   * - une autre version de la liste (le format ou le fichier a changé : les segments répondent 410) : la nouvelle
   *   liste, rouverte à la position courante (`rebuild`, « version changée ») ;
   * - la même version : l'élément a renoncé (erreur) ou reste figé — rouvert à la position, `rebuild` aussi ;
   * - le fichier n'est plus servi : le lecteur serveur.
   * Au bout de la borne, l'écran « interrompue » et son « Réessayer » ; au-delà de trois réouvertures dans la
   * séance, le lecteur serveur — un chemin qui se rouvre en boucle ne se répare pas en se rouvrant encore.
   */
  const recoveringRef = useRef(false);
  const reopenCountRef = useRef(0);
  const recover = useCallback(
    async (cause: string, opts: { force?: boolean; stalled?: () => boolean } = {}) => {
      if (recoveringRef.current || closedRef.current || fellRef.current || !masterRef.current) return;
      recoveringRef.current = true;
      const deadline = Date.now() + LUMEN_SERVER_WAIT_MS;
      try {
        for (;;) {
          if (closedRef.current || fellRef.current) return;
          // Repartie d'elle-même (Safari a réessayé ses segments) : rien à faire, l'attente affichée s'efface.
          if (opts.stalled && !opts.stalled()) {
            setLoading(false);
            return;
          }
          const verdict = navigator.onLine ? await fetchVerdict(itemId, lumenSession, currentAudioRef.current, muxRef.current, servedDialogueRef.current) : { failed: "hors ligne" };
          if (closedRef.current || fellRef.current) return;
          if (opts.stalled && !opts.stalled()) {
            setLoading(false);
            return;
          }
          if ("failed" in verdict || "pending" in verdict) {
            if (Date.now() >= deadline) {
              videoRef.current?.pause();
              setError(t("player.playbackInterruptedCheckConnection"));
              return;
            }
            setLoading(true);
            await new Promise((resolve) => setTimeout(resolve, LUMEN_SERVER_POLL_MS));
            continue;
          }
          if (!verdict.ok) {
            fallToRef.current("serveur", `fichier plus servi après ${cause} (${verdictRefusal(verdict)})`, { stage: "lecture" });
            return;
          }
          const changed = verdict.version !== versionRef.current;
          // Le traitement « dialogues » que le serveur ne sert plus (option coupée par un déploiement, serveur saturé) :
          // la liste ordinaire rouverte, dite dans le panneau — la lecture d'abord, comme toute réouverture.
          if (servedDialogueRef.current && verdict.dialogue && !verdict.dialogue.served) {
            servedDialogueRef.current = null;
            setServedDialogue(null);
            noteEventRef.current(t("player.info.lumen.eventDialogue", { mode: t("player.dialogue.off"), ms: 0 }));
          }
          reopenCountRef.current += 1;
          if (reopenCountRef.current > LUMEN_MAX_REOPENS && !opts.force) {
            fallToRef.current("serveur", `${cause} (${LUMEN_MAX_REOPENS} réouvertures déjà)`, { stage: "lecture" });
            return;
          }
          reopen(verdict.master, positionNow(), changed ? `version changée (${versionRef.current} → ${verdict.version}) après ${cause}` : cause, verdict.version);
          return;
        }
      } finally {
        recoveringRef.current = false;
      }
    },
    [itemId, lumenSession, positionNow, reopen, t]
  );
  const recoverRef = useRef(recover);
  useEffect(() => {
    recoverRef.current = recover;
  }, [recover]);

  // Ce que Safari demande, écouté dès le montage : le tampon Resource Timing du cinéma est plein d'affiches, et le
  // `seen` d'un refus avant l'image restait vide (17/11/2026, `watchLumenRequests`).
  useEffect(() => watchLumenRequests(), []);

  // ── L'ouverture : description, état du spectateur, verdict, pistes — puis l'adresse ──────────────────
  const preferencesRef = useRef<TrackPreferences | null>(null);
  useEffect(() => {
    let abandoned = false;
    const began = performance.now();
    restoreRememberedVolume(videoRef.current);
    const open = async () => {
      const prepared = readLumenPrepared(itemId);
      // « Améliorer les dialogues » allumé sur l'appareil (§193) : la liste des rendus traités par le serveur, demandée
      // dès le premier verdict ; s'il ne peut pas les servir pour la piste d'ouverture, le lecteur actuel, qui le fait.
      const wantDialogue: LumenDialogueMode | undefined = dialogueModeRef.current === "off" ? undefined : dialogueModeRef.current;
      const [info, state, verdict0, pistes] = await Promise.all([
        directInfoForOpening(itemId).catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))),
        takePrefetchedPlaybackState(itemId) ?? fetchPlaybackState(itemId),
        fetchVerdict(itemId, lumenSession, null, false, wantDialogue),
        fetchPistes(itemId),
      ]);
      if (abandoned) return;
      const decline = (reason: string, planned: boolean, stage: string) => fallToRef.current("natif", reason, { planned, stage });
      if (info instanceof Error) return decline(`description du fichier indisponible (${info.message.slice(0, 80)})`, false, "description");
      jellyfinAudioRef.current = info.audio;
      setExternals(info.externalSubtitles ?? []);
      // Position inconnue (Jellyfin muet, §92) : le lecteur actuel a son écran pour cela.
      if (state?.positionUnknown && (session.resumeAt ?? null) === null) return decline("position de reprise inconnue", false, "position");
      if ("failed" in verdict0) return decline(verdict0.failed, verdict0.refused === true, "éligibilité");
      if ("pending" in verdict0) return decline("index en cours de construction", true, "éligibilité");
      const audio = audioChoicesOf(verdict0.audio);
      audioFactsRef.current = audio;
      const preferences = state?.preferences ?? null;
      preferencesRef.current = preferences;
      // Une piste déjà décidée : l'intention d'un rechargement pour changer de piste (index Jellyfin).
      const chosen = session.initialAudioStreamIndex !== undefined ? matroskaNumberOf(audio, info.audio, session.initialAudioStreamIndex) : null;
      const opening = openingAudioOf(audio, preferences, chosen);
      if (opening.kind === "refus") return decline(opening.reason, true, "piste");
      // La vidéo refusée (découpe, conteneur, lecture impossible) : rien à chercher du côté du son.
      if (!verdict0.ok && audio.length === 0) return decline(verdictRefusal(verdict0) ?? "refus", true, "éligibilité");
      // L'essai du son multiplexé ne porte que le son copié : jamais avec le traitement « dialogues ».
      const mux = pistes.mux === true && !wantDialogue;
      let verdict: LumenVerdict | { failed: string } = verdict0;
      if (!verdict0.ok || opening.number !== verdict0.audioTrack || mux) {
        verdict = await fetchVerdict(itemId, lumenSession, opening.number, mux, wantDialogue);
        if (abandoned) return;
        if ("failed" in verdict) return decline(verdict.failed, false, "éligibilité");
      }
      if (!verdict.ok) return decline(verdictRefusal(verdict) ?? "refus", true, "éligibilité");
      // Le serveur ne sert pas le traitement pour cette piste (AAC, FLAC, option coupée, serveur saturé) : le lecteur
      // actuel, qui le fait dans la page — la règle d'avant §193, un déclin prévu.
      if (wantDialogue && !verdict.dialogue?.served) {
        const why = verdict.dialogue && !verdict.dialogue.served ? `${verdict.dialogue.reason}${verdict.dialogue.detail ? ` : ${verdict.dialogue.detail}` : ""}` : "non servi";
        return decline(`améliorer les dialogues : ${why}`, true, "dialogues");
      }
      servedDialogueRef.current = wantDialogue ?? null;
      setServedDialogue(wantDialogue ?? null);
      const negotiateMs = performance.now() - began;

      // La position : affirmée par la séance (zéro compris), sinon celle du serveur ; recul d'ouverture (§28)
      // une fois, ni pour une scène ni pour un banc, ni pour un rechargement (il porte la position exacte).
      const resolved = session.resumeAt ?? state?.resumeSeconds ?? 0;
      const at = !fromReload && recordsResume(bench, isSceneRef.current) ? openingPosition(itemId, resolved, verdict.durationS) : resolved;

      // Les pistes du menu, toutes celles du fichier : une piste que le serveur ne sert pas passe au lecteur serveur.
      const hlsChannels = new Map(verdict.audio.map((a) => [a.number, a.hlsChannels]));
      const labels = audioLabels(audio, hlsChannels, info.originalLanguage ?? null, locale, t);
      audioLabelsRef.current = labels;
      setAudioTracks(audio.map((a) => ({ id: a.number, label: labels.get(a.number) ?? String(a.number) })));
      currentAudioRef.current = verdict.audioTrack;
      setCurrentAudioId(verdict.audioTrack);

      // Les sous-titres : texte seulement, les adresses de la route existante (synchro §141 comprise) ; la règle
      // du compte à l'ouverture (forcés compris), puis « deux sous-titres » retenu sur l'appareil (§87). Le
      // sous-titre d'avant un rechargement de piste passe avant les deux.
      const tracks = serverSubtitleTracks(textSubtitles(pistes.subtitleTracks), locale, t);
      const spoken = audio.find((a) => a.number === verdict.audioTrack) ?? null;
      const carriedSub = session.reloadCarry?.subtitleStreamIndex;
      const carried = typeof carriedSub === "number" && tracks.some((st) => st.index === carriedSub) ? carriedSub : null;
      const wanted = fromReload ? carried : openingSubtitleOf(tracks, preferences, spoken);
      const dual = bench ? null : pickRememberedDual(tracks.map(subtitleFacts), wanted, dualSubtitleMemory.read());
      const primary = dual ? dual.primary.number : wanted;
      currentSubtitleRef.current = primary;
      secondSubtitleRef.current = dual ? dual.second.number : null;
      setExternalSubtitleTracks(tracks);
      setCurrentSubtitleId(primary);
      setSecondSubtitleId(secondSubtitleRef.current);

      setServerTitle(info.title ?? null);
      setIntroSkip(info.introSkip ?? null);
      setRecapSkip(info.recapSkip ?? null);
      setCreditsStart(info.creditsStart ?? null);
      if (info.logoUrl) setLogoUrl(info.logoUrl);
      // Annoncée à Jellyfin à la première image seulement (`onLoadedData`) : un déclin d'ouverture ne laisse pas
      // d'annonce orpheline à côté de celle du lecteur actuel.
      pendingPlaySessionRef.current = { itemId, playSessionId: `lumen-serveur-${itemId}`, mediaSourceId: pistes.mediaSourceId ?? itemId };

      // L'adresse, la position en `#t=` (levier 2 : l'image directement à la reprise, 0,72 s au banc). Un saut
      // après chargement ou `EXT-X-START` coûtent plus et montrent d'abord une autre image : jamais en premier.
      const master = verdict.master;
      masterRef.current = master;
      versionRef.current = verdict.version;
      muxRef.current = mux;
      const fragment = withStartFragment(master, at) !== master;
      srcSetRef.current = { at: Date.now(), resumeAt: at, fragment };
      lastKnownTime.current = at;
      castResume.planned(at);
      const audioFacts = verdict.audio.find((a) => a.number === verdict.audioTrack);
      const resumeBy = fragment ? "fragment" : "début";
      setPanel({
        video: info.video ? { codec: info.video.codec ?? null, width: info.video.width ?? null, height: info.video.height ?? null, rangeType: info.video.rangeType ?? null } : null,
        container: info.container ?? null,
        master,
        segments: verdict.segments,
        targetS: verdict.targetS,
        version: verdict.version,
        resumeBy,
        cut: verdict.cutFacts?.cut ?? null,
        audioFacts: verdict.audio,
        choices: audio,
        labels,
      });
      reportPlayback(
        "start",
        lumenStartFields(logContext.current, {
          why: fromReload ? "audio-reload" : "open",
          at,
          audioTrack: verdict.audioTrack,
          audioStreamIndex: jellyfinIndexOf(audio, info.audio, verdict.audioTrack),
          audio: audioFacts ? `${audioFacts.codec} ${audioFacts.hlsChannels ?? audioFacts.channels} ${audioFacts.language ?? "und"}` : undefined,
          repairs: audioFacts?.repairs,
          container: info.container,
          video: info.video?.codec ? `${info.video.codec} ${info.video.width}x${info.video.height}` : null,
          range: info.video?.rangeType ?? null,
          lumenSession,
          version: verdict.version,
          segments: verdict.segments,
          targetS: verdict.targetS,
          fragment,
          prepared,
          negotiateMs,
          muxed: mux,
          dialogue: wantDialogue ?? null,
        })
      );
      setSrc(withStartFragment(master, at));
      // La liste maître lue par la page, en arrière-plan : le seul lien sûr entre le menu et `video.audioTracks`
      // (`parseMasterAudio`). Sans elle, un changement de piste passe par le rechargement.
      void fetch(master, { signal: AbortSignal.timeout(10_000) })
        .then((res) => (res.ok ? res.text() : ""))
        .then((text) => {
          if (!abandoned && text) masterAudioRef.current = parseMasterAudio(text);
        })
        .catch(() => {});
    };
    // Après un rechargement pour changer de piste, le démon média d'iOS libère la séance HLS de la page d'avant
    // de façon asynchrone : la même grâce que le lecteur serveur (`PlaybackSession.fromReload`).
    const grace = setTimeout(() => void open(), fromReload ? 3000 : 0);
    return () => {
      abandoned = true;
      clearTimeout(grace);
    };
    // Une fois par hôte : un épisode, une ouverture, un hôte (clé `lumen:${itemId}:${openId}`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── L'élément : l'adresse posée, la première image, les erreurs, la fin ─────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let firstPictureHere = false;
    const settled = srcSetRef.current;
    // Le chien de garde : vingt secondes de page visible sans image. Page cachée, rien ; au retour, vingt
    // pleines (la règle du lecteur serveur depuis le 08/11/2026).
    const arm = () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        if (document.visibilityState === "hidden" || firstPictureHere) return;
        // Une réouverture sans image en vingt secondes : la même règle qu'une erreur — relire le serveur.
        if (pictureRef.current) {
          void recoverRef.current("pas d'image en 20 s après une réouverture");
          return;
        }
        fallToRef.current("natif", "pas d'image en 20 s", { stage: "image", mediaError: mediaErrorText(video.error) });
      }, LUMEN_PICTURE_WATCHDOG_MS);
    };
    arm();
    const onVisibility = () => {
      if (document.visibilityState !== "hidden" && !firstPictureHere && watchdogRef.current) arm();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onLoadedData = () => {
      if (firstPictureHere) return;
      firstPictureHere = true;
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
      // Une réouverture pour changer de piste (§185) : l'image d'avant s'efface sur la nouvelle, la ligne `audio`
      // attend que l'horloge reparte (`onAudioAdvance`) — ou part tout de suite si l'on était en pause.
      const switching = pendingAudioRef.current;
      if (switching) {
        switching.pictureMs = Date.now() - switching.srcAt;
        setFreezeUrl(null);
        if (switching.keepPaused) {
          video.pause();
          finishAudioSwitch(video);
        }
      }
      // Le sous-titre du téléviseur changé (§191) : la ligne `cast` qui le dit, avec le temps de la réouverture.
      const casting = pendingCastSubtitleRef.current;
      if (casting) {
        pendingCastSubtitleRef.current = null;
        if (casting.keepPaused) video.pause();
        reportPlayback(
          "cast",
          lumenCastSubtitleFields(
            logContext.current,
            { subtitles: casting.label, st: casting.st, fromSt: casting.fromSt, at: casting.at, tookMs: Date.now() - casting.srcAt, pictureMs: Date.now() - casting.srcAt },
            lumenSession
          )
        );
      }
      const first = !pictureRef.current;
      pictureRef.current = true;
      sessionPlayedRef.current = true;
      setLoading(false);
      if (first && pendingPlaySessionRef.current) setPlaySession(pendingPlaySessionRef.current);
      // `#t=` ignoré (une version de Safari qui ne le lit pas) : le saut de secours, seulement dans ce cas.
      const wantedAt = settled?.resumeAt ?? 0;
      if (wantedAt > 2 && Math.abs(video.currentTime - wantedAt) > 2) {
        safetySeekRef.current = true;
        video.currentTime = wantedAt;
      }
      // Les `<track>` de cet élément, posés maintenant seulement (voir `tracksFor`) ; leurs modes, dans l'effet qui suit.
      setTracksFor(videoKey);
      if (first && settled) {
        reportPlayback(
          "opening",
          lumenOpeningFields(logContext.current, {
            lumenSession,
            firstMoveMs: Date.now() - mountedAt,
            pictureMs: Date.now() - mountedAt,
            srcToPictureMs: Date.now() - settled.at,
            at: settled.resumeAt,
            landedAt: video.currentTime,
            reopened: false,
            steps: `adresse ${settled.fragment ? "#t=" : "sans fragment"} → image ${Date.now() - settled.at} ms`,
          })
        );
      }
    };
    const onError = () => {
      const mediaError = mediaErrorText(video.error);
      const code = video.error?.code ?? 0;
      if (!firstPictureHere && !pictureRef.current) {
        // Avant toute image : une relance (un 503 « occupé » que Safari n'a pas réessayé), puis le lecteur actuel.
        if (code !== 4 && retryOpening(`erreur ${mediaError ?? "?"} avant l'image`)) return;
        fallToRef.current("natif", `refus de l'élément avant l'image (${mediaError ?? "?"})`, { stage: "élément", mediaError });
        return;
      }
      // Le sous-titre du téléviseur (§191) : la liste rouverte avec `?st=` échoue avant son image — dit, puis la
      // règle d'après l'image (`recover`, un élément neuf ; l'effet de la diffusion reposera `st` s'il le faut).
      const castingSubtitle = pendingCastSubtitleRef.current;
      if (castingSubtitle && !firstPictureHere) {
        pendingCastSubtitleRef.current = null;
        reportPlayback(
          "cast",
          lumenCastSubtitleFields(
            logContext.current,
            { subtitles: castingSubtitle.label, st: castingSubtitle.st, fromSt: castingSubtitle.fromSt, at: castingSubtitle.at, tookMs: Date.now() - castingSubtitle.srcAt, error: mediaError ?? "erreur" },
            lumenSession
          )
        );
      }
      // Une réouverture pour changer de piste qui échoue avant son image : dite telle quelle, puis la règle
      // d'après l'image — un élément neuf, sur la piste voulue (`currentAudioRef`).
      const switching = pendingAudioRef.current;
      if (switching && !firstPictureHere) {
        pendingAudioRef.current = null;
        setFreezeUrl(null);
        reportPlayback(
          "audio",
          lumenAudioFields(
            logContext.current,
            { ...switching, via: "réouverture", applied: false, tookMs: Date.now() - switching.startedAt0, first: `${switching.first ?? ""} ; erreur ${mediaError ?? "?"}`.replace(/^ ; /, "") },
            lumenSession
          )
        );
      }
      // Après l'image : le serveur relu, puis l'élément rouvert sur ce chemin (redémarrage, version changée — 410) ;
      // le lecteur serveur seulement si le fichier n'est plus servi ou si les réouvertures bouclent (`recover`).
      // Pas de ligne `error` : rien n'est affiché, la ligne `rebuild` de la réouverture dit l'erreur et sa suite.
      void recoverRef.current(`erreur de l'élément (${mediaError ?? "?"})`);
    };
    const finishAudioSwitch = (element: HTMLVideoElement) => {
      const done = pendingAudioRef.current;
      if (!done) return;
      pendingAudioRef.current = null;
      const list = (element as HTMLVideoElement & { audioTracks?: ArrayLike<AudioTrackLike> }).audioTracks;
      const now = list ? Array.from({ length: list.length }, (_, i) => list[i]) : [];
      const heard = enabledAudioNumber(now, masterAudioRef.current);
      reportPlayback(
        "audio",
        lumenAudioFields(
          logContext.current,
          {
            from: done.from,
            to: done.to,
            fromTrack: done.fromTrack,
            toTrack: done.toTrack,
            via: "réouverture",
            // Safari ne dit pas toujours quelle piste joue : sans réponse, la piste DEFAULT de la liste rouverte.
            applied: heard === null || heard === done.to,
            tookMs: Date.now() - done.startedAt0,
            at: done.at,
            processing: done.processing,
            first: done.first,
            pictureMs: done.pictureMs,
            frozen: done.frozen,
            dialogue: done.dialogue,
          },
          lumenSession
        )
      );
      // Un changement de force (« Améliorer les dialogues », §193) garde la piste : dit comme tel dans le panneau.
      if (done.from === done.to && done.dialogue) {
        const name = done.dialogue === "strong" ? "player.dialogue.further" : done.dialogue === "on" ? "player.dialogue.enhance" : "player.dialogue.off";
        noteEventRef.current(t("player.info.lumen.eventDialogue", { mode: t(name), ms: Date.now() - done.startedAt0 }));
      } else noteEventRef.current(t("player.info.lumen.eventAudio", { track: done.toTrack, via: "réouverture", ms: Date.now() - done.startedAt0 }));
    };
    // L'horloge repartie après la réouverture : le changement est fini pour le spectateur.
    const onAudioAdvance = () => {
      const switching = pendingAudioRef.current;
      if (switching?.pictureMs !== undefined && video.currentTime - switching.at >= 0.3) finishAudioSwitch(video);
    };
    const playAllowingGesture = () => {
      if (pendingAudioRef.current?.keepPaused || pendingCastSubtitleRef.current?.keepPaused) return;
      video.play().catch((e: unknown) => {
        // La politique de lecture automatique d'iOS (une page rechargée n'a pas de geste) : pause propre, un appui.
        if (e instanceof DOMException && e.name === "NotAllowedError") setLoading(false);
      });
    };
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("error", onError);
    video.addEventListener("timeupdate", onAudioAdvance);
    video.src = src;
    video.load();
    playAllowingGesture();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("error", onError);
      video.removeEventListener("timeupdate", onAudioAdvance);
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    };
    // `src` et la clé de l'élément : chaque adresse posée (ouverture, relance) réarme tout.
  }, [src, videoKey, lumenSession, mountedAt, retryOpening, t]);

  // ── Les sauts, les attentes, les blocages — le journal et le bilan ──────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let seekSince: SeekStart | null = null;
    /** La ligne d'un saut arrivé, écrite quand l'horloge repart (ou en pause, ou au bout de 10 s). */
    let pendingSeek: { fields: Record<string, unknown>; landed: number; startedAt: number; at: number } | null = null;
    const flushSeek = (advanceMs?: number) => {
      const held = pendingSeek;
      pendingSeek = null;
      if (held) reportPlayback("seek", { ...held.fields, ...(advanceMs !== undefined ? { advanceMs: Math.round(advanceMs) } : {}) });
    };
    const onSeeking = () => {
      if (!pictureRef.current) return;
      if (safetySeekRef.current) {
        safetySeekRef.current = false;
        return;
      }
      flushSeek();
      tallyRef.current.waitAbandoned();
      const now = Date.now();
      const superseded = seeks.takeMeasure();
      if (superseded) {
        reportPlayback(
          "seek",
          lumenSeekFields(logContext.current, { ...superseded, tookMs: seekElapsed(tallyRef.current, superseded), landedAt: video.currentTime, superseded: true }, lumenSession)
        );
      }
      const to = video.currentTime;
      seeks.startMeasure({ from: lastKnownTime.current, to, startedAt: now, hiddenAtStart: tallyRef.current.hiddenMsSoFar(now), ...describeBufferedAround(video.buffered, to) });
      seekSince ??= seekStart(tallyRef.current, now);
    };
    const onSeeked = () => {
      const timing = seeks.seeked(video.currentTime);
      if (seekSince !== null) {
        tallyRef.current.seekArrived(seekElapsed(tallyRef.current, seekSince));
        seekSince = null;
      }
      if (!timing) return;
      pendingSeek = {
        fields: lumenSeekFields(logContext.current, { ...timing, tookMs: seekElapsed(tallyRef.current, timing), landedAt: video.currentTime, arrived: true }, lumenSession),
        landed: video.currentTime,
        startedAt: timing.startedAt,
        at: Date.now(),
      };
      if (video.paused) flushSeek();
    };
    const onTimeUpdate = () => {
      if (pendingSeek && (video.currentTime - pendingSeek.landed >= 0.3 || Date.now() - pendingSeek.at > 10_000)) {
        flushSeek(video.currentTime - pendingSeek.landed >= 0.3 ? Date.now() - pendingSeek.startedAt : undefined);
      }
    };
    const onWaiting = () => {
      if (pictureRef.current && !video.seeking && seekSince === null) tallyRef.current.waitStarted(Date.now());
    };
    const onPlaying = () => {
      tallyRef.current.waitEnded(Date.now());
      background.notePlaying();
    };
    /**
     * La reprise après une pause : la sortie audio de l'iPhone s'endort pendant la pause et met ~0,45 s à se réveiller,
     * l'image repartant sans attendre (enregistrement d'écran du 17/11/2026). Sous l'essai de l'appareil « Garder le son
     * éveillé pendant la pause » (`lumenKeepAwakeOn`, coupé par défaut), un son inaudible la garde éveillée (voir
     * `audioKeepAwake.ts`) ; coupé, rien : un simple `play()`, comme les autres lecteurs.
     */
    const onPlay = () => {
      keepAwakeRef.current?.release();
    };
    const onPause = () => {
      if (!video.ended && pictureRef.current && document.visibilityState === "visible" && lumenKeepAwakeOn()) (keepAwakeRef.current ??= new AudioKeepAwake()).start();
      tallyRef.current.waitEnded(Date.now());
      background.notePaused(Date.now(), { visible: document.visibilityState === "visible", ended: video.ended });
      if (pendingSeek) flushSeek();
    };
    // L'horloge figée en lecture : la ligne `stall` à 5 s (une par minute), le relais au lecteur serveur à 35 s
    // si le réseau répond ; hors ligne, l'écran « interrompue » à la borne d'une coupure (48 s, `networkOutage.ts`).
    let last = { t: video.currentTime, at: Date.now() };
    let stallLineAt = 0;
    let stallReported = false;
    const stallTimer = setInterval(() => {
      const now = Date.now();
      if (!pictureRef.current || video.paused || video.ended || video.seeking || document.visibilityState === "hidden" || closedRef.current || fellRef.current) {
        last = { t: video.currentTime, at: now };
        stallReported = false;
        return;
      }
      if (Math.abs(video.currentTime - last.t) > 0.05) {
        last = { t: video.currentTime, at: now };
        stallReported = false;
        return;
      }
      const stuckMs = now - last.at;
      if (stuckMs >= LUMEN_STALL_LINE_MS && !stallReported && now - stallLineAt >= STALL_LINE_EVERY_MS) {
        stallReported = true;
        stallLineAt = now;
        let lead: number | null = null;
        for (let i = 0; i < video.buffered.length; i++) {
          if (video.buffered.start(i) <= video.currentTime + 0.1 && video.buffered.end(i) >= video.currentTime) lead = video.buffered.end(i) - video.currentTime;
        }
        reportPlayback(
          "stall",
          lumenStallFields(
            logContext.current,
            { position: video.currentTime, stalledMs: stuckMs, readyState: video.readyState, networkState: video.networkState, seeking: video.seeking, videoBuffered: bufferedText(video.buffered), lead, onLine: navigator.onLine },
            lumenSession,
            tallyRef.current.backgroundFacts(now)
          )
        );
      }
      // Figée 35 s : Safari n'a pas su reprendre seul (il réessaie ses segments pendant un redémarrage du serveur,
      // et repart souvent avant). Le serveur relu, la lecture rouverte sur ce chemin (`recover`) — tant que
      // l'horloge reste figée : repartie entre-temps, rien n'est touché.
      if (stuckMs >= LUMEN_STALL_RECOVER_MS && !errorRef.current) {
        const frozenAt = video.currentTime;
        void recoverRef.current(`lecture figée ${Math.round(stuckMs / 1000)} s`, { stalled: () => !video.paused && Math.abs(video.currentTime - frozenAt) < 0.05 });
        last = { t: video.currentTime, at: now };
      }
    }, 1000);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    return () => {
      clearInterval(stallTimer);
      flushSeek();
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("play", onPlay);
    };
  }, [src, videoKey, seeks, background, lumenSession, t]);

  // ── Le retour d'arrière-plan (§24) : c'est une lecture, pas une diffusion ─────────────────────────────
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      const video = videoRef.current;
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        background.hide(hiddenAt, video);
        return;
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      const hold = background.show(Date.now(), away, video);
      // Pendant AirPlay, c'est le téléviseur qui lit : le retour du téléphone au premier plan ne le met pas en pause.
      if (video && hold && !castActiveRef.current) {
        try {
          video.pause();
          video.currentTime = hold.at;
        } catch {
          // L'élément n'a plus de source : rien à retenir.
        }
      }
    };
    // La relance de WebKit au déverrouillage, refusée tant qu'aucun geste ne l'a demandée.
    const onPlay = (event: Event) => {
      if (event.target !== videoRef.current || castActiveRef.current || !background.refusePlay(Date.now())) return;
      videoRef.current?.pause();
    };
    const onGesture = () => background.noteGesture(Date.now());
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("play", onPlay, true);
    document.addEventListener("pointerdown", onGesture, true);
    document.addEventListener("keydown", onGesture, true);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("play", onPlay, true);
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
    };
  }, [background]);

  // ── Fermeture, épisode suivant, fin ─────────────────────────────────────────────────────────────────
  const handleAdvance = useCallback(() => {
    advanceTo(nextEpisode, { over: closedRef.current, reportStop: () => reportStop("next"), stopReporting: stopPlaybackNow, playback });
  }, [nextEpisode, playback, stopPlaybackNow, reportStop]);
  const handlePlayEpisode = useCallback(
    (episode: { itemId: string; title: string; resumeAt: number }) => {
      advanceTo(episode, { over: closedRef.current || episode.itemId === itemId, reportStop: () => reportStop("next"), stopReporting: stopPlaybackNow, playback });
    },
    [itemId, playback, stopPlaybackNow, reportStop]
  );
  const handleClose = useCallback(() => {
    closePlayerSession({
      claim: () => claimOnce(closedRef),
      leaveFullscreen: true,
      reportStop: () => reportStop("close"),
      stopReporting: stopPlaybackNow,
      // Sans image, la séance HLS coupée : retiré de la page en plein chargement, iOS continuait de demander les
      // segments (26/10/2026) — ici, autant de remultiplexage serveur pour rien.
      release: () => {
        const video = videoRef.current;
        if (!video || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
        try {
          releaseHlsElement(video);
        } catch {
          // Déjà démonté.
        }
      },
      setClosing,
      playback,
      openId: session.openId,
      itemId,
      refresh: !isSceneRef.current(),
    });
  }, [playback, stopPlaybackNow, itemId, session.openId, reportStop]);
  usePlayerBackClose(handleClose);
  useServerStopOnLeave({ bench, stopFields, stopAlreadySent, reportStop, logContext, closedRef, handedOverRef, tallyRef });
  useServerTimeline(itemId, videoRef, lastKnownTime, linkMeterRef, logSession);
  useServerPositionWatch(videoRef, videoKey, itemId, bench, castResume, lastKnownTime, tallyRef, isSceneRef);
  const castWasRef = useRef(false);
  const setCastActiveNoted = useCallback(
    (value: boolean | ((previous: boolean) => boolean)) => {
      const active = typeof value === "function" ? value(castWasRef.current) : value;
      if (active !== castWasRef.current) noteEvent(t(active ? "player.info.lumen.eventCastOn" : "player.info.lumen.eventCastOff", { at: formatTime(videoRef.current?.currentTime ?? 0) }));
      castWasRef.current = active;
      setCastActive(active);
    },
    [noteEvent, t]
  );
  // AirPlay (§186) : la route établie et sa fin au journal (`cast`, `fallback` `cast: true`), l'état pour les commandes.
  useCastRoute({
    videoRef,
    videoKey,
    castSession: false,
    castAttempted: castAttemptedRef,
    closingRef: closedRef,
    castActiveRef,
    setCastActive: setCastActiveNoted,
    logContext,
    watched,
    castResume,
    markHandedOver,
    lastKnownTime,
    lastPlaybackOpts: lastPlaybackOptsRef,
  });

  const hasNextEpisode = nextEpisode !== null && mode !== "mini";
  const endStoppedRef = useRef(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    function onEnded() {
      if (!hasNextEpisode) {
        handleClose();
        return;
      }
      endStoppedRef.current = true;
      void stopPlaybackNow();
      holdAtEnd();
    }
    function onPlay() {
      setPlaying(true);
      if (!endStoppedRef.current) return;
      endStoppedRef.current = false;
      resumePlaybackSession();
    }
    const onPause = () => setPlaying(false);
    video.addEventListener("ended", onEnded);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    const unwatch = watchElementWaits(video, watched);
    return () => {
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      unwatch();
    };
  }, [handleClose, videoKey, hasNextEpisode, stopPlaybackNow, resumePlaybackSession, holdAtEnd, watched]);
  useWatchedClockRun(watched, playing);
  useWakeLock(playing);

  // Démonté : les minuteries de l'hôte.
  useEffect(() => () => clearTimers(), [clearTimers]);

  useEffect(() => {
    if (!loading) {
      const clear = setTimeout(() => setLoadingLong(false), 0);
      return () => clearTimeout(clear);
    }
    const timer = setTimeout(() => setLoadingLong(true), 3000);
    return () => clearTimeout(timer);
  }, [loading]);
  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // ── Les pistes son : `audioTracks` d'abord, sinon la liste rouverte dans la page (§185) ─────────────────
  /**
   * La réouverture pour changer de piste, sur **le même élément** : l'adresse de la liste maître avec la nouvelle
   * piste (`?audio=N`, son rendu DEFAULT) à la position exacte (`#t=`), la préparation du serveur lancée avant
   * (segment son de reprise construit, ou converti, pendant que Safari relit les listes ; les segments vidéo,
   * `immutable`, reviennent du cache du navigateur), et l'image d'avant figée par-dessus jusqu'à la première
   * image de la nouvelle séance — ni écran noir, ni commandes remontées, ni sous-titres perdus (les `<track>`
   * restent sur l'élément, leurs modes reposés à `loadeddata`). Une erreur avant cette image : `recover`, qui
   * rouvre sur un élément neuf (la règle des réouvertures, §180).
   */
  const reopenForAudio = useCallback(
    (change: Omit<PendingAudio, "startedAt" | "srcAt" | "frozen" | "keepPaused">, opts: { master?: string } = {}) => {
      const video = videoRef.current;
      // `master` : une autre liste maître (« Améliorer les dialogues » allumé ou coupé, §193) ; sinon celle posée.
      const master = opts.master ?? masterRef.current;
      if (!video || !master || closedRef.current || fellRef.current) return;
      const target = new URL(master, window.location.href);
      target.searchParams.set("audio", String(change.to));
      const next = `${target.pathname}${target.search}`;
      // La préparation d'abord : sans attendre sa réponse, elle construit le segment de reprise de la nouvelle piste —
      // traité par le serveur quand la liste sert les rendus « dialogues ».
      const dialogue = target.searchParams.get("dialogue");
      void fetch(`/api/lumen/${itemId}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: change.to, position: change.at, s: lumenSession, ...(dialogue ? { dialogue } : {}) }),
        keepalive: true,
      }).catch(() => {});
      const frozen = freezeFrame(video);
      if (frozen) setFreezeUrl(frozen);
      pendingAudioRef.current = { ...change, startedAt: change.startedAt0, srcAt: Date.now(), frozen: frozen !== null, keepPaused: video.paused };
      masterRef.current = next;
      srcSetRef.current = { at: Date.now(), resumeAt: change.at, fragment: change.at > 0 };
      lastKnownTime.current = change.at;
      setSrc(withStartFragment(next, change.at));
      // Une autre liste maître : ses rendus ont d'autres URI (et parfois d'autres `NAME`) — relue, comme à l'ouverture,
      // pour relier encore le menu à `audioTracks`.
      if (opts.master) {
        void fetch(next, { signal: AbortSignal.timeout(10_000) })
          .then((res) => (res.ok ? res.text() : ""))
          .then((text) => {
            if (text && masterRef.current === next) masterAudioRef.current = parseMasterAudio(text);
          })
          .catch(() => {});
      }
    },
    [itemId, lumenSession]
  );

  /**
   * Le sous-titre du téléviseur (§191) : la liste maître rouverte **sur le même élément** (celui que la route AirPlay
   * tient), à la position, avec `?st=<index>` — ou sans, pour le retirer. Le téléviseur reçoit la nouvelle adresse et
   * dessine le rendu qu'elle porte (DEFAULT=YES). Les `<track>` de la page sont retirés avant que l'adresse ne soit
   * posée (un `<track>` présent à ce moment fait refuser l'élément, code 4) et reviennent à l'image suivante, comme à
   * l'ouverture. Ni image figée ni ligne `rebuild` : le téléphone n'est qu'une télécommande, et ce n'est pas une panne.
   */
  const reopenForCastSubtitle = useCallback(
    (st: number | null, label: string | null) => {
      const video = videoRef.current;
      const master = masterRef.current;
      if (!video || !master || closedRef.current || fellRef.current || pendingAudioRef.current) return;
      const at = positionNow();
      const next = withCastSubtitle(master, st);
      pendingCastSubtitleRef.current = { st, fromSt: castSubtitleCarried(master), label, at, srcAt: Date.now(), keepPaused: video.paused };
      masterRef.current = next;
      srcSetRef.current = { at: Date.now(), resumeAt: at, fragment: at > 0 };
      lastKnownTime.current = at;
      setTracksFor(-1);
      setSrc(withStartFragment(next, at));
    },
    [positionNow]
  );

  // ── Le sous-titre au téléviseur (§191) ─────────────────────────────────────────────────────────────
  // Pendant une diffusion, l'adresse que tient l'élément porte le sous-titre choisi (`?st=`), et rien d'autre ; hors
  // diffusion, on n'y touche pas (une adresse qui porte encore `st` après la fin d'une diffusion est sans effet : ses
  // pistes du flux restent éteintes, ci-dessous, et la prochaine réouverture la garde telle quelle).
  const castWanted = castSubtitleWanted(currentSubtitleId, externalSubtitleTracks);
  const castWantedLabel = castWanted === null ? null : (externalSubtitleTracks.find((st) => st.index === castWanted)?.label ?? null);
  /** Le téléviseur dessine un sous-titre du flux : la diffusion établie, sur une adresse qui en porte un. */
  const tvShowsSubtitle = castActive && castSubtitleCarried(src) !== null;
  const carriedSubtitle = castSubtitleCarried(src);
  /** Pour le panneau : l'étiquette du sous-titre que le téléviseur dessine, ou null. */
  const tvSubtitleLabel = tvShowsSubtitle && carriedSubtitle !== null ? (externalSubtitleTracks.find((st) => st.index === carriedSubtitle)?.label ?? String(carriedSubtitle)) : null;
  useEffect(() => {
    if (!castActive || !pictureRef.current || pendingCastSubtitleRef.current) return;
    if (castSubtitleCarried(masterRef.current) === castWanted) return;
    // Hors du corps de l'effet (la règle du compilateur React : pas d'état posé pendant l'effet).
    const timer = setTimeout(() => reopenForCastSubtitle(castWanted, castWantedLabel), 0);
    return () => clearTimeout(timer);
  }, [castActive, castWanted, castWantedLabel, reopenForCastSubtitle, src]);
  // Les pistes du flux (le rendu de sous-titres d'une adresse `?st=`) : `showing` pendant la diffusion — la sélection
  // du lecteur de WebKit, que la route AirPlay porte au téléviseur avec l'adresse —, `disabled` partout ailleurs, pour
  // que Safari ne dessine jamais rien sous notre calque. Reposés à chaque piste ajoutée et à chaque chargement.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    const apply = () => {
      applyInbandModes(video, tvShowsSubtitle);
    };
    apply();
    const list = video.textTracks as (TextTrackList & EventTarget) | undefined;
    list?.addEventListener?.("addtrack", apply);
    video.addEventListener("loadedmetadata", apply);
    video.addEventListener("loadeddata", apply);
    return () => {
      list?.removeEventListener?.("addtrack", apply);
      video.removeEventListener("loadedmetadata", apply);
      video.removeEventListener("loadeddata", apply);
    };
  }, [src, videoKey, tvShowsSubtitle]);

  const changeAudio = useCallback(
    (id: number) => {
      const video = videoRef.current;
      const from = currentAudioRef.current;
      if (!video || id === from || pendingAudioRef.current) return;
      const facts = audioFactsRef.current.find((a) => a.number === id);
      if (!facts) return;
      if (!bench) noteSeriesLanguage(itemId, toJellyfinLanguage(trackLanguage(facts)));
      reportPositionNow();
      tallyRef.current.audioSwitched();
      const startedAt0 = Date.now();
      const at = positionNow();
      const fromTrack = from === null ? "" : (audioLabelsRef.current.get(from) ?? String(from));
      const toTrack = audioLabelsRef.current.get(id) ?? String(id);
      const served = servedDialogueRef.current;
      // Sous « Améliorer les dialogues » servi (§193), la nouvelle piste passe traitée si elle a son rendu, sinon telle
      // quelle — la liste maître la sert ainsi, et le menu dit « Sans effet sur cette piste audio ».
      const processing = processingOf(facts, served);
      const dialogue = served ?? undefined;
      const jellyfinIndex = jellyfinIndexOf(audioFactsRef.current, jellyfinAudioRef.current, id);
      // Une piste que le serveur ne sert pas (conversion du son coupée, file pleine) : le lecteur serveur.
      if (!facts.servable) {
        reportPlayback("audio", lumenAudioFields(logContext.current, { from, to: id, fromTrack, toTrack, via: "refus", applied: false, tookMs: 0, at, processing: "non servie" }, lumenSession));
        fallToRef.current("serveur", `piste audio non servie (${facts.codec})`, { takeover: { resumeAt: at, audioStreamIndex: jellyfinIndex } });
        return;
      }
      currentAudioRef.current = id;
      setCurrentAudioId(id);
      // (1) Un rendu du groupe : `enabled`, aucune nouvelle séance HLS (~1,6 à 1,9 s au banc du 16/11). Depuis le
      // format 5, toutes les pistes sont dans le groupe, codecs différents compris.
      const list = (video as HTMLVideoElement & { audioTracks?: ArrayLike<AudioTrackLike> }).audioTracks;
      const items = list ? Array.from({ length: list.length }, (_, i) => list[i]) : [];
      const position = items.length ? audioTrackPosition(items, masterAudioRef.current, id) : -1;
      if (position < 0) {
        reopenForAudio({ from, to: id, at, fromTrack, toTrack, processing, startedAt0, first: list ? "piste absente d'audioTracks" : "audioTracks indisponible", dialogue });
        return;
      }
      // Allumer d'abord, éteindre ensuite : jamais un instant sans son.
      items[position].enabled = true;
      items.forEach((track, i) => {
        if (i !== position && track.enabled) track.enabled = false;
      });
      // `applied` : une piste que le navigateur refuse laisse jouer l'autre (CLAUDE.md, ligne `audio`) — et iOS 26
      // revient parfois à la piste DEFAULT (forum Apple 818465). Non appliqué au bout de 2 s : la réouverture.
      const settle = setTimeout(() => {
        if (currentAudioRef.current !== id || closedRef.current || fellRef.current) return;
        const now = Array.from({ length: list?.length ?? 0 }, (_, i) => list![i]);
        const applied = enabledAudioNumber(now, masterAudioRef.current) === id;
        if (applied) {
          reportPlayback("audio", lumenAudioFields(logContext.current, { from, to: id, fromTrack, toTrack, via: "audioTracks", applied, tookMs: Date.now() - startedAt0, at, processing, dialogue }, lumenSession));
          noteEvent(t("player.info.lumen.eventAudio", { track: toTrack, via: "audioTracks", ms: Date.now() - startedAt0 }));
          return;
        }
        reopenForAudio({ from, to: id, at: positionNow(), fromTrack, toTrack, processing, startedAt0, first: "audioTracks sans effet en 2 s", dialogue });
      }, AUDIO_SETTLE_MS);
      audioSettleRef.current = settle;
    },
    [bench, itemId, lumenSession, positionNow, reportPositionNow, reopenForAudio, noteEvent, t]
  );
  useEffect(() => () => {
    if (audioSettleRef.current) clearTimeout(audioSettleRef.current);
  }, []);

  // ── Les sous-titres : les `<track>` en `hidden`, les lignes par le calque de la page (§190) ────────────
  // Les modes et les lignes sont tenus par `useLumenSubtitleLines`, depuis l'état : l'ouverture, une réouverture (ses
  // `<track>` reposés après sa première image), un choix, deux sous-titres et le passage rejoué passent tous par là.
  const changeSubtitle = useCallback(
    (id: number | null) => {
      const video = videoRef.current;
      if (!video) return;
      reportPositionNow();
      const second = secondSubtitleRef.current;
      const wasDual = second !== null;
      if (second !== null && !secondSurvives(id, second)) {
        secondSubtitleRef.current = null;
        setSecondSubtitleId(null);
      }
      if (id !== currentSubtitleRef.current) setSubtitleOffset(0);
      currentSubtitleRef.current = id;
      subtitleSwitchesRef.current += 1;
      setCurrentSubtitleId(id);
      if (wasDual) rememberDual(subtitleFactsOf(externalSubtitleTracks, id), subtitleFactsOf(externalSubtitleTracks, secondSubtitleRef.current));
    },
    [externalSubtitleTracks, reportPositionNow]
  );
  const changeSecondSubtitle = useCallback(
    (id: number | null) => {
      const primary = currentSubtitleRef.current;
      if (!secondAllowed(id, primary)) return;
      reportPositionNow();
      subtitleSwitchesRef.current += 1;
      if (id !== secondSubtitleRef.current) setSecondOffset(0);
      secondSubtitleRef.current = id;
      setSecondSubtitleId(id);
      rememberDual(subtitleFactsOf(externalSubtitleTracks, primary), subtitleFactsOf(externalSubtitleTracks, id));
    },
    [externalSubtitleTracks, reportPositionNow]
  );
  // Le passage rejoué (§150) : la piste que l'aide montrerait, montrée sur la voie du principal sans rien retenir.
  const replayTrack = useCallback((): number | null => {
    const audio = audioFactsRef.current.find((a) => a.number === currentAudioRef.current) ?? null;
    return pickReplaySubtitle({
      tracks: externalSubtitleTracks.map((st) => ({ ...subtitleFacts(st), id: st.index, text: st.isText !== false })),
      current: currentSubtitleRef.current,
      second: secondSubtitleRef.current,
      audioLanguage: audio ? trackLanguage(audio) : null,
      accountLanguages: [preferencesRef.current?.subtitleLanguage, locale],
    });
  }, [externalSubtitleTracks, locale]);
  const showReplay = useCallback((id: number | null) => setReplayId(id), []);
  const replaySubtitle = useMemo(() => ({ track: replayTrack, show: showReplay }), [replayTrack, showReplay]);
  const subtitleTrackIds = useMemo(() => externalSubtitleTracks.map((st) => st.index), [externalSubtitleTracks]);
  // La voie du principal : l'aide d'un passage rejoué le temps du passage (sans décalage, sauf si c'est la piste
  // choisie, dont le décalage vaut), sinon la piste choisie. Une génération en cours n'a pas de `<track>` : rien ici.
  const primaryLane = useMemo(
    () => (replayId !== null ? { id: replayId, offset: replayId === currentSubtitleId ? subtitleOffset : 0 } : { id: currentSubtitleId, offset: subtitleOffset }),
    [replayId, currentSubtitleId, subtitleOffset]
  );
  const secondLane = useMemo(() => ({ id: secondSubtitleId, offset: secondOffset }), [secondSubtitleId, secondOffset]);
  const subtitleLines = useLumenSubtitleLines({ videoRef, videoKey, ready: tracksFor === videoKey, trackIds: subtitleTrackIds, primary: primaryLane, second: secondLane });
  const dualActive = currentSubtitleId !== null && secondSubtitleId !== null;
  // « Générer des sous-titres » (§187) : la génération du lecteur natif ; ses lignes, tant qu'il n'y a pas de fichier,
  // par le calque de sous-titres de la page ; à la fin, la piste générée devient un `<track>`, choisie à sa place.
  const refreshSubtitleTracks = useCallback(
    async (wanted: ExternalSubtitleSource) => {
      const pistes = await fetchPistes(itemId);
      if (closedRef.current) return;
      const tracks = serverSubtitleTracks(textSubtitles(pistes.subtitleTracks), locale, t);
      // Présentée par Jellyfin : un index de la liste (`-1 - index`, la règle des fichiers à côté du film) ; le repli
      // du serveur (un fichier gardé chez lui) : son adresse, en piste à part.
      const index = -1 - wanted.id;
      const final =
        tracks.find((st) => st.index === index) ??
        ({ index: wanted.id, url: wanted.url, label: `${languageName(wanted.language, locale) ?? wanted.language ?? "?"} — ${t("player.trackLabel.generated")}`, language: wanted.language, title: null, isDefault: false } as ExternalSubtitleTrack);
      const next = tracks.some((st) => st.index === final.index) ? tracks : [...tracks, final];
      setExternalSubtitleTracks(next);
      currentSubtitleRef.current = final.index;
      setCurrentSubtitleId(final.index);
      reportPlayback("subtitle-gen", { ...logContext.current, event: "piste-finale", index: final.index });
    },
    [itemId, locale, t]
  );
  const subtitleGen = useLumenSubtitleGeneration({
    itemId,
    enabled: !bench && !scene.active,
    videoRef,
    positionNow,
    logFields: () => ({ itemId, player: "lumen-serveur", lumenSession }),
    externals,
    locale,
    t,
    currentId: currentSubtitleId,
    offset: subtitleOffset,
    onFinal: (source) => void refreshSubtitleTracks(source),
    onFailed: () => {
      currentSubtitleRef.current = null;
      setCurrentSubtitleId(null);
    },
    onWarning: setWarning,
  });
  useEffect(() => {
    if (!warning) return;
    const clear = setTimeout(() => setWarning(null), 6000);
    return () => clearTimeout(clear);
  }, [warning]);
  const subtitleTracks = useMemo<Track[]>(
    () => [
      ...externalSubtitleTracks.map((st) => ({ id: st.index, label: st.label })),
      ...subtitleGen.view.entries.map((entry) => ({
        id: entry.track.number,
        label: `${languageName(entry.track.language, locale) ?? entry.track.language ?? "?"} — ${t("player.trackLabel.generating")}`,
        ...(entry.detail ? { detail: entry.detail } : {}),
      })),
    ],
    [externalSubtitleTracks, subtitleGen.view.entries, locale, t]
  );
  const generationMenuProps = useMemo(
    () =>
      bench || (subtitleGen.view.targets.length === 0 && subtitleGen.view.resumable.length === 0)
        ? undefined
        : {
            targets: subtitleGen.view.targets,
            busy: subtitleGen.state.requesting !== null,
            onGenerate: (code: string) =>
              subtitleGen.request(code, (id) => {
                // L'entrée temporaire devient la piste choisie : les `<track>` éteints (aucune n'est plus choisie), la
                // ligne de la génération par le calque.
                if (secondSubtitleRef.current !== null) {
                  secondSubtitleRef.current = null;
                  setSecondSubtitleId(null);
                }
                if (id !== currentSubtitleRef.current) setSubtitleOffset(0);
                currentSubtitleRef.current = id;
                setCurrentSubtitleId(id);
              }),
            resumable: subtitleGen.view.resumable,
            onResume: (code: string) => void subtitleGen.generation.resume(code),
          },
    [bench, subtitleGen]
  );

  // « Diffuser » (§186) : AirPlay depuis l'élément même — le sélecteur ouvert dans le geste, et l'Apple TV lit l'adresse
  // munie du laissez-passer (`tv.{jeton}`), à la position, sans changer de lecteur. Un sous-titre de texte affiché va au
  // téléviseur dans le flux (§191) : la liste rouverte avec `?st=` dès la route établie (`reopenForCastSubtitle`). Une
  // génération en cours (pas encore de fichier ; les pistes en images ne sont pas au menu de ce chemin), ou sans
  // sélecteur AirPlay (un autre navigateur) : le lecteur serveur prend la main pour diffuser comme avant —
  // `cast: true`, un choix et non un échec.
  // Deux sous-titres : le téléviseur ne montre que le principal (comme le lecteur serveur, qui n'en incruste qu'un).
  const requestCast = useCallback(() => {
    const video = videoRef.current as (HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void }) | null;
    const subtitle = currentSubtitleRef.current;
    const tokenized = masterRef.current?.includes("/tv.") === true;
    if (video && tokenized && castStaysOnLumen(subtitle, externalSubtitleTracks) && typeof video.webkitShowPlaybackTargetPicker === "function") {
      try {
        video.webkitShowPlaybackTargetPicker();
        return;
      } catch {
        // Refusé (activation perdue) : le lecteur serveur, comme avant.
      }
    }
    const facts = subtitleFactsOf(externalSubtitleTracks, subtitle);
    const castSubtitle = subtitle !== null && facts ? { index: subtitle, language: toJellyfinLanguage(trackLanguage(facts)), forced: facts.isForced } : undefined;
    fallToRef.current("serveur", "diffusion demandée", { planned: true, cast: true, takeover: { ...takeoverNow(), cast: true, ...(castSubtitle ? { castSubtitle } : {}) } });
  }, [externalSubtitleTracks, takeoverNow]);

  // « Améliorer les dialogues » quand le serveur ne peut pas le servir (§188) : le réglage est retenu, et la lecture est
  // rendue au lecteur actuel, à la position, qui fait le traitement dans la page — `declineLumen` tient ce titre à
  // l'écart de ce chemin pour le reste de la page.
  const handBackForDialogue = useCallback(
    (why: string) => {
      if (closedRef.current || fellRef.current) return;
      const at = positionNow();
      fellRef.current = true;
      clearTimers();
      reportPlayback(
        "fallback",
        lumenFallbackFields(
          logContext.current,
          { to: "natif", planned: true, reason: lumenReason(`améliorer les dialogues demandé (${why})`), watched: watched.take(Date.now()), stage: "lecture" },
          lumenSession,
          tallyRef.current.backgroundFacts(Date.now())
        )
      );
      markHandedOver();
      void stopPlaybackNow();
      try {
        if (videoRef.current) releaseHlsElement(videoRef.current);
      } catch {
        // Déjà démonté.
      }
      declineLumen(itemId);
      reopenAt(playback, { itemId, title, resumeAt: at });
    },
    [positionNow, clearTimers, watched, lumenSession, markHandedOver, stopPlaybackNow, itemId, playback, title]
  );

  /**
   * « Améliorer les dialogues » (§193) : le serveur traite le son (`DialogueEnhancer` sur son PCM, encodé en E-AC-3) et
   * sert ses rendus par une autre liste maître (`?dialogue=on|strong`). Changer de force, c'est changer de liste — la
   * réouverture d'un changement de piste (§185) : même élément, image d'avant figée, `prepare` lancé avant, une ligne
   * `audio` (`dialogue`, `processing`). Allumer demande d'abord le verdict (la piste a-t-elle son rendu, le serveur
   * admet-il une lecture de plus qui convertit) ; sans, la règle d'avant : la lecture rendue au lecteur actuel.
   * Couper ne demande rien au serveur : la liste ordinaire, celle d'à côté. Le réglage de l'appareil est écrit
   * d'abord, quoi qu'il arrive : c'est lui que les deux lecteurs relisent.
   */
  const chooseDialogue = useCallback(
    (next: DialogueMode) => {
      writeDialogueMode(next);
      dialogueModeRef.current = next;
      setDialogueMode(next);
      if (closedRef.current || fellRef.current) return;
      const served = servedDialogueRef.current;
      if ((served ?? "off") === next || dialogueSwitchingRef.current || pendingAudioRef.current) return;
      const id = currentAudioRef.current;
      const facts = audioFactsRef.current.find((a) => a.number === id);
      const label = id === null ? "" : (audioLabelsRef.current.get(id) ?? String(id));
      const startedAt0 = Date.now();
      if (next === "off") {
        // Couper : la liste ordinaire (sans `dialogue`), à la même piste.
        const master = masterRef.current;
        if (!served || !master || id === null || !facts) return;
        const plain = new URL(master, window.location.href);
        plain.searchParams.delete("dialogue");
        servedDialogueRef.current = null;
        setServedDialogue(null);
        reopenForAudio({ from: id, to: id, at: positionNow(), fromTrack: label, toTrack: label, processing: processingOf(facts, null), startedAt0, first: "dialogues coupés", dialogue: "off" }, { master: `${plain.pathname}${plain.search}` });
        return;
      }
      // La piste n'a pas de rendu traité (AAC, FLAC…, ou l'option coupée sur le serveur) : le lecteur actuel.
      if (id === null || !facts?.dialogue) {
        handBackForDialogue(facts ? `${facts.codec} sans rendu serveur` : "aucune piste");
        return;
      }
      dialogueSwitchingRef.current = true;
      void (async () => {
        try {
          const verdict = await fetchVerdict(itemId, lumenSession, id, false, next);
          if (closedRef.current || fellRef.current || currentAudioRef.current !== id || dialogueModeRef.current !== next) return;
          if ("failed" in verdict || !verdict.ok || !verdict.dialogue?.served) {
            const why = "failed" in verdict ? verdict.failed : !verdict.ok ? (verdictRefusal(verdict) ?? "refus") : verdict.dialogue && !verdict.dialogue.served ? verdict.dialogue.reason : "non servi";
            handBackForDialogue(why);
            return;
          }
          servedDialogueRef.current = next;
          setServedDialogue(next);
          reopenForAudio({ from: id, to: id, at: positionNow(), fromTrack: label, toTrack: label, processing: processingOf(facts, next), startedAt0, first: `dialogues ${next}`, dialogue: next }, { master: verdict.master });
        } finally {
          dialogueSwitchingRef.current = false;
        }
      })();
    },
    [handBackForDialogue, itemId, lumenSession, positionNow, reopenForAudio]
  );

  // « Réessayer » sur l'écran d'erreur : un élément neuf à la position connue (`retry`), même si la relance
  // automatique a déjà servi — c'est un geste du spectateur.
  const handleRetry = useCallback(() => {
    retriedRef.current = false;
    if (pictureRef.current) void recoverRef.current("réessayer", { force: true });
    else if (!retryOpening("réessayer")) fallToRef.current("natif", "réessayer sans adresse", { stage: "image" });
  }, [retryOpening]);

  const handleExpand = useCallback(() => playback.expand(), [playback]);
  const { pos, size, isDragging, handlers } = useMiniPlayerDrag(mode === "mini", handleExpand);
  const resizing = useViewportResizing();
  usePlayerFocus(containerRef, mode === "full");

  // Le panneau ouvert : ce que l'appareil a reçu (Resource Timing) et le relevé du serveur, relus toutes les 3 s (§189).
  useEffect(() => {
    if (!showPlaybackInfo) return;
    let gone = false;
    const read = () => {
      setReceived(receivedOf(lumenSession));
      void fetch(`/api/lumen/${itemId}/chrono?s=${encodeURIComponent(lumenSession)}&stats=1`, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? (res.json() as Promise<Record<string, number | string>>) : null))
        .then((stats) => {
          if (!gone && stats) setServerStats(stats);
        })
        .catch(() => {});
    };
    const first = setTimeout(read, 0);
    const timer = setInterval(read, 3000);
    return () => {
      gone = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [showPlaybackInfo, itemId, lumenSession]);

  // Le traitement s'applique-t-il à ce qu'on entend ? Coupé, la question ne se pose pas ; allumé, seulement si la liste
  // posée sert les rendus traités et que la piste choisie en a un (§193).
  const dialogueApplies = dialogueMode === "off" || (servedDialogue !== null && !!panel?.choices.find((a) => a.number === currentAudioId)?.dialogue);

  const panelData = useMemo<PlaybackPanelData | null>(() => {
    if (!panel) return null;
    const audioNow = currentAudioId === null ? null : (panel.audioFacts.find((a) => a.number === currentAudioId) ?? null);
    const choice = currentAudioId === null ? null : (panel.choices.find((a) => a.number === currentAudioId) ?? null);
    const described = describeLumenServerPlayback(
      {
        video: panel.video,
        container: panel.container,
        audio: audioNow && choice ? { label: panel.labels.get(audioNow.number) ?? String(audioNow.number), codec: audioNow.codec, processing: processingOf(choice, servedDialogue), repairs: audioNow.repairs } : null,
        version: panel.version,
        cut: panel.cut,
        segments: panel.segments,
        targetS: panel.targetS,
        resumeBy: panel.resumeBy,
        lumenSession,
        received,
        server: serverStats,
        events,
        airplay: castActive,
        // Le sous-titre que le téléviseur dessine depuis le flux (§191) : celui que porte l'adresse tenue.
        airplaySubtitles: castActive ? tvSubtitleLabel : undefined,
      },
      t
    );
    return {
      ...described,
      report: { error: null, elapsedMs: null, title, itemId, file: { master: panel.master.replace(/\/tv\.[^/]+\//, "/tv.…/"), version: panel.version }, pathReason: t("player.info.lumen.name"), diagnostics: {}, running: true },
    };
  }, [panel, title, itemId, lumenSession, currentAudioId, servedDialogue, received, serverStats, events, castActive, tvSubtitleLabel, t]);

  function toggleMiniPlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }

  // Les bandes noires incrustées dans le fichier (§188) : l'image agrandie jusqu'au bord le plus proche, sans rien couper —
  // la mesure par trickplay du lecteur natif (`useFrameFit`), posée sur le cadre de l'élément. Pas dans le mini-lecteur.
  const frameFitState = useFrameFit(itemId, mode !== "mini", containerRef, videoRef);

  if (typeof document === "undefined") return null;
  const isMini = mode === "mini";
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
        transition: isDragging || resizing ? "none" : PLAYER_FRAME_TRANSITION,
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
        transition: resizing ? "opacity 200ms ease-out" : `${PLAYER_FRAME_TRANSITION}, opacity 200ms ease-out`,
        opacity: closing ? 0 : 1,
      };

  return createPortal(
    <div data-player-frame data-player="lumen-serveur" ref={containerRef} style={style} className={isMini ? "animate-fade-in-scale" : "app-viewport"} {...(isMini ? handlers : {})}>
      {/* `preload="auto"` (levier 1 : Safari charge listes, init et premiers segments dès l'adresse posée). */}
      {/* Deux cadres autour de l'image, comme le lecteur natif : l'extérieur coupe ce qui déborde, l'intérieur porte
          l'agrandissement des bandes noires (§188) — l'image figée d'une réouverture le suit. */}
      <div data-player-picture className="relative h-full w-full overflow-hidden">
        <div className="relative h-full w-full" style={frameFitState.style}>
          <video
            // Un élément neuf à chaque adresse reposée (relance, réouverture) : WebKit tient une séance HLS par élément.
            // Clés préfixées : la vidéo et les commandes sont sœurs, une même clé les confondait (deux `<video>` restaient).
            key={`video-${videoKey}`}
            ref={videoRef}
            playsInline
            autoPlay
            preload="auto"
            className={isMini ? "h-full w-full object-cover" : "h-full w-full"}
            // AirPlay ouvert (§186) : l'adresse porte le laissez-passer d'une Apple TV, qui n'a pas de cookie.
            {...{ "x-webkit-airplay": "allow" }}
          >
            {tracksFor === videoKey && externalSubtitleTracks.map((st) => (
              <track key={st.index} kind="subtitles" src={st.url} srcLang={st.language ?? undefined} label={st.label} />
            ))}
          </video>
          {/* L'image d'avant, figée pendant une réouverture pour changer de piste (§185) : ni écran noir ni à-coup. */}
          {freezeUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- une image `data:` de la page, éphémère : rien à optimiser.
            <img src={freezeUrl} alt="" aria-hidden className={`pointer-events-none absolute inset-0 ${isMini ? "h-full w-full object-cover" : "h-full w-full object-contain"}`} />
          )}
        </div>
      </div>
      {/* Les sous-titres, toujours par le calque de la page (§190) : jamais en mini-lecteur ni sous l'écran d'erreur.
          Deux sous-titres ; sinon l'aide d'un passage rejoué ; sinon une génération en cours ; sinon la piste choisie. */}
      {!isMini && !error && !tvShowsSubtitle && dualActive && (
        <SubtitleLayer dual primary={subtitleLines.primary} second={subtitleLines.second} style={subtitleStyle} chromeEdges={chromeEdges} />
      )}
      {!isMini && !error && !tvShowsSubtitle && !dualActive && replayId === null && isGeneratingTrack(currentSubtitleId) && subtitleGen.line && (
        <SubtitleLayer primary={subtitleGen.line.text} primaryNotice={subtitleGen.line.notice} style={subtitleStyle} chromeEdges={chromeEdges} />
      )}
      {!isMini && !error && !tvShowsSubtitle && !dualActive && (replayId !== null || !isGeneratingTrack(currentSubtitleId)) && subtitleLines.primary && (
        <SubtitleLayer primary={subtitleLines.primary} style={subtitleStyle} chromeEdges={chromeEdges} />
      )}
      {warning && !error && !isMini && <NativeWarning text={warning} />}
      {error && !isMini && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 px-6 text-center">
          <div>
            <p className="mb-4 text-sm text-danger">{error}</p>
            <div className="flex justify-center gap-3">
              <button type="button" onClick={handleClose} className="btn btn-ghost px-4 py-2">
                {t("player.quit")}
              </button>
              <button type="button" onClick={handleRetry} className="btn-primary inline-flex justify-center">
                {t("common.retry")}
              </button>
            </div>
          </div>
        </div>
      )}
      {!error && !isMini && !introCovering && (isOffline || (loading && loadingLong)) && (
        <ServerWaitPill isOffline={isOffline} seekHint={undefined} compatPrep={false} castSubtitlePrep={false} loadingLong={loadingLong} hlsJs={false} />
      )}
      <ServerPlayerIntro
        key={`${session.openId ?? 0}:${itemId}`}
        session={session}
        allowed
        loading={loading}
        trouble={!!error}
        hidden={isMini}
        resumeSeconds={session.resumeAt ?? null}
        videoRef={videoRef}
        onCoverChange={setIntroCovering}
        note={isOffline ? t("player.offline") : loading && loadingLong ? t("player.stillLoading") : null}
        onClose={handleClose}
      />
      {!isMini && (
        <PlayerControls
          key={`controls-${videoKey}`}
          videoRef={videoRef}
          containerRef={containerRef}
          itemId={itemId}
          title={title}
          onClose={handleClose}
          onMinimize={playback.minimize}
          onTogglePlaybackInfo={() => setShowPlaybackInfo((v) => !v)}
          onCastRequest={requestCast}
          castActive={castActive}
          audioTracks={audioTracks}
          currentAudioId={currentAudioId}
          onChangeAudio={changeAudio}
          subtitleTracks={subtitleTracks}
          currentSubtitleId={currentSubtitleId}
          onChangeSubtitle={changeSubtitle}
          // Les décalages tenus par l'hôte (§190) : les commandes ne déplacent plus les répliques des `<track>`.
          subtitleOffset={{ seconds: subtitleOffset, onShift: (delta) => setSubtitleOffset((now) => Math.round((now + delta) * 10) / 10) }}
          secondSubtitle={{ currentId: secondSubtitleId, onChange: changeSecondSubtitle, offset: { seconds: secondOffset, onShift: (delta) => setSecondOffset((now) => Math.round((now + delta) * 10) / 10) } }}
          replaySubtitle={replaySubtitle}
          subtitleGeneration={generationMenuProps}
          frameFit={frameFitState.available ? { on: frameFitState.on, onChange: frameFitState.setOn } : undefined}
          // « Améliorer les dialogues » (§193) : la force de l'appareil ; « Sans effet » quand la liste sert le traitement mais que
          // la piste choisie n'a pas de rendu traité (elle est servie telle quelle).
          dialogue={bench ? undefined : { mode: dialogueMode, applies: dialogueApplies, onChange: chooseDialogue }}
          hidden={!!error}
          loading={loading}
          openingQuiet={introCovering}
          onChromeEdges={setChromeEdges}
          introSkip={introSkip}
          recapSkip={recapSkip}
          creditsStart={creditsStart}
          nextEpisode={nextEpisode}
          onPlayEpisode={scene.active || bench ? undefined : handlePlayEpisode}
          onAdvance={handleAdvance}
          onSeekRequest={(seconds) => seeks.request(seconds)}
          positionNow={positionNow}
          logoUrl={logoUrl}
        />
      )}
      {!isMini && <PlaybackInfoPanel open={showPlaybackInfo} onClose={() => setShowPlaybackInfo(false)} data={panelData} />}
      {isMini && !error && <MiniPlayerChrome title={title} playing={playing} onTogglePlay={toggleMiniPlay} onClose={handleClose} />}
    </div>,
    document.body
  );
}
