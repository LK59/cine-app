"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { playerBootstrapOptions } from "@/lib/swr";
import { advanceTo, closePlayerSession } from "@/components/player/playerClose";
import { directInfoForOpening } from "@/lib/directInfo";
import { labSampleByFile, labSampleInfo } from "@/lib/labSamples";
import { directInfoKey, fetchPlaybackState, takePrefetchedPlaybackState } from "@/lib/playbackPrefetch";
import { errorMessage, isUpstreamUnreachable } from "@/lib/upstreamError";
import { usePlayback } from "@/components/PlaybackProvider";
import { PlayerControls, type SecondSubtitleMenu, type SubtitleGenerationMenu } from "@/components/PlayerControls";
import { restoreRememberedVolume } from "@/lib/rememberedVolume";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { usePlayerFocus } from "@/lib/usePlayerFocus";
import { isPlayerWarning } from "@/lib/webcodecs/playerWarning";
import { SubtitleLayer } from "@/components/player/SubtitleLayer";
import { dualSubtitleMemory, pickRememberedDual, rememberDual } from "@/lib/dualSubtitles";
import {
  autoHdrCap,
  displayIsHdr,
  displayIsWideGamut,
  hdrCapRelevant,
  hdrLightCap,
  readHdrCapChoice,
  writeHdrCapChoice,
  type HdrCapChoice,
} from "@/lib/webcodecs/hdrDisplay";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { useSceneMode } from "@/lib/sceneMode";
import { PLAYBACK_CLIENTS } from "@/lib/playbackClients";
import { useViewportResizing } from "@/lib/useViewportResizing";
import { useT, useLocale } from "@/components/TranslationProvider";
import { probePlaybackPath, type RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";
import { NATIVE_PATH } from "@/lib/webcodecs/pathSelector";
import { trace, traceKeepAcrossReset, traceRecent } from "@/lib/webcodecs/trace";
import {
  diagLinkMeasure,
  diagNeedBps,
  diagCurrentWait,
  diagWaitEnded,
  diagWaitStarted,
} from "@/lib/webcodecs/playbackDiagnosis";
import { BackgroundWatch } from "@/lib/backgroundReturn";
import { isNetworkFailure } from "@/lib/webcodecs/byteSource";
import { reportPlayback } from "@/lib/reportPlayback";
import { usePlayerServerFallback } from "@/lib/usePlayerEnabled";
import {
  SLOW_LINK_REASON,
  armOpeningMeter,
  disarmOpeningMeter,
  fileNeedBps,
  frozenReading,
  readLink,
  type LinkMeter,
  type LinkReading,
  type SlowLink,
} from "@/lib/slowLink";
import type { StableTakeover } from "@/lib/useStableFallback";
import { useChromecast, useChromecastAllowed } from "@/lib/chromecast/useChromecast";
import { chromecastSnapshot, requestChromecastSession } from "@/lib/chromecast/framework";
import type { ReportInput } from "@/components/ExperimentalPlayerReport";
import { PlaybackInfoPanel } from "@/components/PlaybackInfoPanel";
import { PlayerEndScreen } from "@/components/player/PlayerEndScreen";
import { useShareMode } from "@/components/ShareMode";
import { openLibraryTitle } from "@/lib/cinemaRoute";
import { subtitleStyleStore, type ChromeEdges } from "@/lib/subtitleStyle";
import { useFrameFit } from "@/lib/frameFit";
import { readDialogueMode, writeDialogueMode } from "@/lib/dialoguePreference";
import type { DialogueMode } from "@/lib/webcodecs/dialogueEnhance";
import { openingPosition } from "@/lib/resumeRewind";
import { habitWatch, recordsResume } from "@/components/player/session/habitWatch";
import { describeRemuxPlayback } from "@/lib/playbackPanel";
import type { PlayerTrack } from "@/lib/webcodecs/playerTrack";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import type { PlaybackState } from "@/app/api/jellyfin/playback-state/[itemId]/route";
import {
  ExternalSubtitleTrack,
  isExternalTrack,
  toPlayerTrack as externalToPlayerTrack,
  type ExternalSubtitleSource,
} from "@/lib/webcodecs/externalSubtitles";
import { chooseAudioTrack, chooseSubtitleTrack, toJellyfinLanguage, trackLanguage } from "@/lib/trackPreferences";
import { noteSeriesLanguage } from "@/lib/noteSeriesLanguage";
import { isGeneratingTrack, SubtitleGeneration } from "@/lib/subtitleGen/generation";
import { useWakeLock } from "@/lib/useWakeLock";
import { useSleepTimer } from "@/lib/useSleepTimer";
import type { SleepMode } from "@/lib/sleepTimer";
import { seekArrived } from "@/lib/webcodecs/seekArrival";
import { SessionTally, WatchedClock, newPlayerSessionId, watchElementWaits } from "@/lib/playerSessionTally";
import { positionBucket, retryMotif, retrySignature } from "@/lib/retryLedger";
import { clearUnsentStop } from "@/lib/unsentStop";
import { forgetResumeCache, openDiskChunks, openingFacts } from "@/lib/resumeCache/diskChunks";
import { MemoryReserve, reservePlanFacts } from "@/lib/webcodecs/memoryReserve";
import { PlayerLifecycle } from "@/lib/playerLifecycle";
import { notePceCopyWorked, pceDecisionFacts, takePceCopyRefusal } from "@/lib/webcodecs/aacPceProbe";
import { HostSeek, describeBufferedAround, type SeekTiming } from "@/lib/hostSeek";
import { PlaybackIntro, type IntroPhase } from "@/components/player/PlaybackIntro";
import { usePlaybackQuality } from "@/lib/playbackQuality";
import { prewarmFields } from "@/lib/lighterPrewarm";
import { ZoneHandover } from "@/lib/unreadableZoneHandover";
import { isUnreadableZoneReason, zoneSecondsOf } from "@/lib/webcodecs/unreadableZone";
import { formatTime } from "@/lib/playerClock";
import { playsHlsNatively } from "@/lib/webkitEngine";
import { pickMaxBitrate } from "@/lib/networkBitrate";
import { SlowLinkRunner } from "@/lib/slowLinkRunner";
import {
  PLAYBACK_MEASURE_WINDOW_MS,
  SlowLog,
  StutterWatch,
  playbackLinkSlow,
} from "@/lib/slowLinkPolicy";
import { networkUnstable } from "@/lib/networkTrouble";
import { StallSignals } from "@/components/player/session/stallSignals";
import { saveUnsentPosition } from "@/lib/unsentPosition";
import { finishIntro, introAllowedFor, introCaption, introFinished, introKey, startIntroClock } from "@/lib/playbackIntro";
import { useIntroPlaybackStarted } from "@/lib/introEnd";
import { usePlayerBackClose } from "@/lib/playerHistory";
import { useAudioLabels, useElapsedSince, useSubtitleLabels } from "@/components/playerNative/nativeHostHooks";
import { nativeFrameStyle } from "@/components/playerNative/nativeFrameStyle";
import { useNativeBenchBridge } from "@/components/playerNative/useNativeBenchBridge";
import { useNativeSessionRecord } from "@/components/playerNative/useNativeSessionRecord";
import { useNativeSlowLink } from "@/components/playerNative/useNativeSlowLink";
import { useNativeSubtitleLanes } from "@/components/playerNative/useNativeSubtitleLanes";
import { useNativeSubtitleGeneration } from "@/components/playerNative/useNativeSubtitleGeneration";
import { useNativeRecovery } from "@/components/playerNative/useNativeRecovery";
import {
  CenterWord,
  NativeErrorScreen,
  NativeWarning,
  NetworkLostScreen,
  OpeningSpinner,
  SlowLinkScreen,
  StuckReport,
} from "@/components/playerNative/NativeOverlays";
import {
  aacRouteFacts,
  generationMenu,
  jellyfinAudioIndex,
  leadAt,
  rebuildLine,
  seekElapsed,
  seekLineFields,
  syncFacts,
  warmNextNear,
} from "@/components/player/nativeHostHelpers";

/** How long a threshold has to be crossed before anything is shown at all. */
const SPINNER_AFTER_MS = 120;

/** Patience de la roue au tout premier départ, sur une image déjà montrée — voir `openingGrace`. */
const OPENING_SPINNER_GRACE_MS = 1200;

/**
 * And before the wait is worth a sentence, then before it is worth admitting it is long.
 *
 * Three seconds, not one. A film that opens in a second and a half is not a film that kept
 * anybody waiting, and a word that appears and goes before it has been read is noise — it draws
 * the eye to a delay that had gone unnoticed until it announced itself.
 */
const WORD_AFTER_MS = 3000;
const STILL_WORKING_AFTER_MS = 8000;

/** And before a wait stops being slow and starts being a fault worth reporting. */
const STUCK_AFTER_MS = 20000;

/**
 * How long a passing notice stays on screen.
 *
 * Long enough to read a sentence, short enough that it cannot be mistaken for a lasting state.
 */
const WARNING_MS = 6000;

// Le budget de reconstructions, le saut au-delà d'un passage fautif et « le même endroit » vivent
// désormais dans `playerLifecycle.ts`, avec les décisions qui s'en servent.

/** Le plus longtemps qu'une image figée reste à l'écran, quoi qu'il arrive. */
const FREEZE_MAX_MS = 4000;

/**
 * The native player: the same chrome as the stable one, over a <video> element fed by the remuxer
 * (MediaSource) instead of an HLS stream transcoded by the server.
 *
 * A file it cannot carry, or a failure it cannot recover from, is handed to the server player
 * (`fallToStable`), with the reason written to the record — never repaired silently, so the record
 * always says which files this path cannot handle. The controls are the stable player's,
 * unmodified: here they drive a real media element.
 */
export function ExperimentalPlayerHost({
  session,
  mode,
  onFallback,
}: {
  session: NonNullable<ReturnType<typeof usePlayback>["session"]>;
  mode: "full" | "mini";
  onFallback: (reason: string, takeover?: StableTakeover, sessionId?: string) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  // Pour les phrases écrites depuis le pipeline : ses gestionnaires sont construits par un effet
  // qu'il ne faut pas reconstruire au changement de langue — ils lisent la traduction par ici.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const playback = usePlayback();
  const { itemId, title: openedAs } = session;
  /**
   * Un invité d'un lien de partage (DECISIONS.md §112) : ni génération de sous-titres, ni Chromecast
   * — la porte des liens les refuse de toute façon ; ici, on ne les demande pas. Faux pour un compte
   * du foyer (`ShareMode`), et alors rien ne change.
   */
  const shareMode = useShareMode();

  const videoElRef = useRef<HTMLVideoElement>(null);
  /**
   * Une scène ouverte depuis une réplique (`sceneMode.ts`, DECISIONS.md §91) : ni battement, ni
   * arrêt, ni position gardée, ni octets pour une reprise, ni épisode suivant, tant que dix minutes
   * n'ont pas été jouées. `isSceneRef` pour les écouteurs de l'élément, posés une fois pour toutes.
   */
  const scene = useSceneMode(
    session,
    useCallback(() => {
      const video = videoElRef.current;
      return !!video && !video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    }, [])
  );
  const isSceneRef = useRef(scene.isScene);
  useEffect(() => {
    isSceneRef.current = scene.isScene;
  }, [scene.isScene]);
  const sceneLogFields = scene.logFields;
  // Le volume mémorisé, rendu une fois à l'élément. Il est monté avec l'hôte et gardé tel quel :
  // une reconstruction ne change que le pipeline, un passage plein écran ↔ réduit que son cadre.
  // Ce lecteur ne le relisait pas — chaque film repartait à plein volume. DECISIONS.md §35.
  useEffect(() => {
    restoreRememberedVolume(videoElRef.current);
  }, []);
  const remuxRef = useRef<RemuxPlayback | null>(null);
  /** La réserve d'avance en mémoire du lecteur en cours — voir `MemoryReserve`. */
  const reserveRef = useRef<MemoryReserve | null>(null);
  /** Le dernier élément vidéo du pipeline, pour `syncFacts` — voir `reportStop`. */
  const lastVideoElRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Semée au point de reprise plutôt qu'à zéro : fermer pendant le chargement rapportait sinon
  // un arrêt à 0:00, ce qui effaçait chez Jellyfin la position qu'on venait justement de vouloir
  // reprendre. `?? 0` et non la position du serveur : laisser zéro est ce qui permet au calcul de
  // `startSeconds` plus bas de retomber sur `playbackState`, quand la séance ne portait rien.
  const positionRef = useRef(session.resumeAt ?? 0);
  /** La position d'ouverture a été décidée — voir le recul de reprise dans `startSeconds`. */
  const openingDecidedRef = useRef(false);
  /**
   * Si `positionRef` dit où en est cette lecture, ou seulement ce qu'on lui a demandé.
   *
   * Tant que la position de départ n'est pas résolue, elle peut valoir zéro pour « demander au
   * serveur » — et la transmettre à un relais l'aurait changée en « depuis le début ».
   */
  const positionKnownRef = useRef(false);
  /** `announced`, lisible depuis `fallToStable` qui ne doit dépendre de rien. */
  const everReadyRef = useRef(false);
  /**
   * La reconstruction en cours vient-elle d'un refus de copie d'un AAC à PCE ? Une seule par chaîne :
   * si le pipeline reconstruit est refusé à son tour avant d'avoir donné une image, on ne
   * reconstruit plus pour ce motif (chasse aux défauts du 11/10/2026, B1 : un stockage qui refusait
   * d'écrire le refus faisait recopier, et refuser, sans fin). Remise à faux par la première image.
   */
  const pceRebuildRef = useRef(false);
  /** `takeoverNow`, pour `fallToStable` qui est déclaré avant lui et doit rester stable. */
  const takeoverNowRef = useRef<() => StableTakeover | undefined>(() => undefined);

  const [ready, setReady] = useState(false);
  // Lu par la mesure des reprises, dans un rappel de la source posé une fois.
  const readyRef = useRef(false);
  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);
  /**
   * Prêt au moins une fois : la séance Jellyfin commence là, et ne finit qu'avec le lecteur.
   *
   * Elle suivait `ready`, que chaque reconstruction rabaisse — et une reconstruction est devenue
   * un geste ordinaire : changer pour une piste d'un autre format, revenir d'un iPhone verrouillé,
   * se remettre d'une coupure. Chacune envoyait à Jellyfin un arrêt puis une nouvelle lecture :
   * des séances fantômes dans son activité, et « en cours » qui clignotait (relu le 22/09/2026).
   */
  const [announced, setAnnounced] = useState(false);
  // Only failures that happen *during* playback are state. The two that are already known from
  // the fetch — the server refusing the file, and the fetch itself failing — are derived below,
  // because pushing them into state from an effect is both a cascading render and a second
  // source of truth for the same fact.
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  /**
   * La connexion trop lente qui a arrêté l'ouverture, avec ses chiffres pour l'écran (§77). Ne vaut
   * que tant que l'erreur affichée est la sienne : toute reconstruction efface `runtimeError`, et
   * l'écran redevient l'ordinaire sans qu'il faille penser à vider celui-ci.
   */
  const [slowLink, setSlowLink] = useState<SlowLink | null>(null);
  /**
   * Ce que l'ouverture dit du lien pendant qu'elle charge (§78, `openingAdvice`) : l'indice
   * « Connexion lente… », et la mesure qui l'a décidé. Pour cette ouverture-ci (`at` = son
   * `openedAt`) : daté plutôt que remis à zéro, une reconstruction le rend caduc.
   */
  const [slowSignal, setSlowSignal] = useState<{ at: number; hint: boolean; recvBps: number | null; needBps: number | null }>(
    { at: 0, hint: false, recvBps: null, needBps: null }
  );
  /**
   * Le fil de ce que la lenteur a fait paraître et fait faire (§78) — porté par les lignes `opening`,
   * `stall`, `stop`, et celles du renoncement ou de la bascule, jamais par une ligne de plus.
   */
  const [slowLog] = useState(() => new SlowLog());
  const slowFields = useCallback((): Record<string, string> => slowLog.fields(), [slowLog]);
  /** Les saccades en pleine lecture (§78) : quand basculer sur la version allégée. */
  const [stutter] = useState(() => new StutterWatch());
  /** « Connexion perdue ou instable… » : des tentatives échouent, ou le navigateur est hors ligne. */
  const [unstable, setUnstable] = useState(() => networkUnstable());
  /**
   * Le début de la mesure de l'ouverture : `openedAt`, ou le retour au premier plan s'il est venu
   * après — une mesure prise en arrière-plan ne vaut rien (minuteurs bridés, réseau mis en veille),
   * et aucun verdict ne se prononce sur elle (§78). Le compteur est réarmé à cet instant.
   */
  const [measureEpoch, setMeasureEpoch] = useState(0);
  /**
   * Un saut sans image depuis plus de 10 s est traité comme une ouverture (§78) : indice,
   * préchauffage et bascule, ou l'écran du renoncement à 35 s. `at` : l'instant du saut.
   */
  const [seekSignal, setSeekSignal] = useState<{ at: number; hint: boolean; recvBps: number | null; needBps: number | null } | null>(null);
  /** La bascule en pleine lecture — posée par un effet plus bas, appelée par les écouteurs du pipeline. */
  const offerStutterRef = useRef<(kind: "long" | "repeated") => void>(() => {});
  /**
   * L'exécution des décisions (§78, `slowLinkRunner.ts`, commune aux deux lecteurs) : le préchauffage
   * tenu, et le saut qui attend son image. Ce qu'elle lit de ce lecteur lui est rattaché plus bas.
   */
  const [runner] = useState(() => new SlowLinkRunner());
  /** La décision en pleine lecture, rappelée quand un préchauffage de saccades est prêt. */
  const playbackDecisionRef = useRef<(triggered?: boolean, early?: boolean) => void>(() => {});
  /** Le compteur de l'ouverture en cours — voir l'effet qui l'arme, avant celui du pipeline. */
  const openingMeterRef = useRef<LinkMeter | null>(null);
  /** Le débit moyen du fichier, d'après sa description — ce que le lien doit tenir. */
  const needBpsRef = useRef<number | null>(null);
  /** Le lien tel que le panneau technique le montre en direct (§77) — lu avec les diagnostics. */
  const [linkLive, setLinkLive] = useState<LinkReading | null>(null);
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

  /**
   * Les décisions d'ouverture et de reconstruction — voir `playerLifecycle.ts`. Un objet par
   * lecteur, créé une fois : l'état de montage (`useState`) le garde d'un rendu à l'autre sans
   * qu'aucun rendu ne l'écrive.
   */
  const [lifecycle] = useState(() => new PlayerLifecycle({ startPaused: session.startPaused === true }));
  /**
   * Cette séance, de l'ouverture au démontage, reconstructions comprises : son identifiant, porté
   * par chacune de ses lignes, et le décompte qui fait son bilan — voir `SessionTally`.
   */
  const [sessionId] = useState(newPlayerSessionId);
  const [tally] = useState(() => new SessionTally());
  // Déclaré ici pour `fallToStable`, qui le reporte sur sa ligne — voir `WatchedClock`.
  const [watched] = useState(() => new WatchedClock());
  /**
   * The record's view of what is playing, read through refs.
   *
   * `fallToStable` must stay stable for the life of the player — a caller passing an inline arrow
   * once turned every render into a rebuilt pipeline — so it cannot close over any of this
   * directly. These are filled in by effects below, once there is something to describe.
   */
  const describeFileRef = useRef<() => Record<string, unknown>>(() => ({}));
  const pathRef = useRef<"remux" | null>(null);
  // Read through a ref so this function is stable for the life of the player. The pipeline is
  // built by an effect that depends on it, and a caller passing an inline arrow — which the one
  // above did — turned every one of its own renders into a teardown and a rebuild.
  const onFallbackRef = useRef(onFallback);
  useEffect(() => {
    onFallbackRef.current = onFallback;
  }, [onFallback]);
  // Read through a ref for the same reason as the callback above: `fallToStable` must not change
  // identity when the answer arrives, or the pipeline is torn down and rebuilt on the spot.
  const serverFallback = usePlayerServerFallback();
  const serverFallbackRef = useRef(serverFallback);
  useEffect(() => {
    serverFallbackRef.current = serverFallback;
  }, [serverFallback]);
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
   * Renoncer — et ce que « renoncer » veut dire dépend de l'installation.
   *
   * Avec un lecteur serveur, c'est un repli : le fichier lui est confié, le spectateur voit son
   * film et n'a rien à faire. Sans lecteur serveur, il n'y a personne à qui le confier : la
   * raison est toute la réponse, et elle s'affiche. Dans les deux cas elle est écrite au journal
   * d'abord — un renoncement dont personne n'est averti est un renoncement que personne ne
   * corrige, et sur un serveur à dix-huit comptes c'est le seul endroit où il se verra.
   *
   * Le `undefined` de l'attente compte comme « il y en a un » : le seul appelant qui puisse
   * renoncer si tôt est le refus du sélecteur de chemin, et se tromper dans ce sens-là donne un
   * film qui joue par le serveur au lieu d'une erreur — jamais l'inverse.
   */
  // `extra` : des faits de plus pour la ligne — les mesures d'une connexion trop lente (§77).
  const fallToStable = useCallback((reason: string, takeover?: StableTakeover, extra?: Record<string, unknown>) => {
    if (!lifecycle.stepAside()) return;
    // La ligne `fallback` dit comment la séance a fini ici : pas de bilan « perdu » en plus.
    clearUnsentStop(sessionId);
    const file = describeFileRef.current();
    const path = pathRef.current ?? "non décidé";
    // Un extrait de test non plus : le lecteur serveur ouvrirait le film entier, pas l'extrait.
    if (serverFallbackRef.current === false || session.labSample) {
      trace(`abandon : ${session.labSample ? "extrait de test" : "aucun lecteur serveur sur cette installation"} — ${reason}`);
      reportPlayback("error", { ...file, reason, path, ...extra, ...tally.backgroundFacts(Date.now()) });
      setRuntimeError(reason);
      // L'écran de coupure promettait une reprise qui ne viendra plus : l'erreur prend sa place, au
      // lieu de rester cachée dessous (relu le 27/09/2026).
      setNetworkLost(null);
      return;
    }
    // Un renoncement en cours de film emporte où en est le film. Seuls deux appelants passaient
    // un relais — la diffusion et la piste impossible — et tous les autres renoncements en cours
    // de route (moteur à bout de reconstructions, source perdue, 35 s sans image après une
    // reconstruction, bouton de l'écran d'erreur) rouvraient le lecteur stable à la position
    // d'ouverture, sur la piste par défaut : une heure de film rembobinée, dans une autre langue
    // (relu le 22/09/2026). Avant la première image, rien : la séance dit déjà tout — voir
    // `StableTakeover`.
    //
    const handover = takeover ?? (everReadyRef.current ? takeoverNowRef.current() : undefined);
    trace(`repli : passage au lecteur stable — ${reason}`);
    // `cast` à plat : une diffusion demandée n'est pas un échec, et le journal doit pouvoir le dire
    // sans comparer des phrases (voir `seances.ts`). `watched` : ce que ce lecteur-ci a joué avant
    // de passer la main, puisque sa ligne `stop` ne partira pas.
    const now = Date.now();
    reportPlayback("fallback", {
      ...file,
      reason,
      path,
      ...extra,
      ...(handover ? { takeover: handover } : {}),
      ...(handover?.cast ? { cast: true } : {}),
      watched: watched.seconds(now),
      ...tally.backgroundFacts(now),
    });
    // L'identifiant de la séance passe avec le relais, avant la première image comme après : le
    // lecteur serveur écrit ses lignes sous le même, et le journal lit une seule séance au lieu de
    // deux. Le 24/09/2026, une demi-heure de film passée par le serveur se lisait en deux séances,
    // dont une à zéro seconde regardée — et une soirée de diffusion vers la télé, deux heures à zéro.
    onFallbackRef.current(reason, handover, sessionId);
  }, [sessionId, tally, watched, lifecycle, session.labSample]);
  /**
   * A passing notice, with the moment it was raised.
   *
   * The moment matters twice. It is what withdraws the notice on its own, and it is what makes a
   * repeat of the same sentence a new notice rather than an unchanged value that re-arms nothing.
   */
  const [warning, setWarning] = useState<{ text: string; at: number } | null>(null);
  const subtitleStyle = useSyncExternalStore(
    subtitleStyleStore.subscribe,
    subtitleStyleStore.snapshot,
    subtitleStyleStore.serverSnapshot
  );
  /** Ce que les commandes affichées occupent, pour que les sous-titres passent au-dessus — `null` cachées. */
  const [chromeEdges, setChromeEdges] = useState<ChromeEdges | null>(null);

  const showWarning = useCallback((text: string | null) => {
    setWarning(text ? { text, at: Date.now() } : null);
  }, []);
  /**
   * Un avertissement du pipeline : un code, dit dans la langue du spectateur ; le détail
   * technique au journal. Voir `PlayerWarning`.
   */
  const showPipelineWarning = useCallback(
    (warning: unknown) => {
      if (!isPlayerWarning(warning)) return;
      trace(`avertissement : ${warning.code}${warning.detail ? ` — ${warning.detail}` : ""}`);
      showWarning(tRef.current(`player.warnings.${warning.code}`));
    },
    [showWarning]
  );
  const [closing, setClosing] = useState(false);
  /**
   * L'arrivée du lecteur.
   *
   * Il apparaissait d'un coup, en plein écran et en noir, alors qu'il s'en va en fondu. Une
   * entrée qui monte légèrement depuis l'affiche qu'on vient de quitter fait le lien entre les
   * deux écrans, au lieu de les faire se remplacer.
   *
   * Posé à la frame suivante et non au montage : appliquer l'état d'arrivée et l'état d'entrée
   * dans le même rendu ne laisse rien à animer au navigateur.
   */
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const [playing, setPlaying] = useState(false);
  // Tant que ça joue, l'écran reste allumé — voir useWakeLock pour ce que chaque chemin
  // obtient déjà tout seul et ce qu'il n'obtient pas.
  useWakeLock(playing);
  /**
   * Le film est allé jusqu'au bout.
   *
   * Une série enchaîne toute seule ; un film s'arrêtait sur sa dernière image, et il ne restait
   * qu'une croix. Remis à faux dès que la lecture repart — rejouer, ou reculer de quelques
   * secondes, doit rendre l'écran de fin caduc.
   */
  const [ended, setEnded] = useState(false);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  // Mirrored into state from the pipeline so the controls' menus can be driven by props, the way
  // they already are for the stable player.
  const [tracks, setTracks] = useState<{ audio: PlayerTrack[]; subtitles: PlayerTrack[] }>({ audio: [], subtitles: [] });
  const [currentAudio, setCurrentAudio] = useState<number | null>(null);
  /** Le plafond de lumière HDR choisi sur cet appareil — voir `hdrDisplay.ts`. */
  const [hdrCapChoice, setHdrCapChoice] = useState<HdrCapChoice>(readHdrCapChoice);
  /**
   * « Améliorer les dialogues » (bêta, `dialogueEnhance.ts`) — proposé à tous les comptes depuis la
   * v2 (12/10/2026 ; administrateur seulement avant). Le réglage retenu sur l'appareil, et celui que
   * la prochaine ouverture lira (`dialogueOpenRef`). Un pipeline ouvert avec le traitement et qui
   * échoue avant sa première image repart une fois sans lui (`dialogueFellBackRef`) plutôt que de
   * confier le film au lecteur serveur.
   */
  const [dialogueMode, setDialogueMode] = useState<DialogueMode>(readDialogueMode);
  /** Les pistes audio sur lesquelles le traitement a prise, publiées avec les pistes du pipeline. */
  const [dialogueShapeable, setDialogueShapeable] = useState<ReadonlySet<number>>(() => new Set());
  const dialogueOpenRef = useRef<DialogueMode>("off");
  const dialogueFellBackRef = useRef(false);
  useEffect(() => {
    // Avant l'effet qui construit le pipeline (déclaré plus bas, exécuté après dans le même rendu).
    dialogueOpenRef.current = !dialogueFellBackRef.current ? dialogueMode : "off";
  }, [dialogueMode]);
  /**
   * Le réglage n'est proposé que là où il sert — écran SDR, hors WebKit — et « auto » y vaut ce
   * que `autoHdrCap` dit. Lu une fois à l'ouverture : l'écran ne change pas en cours de film, ou
   * alors le film se rouvrira sur le nouveau.
   */
  const [hdrCapContext] = useState(() => {
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const displayHdr = displayIsHdr();
    return { relevant: hdrCapRelevant(userAgent, displayHdr), autoNits: autoHdrCap(userAgent, displayHdr) };
  });
  const [currentSubtitle, setCurrentSubtitle] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Record<string, string>>({});
  // Answered once and kept: none of it changes while the page is open.
  // Whether the native pipeline is running. Null until the file has been examined: the element is
  // mounted from the start — the remux path needs a <video> to attach to — and stays hidden until
  // then.
  const [path, setPath] = useState<"remux" | null>(null);
  // When playback was asked to start, and has not yet. Reported by the pipeline as a measured
  // fact rather than guessed from the platform: on a desktop it clears within a frame, so none
  // of what follows ever appears there.
  const [startingAt, setStartingAt] = useState<number | null>(null);
  /**
   * Une attente de l'élément en pleine lecture — ni ouverture, ni saut, ni reprise après une pause —
   * et si des tentatives réseau ont échoué pendant qu'elle dure (`stallUnstable`, retenu jusqu'à sa
   * fin : le mot ne clignote pas entre deux tentatives). De quoi dire « Connexion perdue ou
   * instable… » sous la roue (§78), ce que seules l'ouverture et la reprise disaient : le 15/10/2026
   * (LECTEUR-4), une coupure figeait l'image plus de trois minutes sans un mot.
   */
  const [stallAt, setStallAt] = useState<number | null>(null);
  const [stallUnstable, setStallUnstable] = useState(false);
  const stallAtRef = useRef<number | null>(null);
  /**
   * La fin du mot d'attente — écrite une fois pour ses deux appelants (23/10/2026, §115) : `restart`,
   * sans condition, et `endStall` (image, pause, saut, fin), seulement si une attente était notée.
   */
  const clearStall = useCallback(() => {
    stallAtRef.current = null;
    setStallAt(null);
    setStallUnstable(false);
  }, []);
  // Why this file is being played the way it is. Kept for the panel on *both* paths: a fallback
  // whose reason is only visible on the path that was not taken explains nothing at all.
  const [pathReason, setPathReason] = useState<string | null>(null);
  // The picture is on the element once the native path is running.
  const onElement = path === "remux";
  // Bumped to build the pipeline again from scratch. iOS takes the media resources back when the
  // page goes to the background, and a MediaSource it has closed cannot be reopened — so coming
  // back from a locked screen means starting over, at the position the viewer left.
  const [rebuildCount, setRebuildCount] = useState(0);
  /**
   * Les sauts vus par l'hôte : la cible demandée pas encore atteinte, et la mesure du saut en cours
   * pour le journal — voir `hostSeek.ts`. Un objet par lecteur, comme `lifecycle`.
   */
  const [seeks] = useState(() => new HostSeek());
  /**
   * Un saut qui n'arrive pas là où il était demandé n'écrivait rien : la ligne ne part qu'à
   * l'arrivée. 2012 sur iPhone (22/09/2026) : une tête passée de 2141 à 1681 s sans une trace.
   * Il est désormais écrit quand un autre geste le remplace, avec l'endroit où il est tombé.
   */
  const reportUnarrivedSeek = (timing: SeekTiming | null, landedAt: number, stillSeeking: boolean, superseded = true) => {
    if (!timing) return;
    // Remplacé par le geste suivant avant son `seeked` : le cas ordinaire d'une rafale. Arrivé
    // s'il était à sa cible — 125 lignes sur 128 « jamais arrivé » à tort le 22/09/2026.
    // Sauf pendant `seeking`, où currentTime vaut déjà la cible avant que rien n'y soit : un
    // saut remplacé en plein chargement se lisait « arrivé ». Là, le verdict n'est pas écrit —
    // l'endroit, si (chasse aux bugs du 22/09/2026).
    reportPlayback("seek", {
      ...describeFileRef.current(),
      ...seekLineFields(tally, timing, {
        ...(stillSeeking ? {} : { arrived: seekArrived(landedAt, timing.to) }),
        ...(superseded ? { superseded: true } : {}),
        landedAt: Math.round(landedAt * 10) / 10,
      }),
    });
  };
  // Lu par le pipeline à travers une `ref` : le nommer dans ses dépendances le reconstruirait à
  // chaque rendu.
  const reportUnarrivedSeekRef = useRef(reportUnarrivedSeek);
  useEffect(() => {
    reportUnarrivedSeekRef.current = reportUnarrivedSeek;
  });
  /** Où en est le film selon ce que le spectateur a demandé, pas seulement selon ce qu'il a vu. */
  const intendedPosition = useCallback((): number => seeks.intendedPosition(videoElRef.current, positionRef.current), [seeks]);
  /**
   * What the viewer chose, so a restart gives it back to them.
   *
   * A pipeline built again is a pipeline that knows nothing: it opens on the file's own default
   * track with no subtitles, which after a network cut means coming back to a film in the wrong
   * language. These outlive the pipeline because they belong to the viewer, not to it.
   */
  const wantedAudioRef = useRef<number | null>(null);
  /**
   * Un changement de piste qui passe par une reconstruction du lecteur : ce qu'il faut pour en
   * rendre compte une fois le nouveau pipeline prêt, et s'il faut le laisser en pause — un
   * spectateur qui change de langue sur un film arrêté ne veut pas qu'il reparte tout seul.
   */
  const pendingSwitchRef = useRef<{ from: number | null; fromLabel: string; to: number; startedAt: number } | null>(null);
  /**
   * Démarrer un changement de piste qui reconstruit : d'où il part, vers où, depuis quand, et la piste
   * voulue retenue pour le pipeline suivant — écrit une fois pour ses deux appelants (23/10/2026,
   * §115) : la piste voulue autre que celle ouverte (ouverture) et le menu. Ce qui les distingue reste
   * à eux : le menu affiche la piste tout de suite (`setCurrentAudio`, l'écart déclaré au §93) et
   * reconstruit sur place pour le spectateur ; l'ouverture demande `mayRebuild()` d'abord.
   */
  const beginAudioSwitch = useCallback((playback: RemuxPlayback, to: number) => {
    pendingSwitchRef.current = {
      from: playback.currentAudioTrack,
      fromLabel: playback.diagnostics["Audio"] ?? "",
      to,
      startedAt: Date.now(),
    };
    wantedAudioRef.current = to;
  }, []);
  // « Rester en pause » vit dans `lifecycle.keepPaused` : vrai d'emblée au retour d'une diffusion
  // arrêtée d'elle-même — le film attend sur le téléphone au lieu d'y repartir tout seul
  // (`PlaybackSession.startPaused`).
  /**
   * Les allers-retours en arrière-plan : la dernière pause du spectateur, le dernier départ, l'état
   * de la vidéo au départ, la retenue au retour, le dernier geste — voir `BackgroundWatch`
   * (backgroundReturn.ts). Un objet par lecteur, comme `lifecycle` et `seeks`.
   */
  const [background] = useState(() => new BackgroundWatch());
  /**
   * L'image figée d'une reconstruction pour changement de piste — voir `freezeFrame`. Sans elle,
   * l'image passait au noir le temps que le nouveau lecteur s'ouvre, puis revenait en fondu :
   * « une impression trop brutale de refresh complet », pour ce qui n'est qu'un changement de son.
   */
  const freezeRef = useRef<HTMLCanvasElement>(null);
  const [frozen, setFrozen] = useState(false);
  const wantedSubtitleRef = useRef<number | null>(null);
  /** Les préférences du compte ont été appliquées — une fois par lecteur, voir `applyPreferences`. */
  const preferencesAppliedRef = useRef(false);
  /**
   * The subtitle file being shown, when it is one that came from beside the film rather than
   * from inside it.
   *
   * Held here rather than in a pipeline because it belongs to neither: it is fetched from the
   * media server, it is the same file whichever way the picture is being decoded, and it must
   * survive a rebuild after a network cut exactly as the chosen language does.
   */
  const externalSubtitleRef = useRef<ExternalSubtitleTrack | null>(null);
  /**
   * Le décalage des sous-titres réglé par le spectateur, en secondes — ce lecteur dessine ses
   * lignes lui-même, c'est donc à lui de l'appliquer (voir `subtitleOffset` sur PlayerControls).
   * Une référence pour l'horloge, un état pour le chiffre affiché.
   */
  const subtitleOffsetRef = useRef(0);
  const [subtitleOffset, setSubtitleOffset] = useState(0);
  /** Abandons a subtitle file still in flight when the player closes, or another is chosen. */
  const subtitleFetchRef = useRef<AbortController | null>(null);

  /**
   * « Générer des sous-titres » (DECISIONS.md §70) : les générations du titre, leurs lignes et leur
   * sondage. Un objet par hôte, au-dessus des pipelines comme les fichiers externes : une
   * reconstruction ne perd rien de ce qui a été reçu. Ses rappels sont posés plus bas
   * (`setHooks`), une fois tout ce qu'ils lisent défini.
   */
  const [generation] = useState(() => new SubtitleGeneration({ itemId, sessionId }));
  const generationState = useSyncExternalStore(generation.subscribe, generation.snapshot, generation.snapshot);
  /**
   * La liste des fichiers à côté du film, relue quand Jellyfin présente un fichier généré — à la
   * place de celle de l'ouverture. Un état à part, et non la description du fichier : celle-ci est
   * une dépendance du pipeline, et la remplacer reconstruirait le lecteur en plein film.
   */
  const [refreshedExternals, setRefreshedExternals] = useState<ExternalSubtitleSource[] | null>(null);
  /** Le dernier décalage d'horloge du fichier (`presentationDelay`) : pour redessiner hors `timeupdate`. */
  const fileDelayRef = useRef(0);
  /** La ligne affichée est un message d'état de la génération, pas une réplique. */
  const [subtitleIsNotice, setSubtitleIsNotice] = useState(false);

  /**
   * Le second sous-titre (« Deux sous-titres », DECISIONS.md §87) : une seconde voie, tenue comme la
   * première au-dessus des pipelines — son numéro, son fichier s'il vient d'à côté du film, son propre
   * décalage, sa ligne. Une piste du fichier n'a rien à demander au pipeline : toutes les pistes texte
   * sont déjà recueillies, on lit simplement une autre piste (`subtitleAt(at, piste)`).
   */
  const secondWantedRef = useRef<number | null>(null);
  const [secondSubtitle, setSecondSubtitle] = useState<number | null>(null);
  const secondExternalRef = useRef<ExternalSubtitleTrack | null>(null);
  const secondOffsetRef = useRef(0);
  const [secondOffset, setSecondOffset] = useState(0);
  const secondFetchRef = useRef<AbortController | null>(null);
  const [secondText, setSecondText] = useState<string | null>(null);
  const [secondIsNotice, setSecondIsNotice] = useState(false);
  /** Le choix retenu sur l'appareil n'est réappliqué qu'une fois par lecteur, à la première ouverture. */
  const dualMemoryAppliedRef = useRef(false);

  const { generationLane, clearSecond, chooseSubtitle, chooseSecond, showGeneratedAt, showSecondGeneratedAt, showSubtitleAt } = useNativeSubtitleLanes({
    generation,
    wantedSubtitleRef,
    secondWantedRef,
    secondExternalRef,
    secondFetchRef,
    secondOffsetRef,
    setSecondOffset,
    setSecondSubtitle,
    setSecondText,
    setSecondIsNotice,
    subtitleOffsetRef,
    setSubtitleOffset,
    setCurrentSubtitle,
    setSubtitle,
    remuxRef,
    externalSubtitleRef,
    setSubtitleIsNotice,
    subtitleFetchRef,
    showWarning,
    tRef,
    fileDelayRef,
  });

  // Reset for every attempt, not fixed at the mount. A rebuild lowers `ready`, and measured from
  // the mount the wait was instantly minutes long — so a rebuild that takes half a second
  // announced itself as "still working", which is a spinner lying about what it knows.
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  /**
   * L'instant de la dernière première image, posé à l'instant même où le pipeline la déclare — avant
   * le rendu qui abaisse `ready`. Les minuteurs de l'ouverture (§78) le comparent à `openedAt` : un
   * tic tombé entre l'image et ce rendu aurait sinon pu basculer un film qui joue déjà.
   */
  const pictureAtRef = useRef(0);

  /**
   * Chronométrer un changement de piste audio — et **rien de plus**.
   *
   * Deux endroits le demandent : la préférence de langue du compte, appliquée à l'ouverture, et le
   * menu du lecteur. Un seul compte rendu pour les deux, sinon ils diront deux choses différentes
   * du même geste le jour où l'un des deux évoluera.
   *
   * Posé **autour** du changement, jamais dedans : mesurer ne doit rien en déplacer.
   *
   * `applied` est ce qui distingue un changement lent d'un changement refusé : une piste que le
   * navigateur n'ouvre pas laisse la précédente en place, et le menu suit ce qui s'est passé.
   */
  const reportAudioSwitch = useCallback(
    (
      from: number | null,
      fromLabel: string,
      to: number,
      startedAt: number,
      playback: { currentAudioTrack: number | null; diagnostics: Record<string, string> } | null | undefined,
      /**
       * « reconstruction » : le lecteur reconstruit sur la nouvelle piste, seule façon de changer
       * depuis le 22/09/2026 — le champ reste pour que les lignes d'avant, « tampon », se lisent à
       * côté. « refus » : un fichier sans index, en cours de film ; la piste d'avant continue.
       */
      via: "reconstruction" | "refus"
    ) => {
      tally.audioSwitched();
      reportPlayback("audio", {
        ...describeFileRef.current(),
        from: from ?? -1,
        to,
        via,
        /**
         * Les deux pistes décrites, et pas seulement numérotées.
         *
         * « A_DTS 6 canaux » → « A_EAC3 8 canaux » se lit tout seul ; « 3 → 5 » oblige à rouvrir
         * le fichier pour savoir de quoi on parle. Un journal qu'il faut recroiser à la main est
         * un journal que personne ne dépouille — et ces lignes sont écrites pour être lues dans
         * une semaine, par quelqu'un qui n'aura pas le film sous les yeux.
         */
        fromTrack: fromLabel,
        toTrack: playback?.diagnostics["Audio"] ?? "",
        applied: (playback?.currentAudioTrack ?? -1) === to,
        tookMs: Date.now() - startedAt,
        // « copié tel quel » ou « décodé puis ré-encodé en AAC » : c'est toute la question du coût.
        processing: playback?.diagnostics["Traitement audio"] ?? "",
        at: Math.round(positionRef.current),
        // Where the time went, step by step, measured on the device: without it a slow change
        // can only be guessed at from the server, and on 21/09/2026 the guess was wrong twice.
        steps: traceRecent(Date.now() - startedAt).join(" | "),
      });
    },
    [tally]
  );

  /**
   * Recopie l'image à l'écran dans un calque, avant que le lecteur ne soit démonté.
   *
   * Réduite à la largeur d'un écran : une image 4K dessinée d'un coup sur le fil principal, c'est
   * du temps pour rien, à l'instant où le spectateur attend. Un échec — une image pas encore là, un
   * navigateur qui refuse de dessiner la vidéo — n'est rien : on retombe sur le fondu d'avant.
   */
  const freezeFrame = useCallback((): boolean => {
    const video = videoElRef.current;
    const canvas = freezeRef.current;
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
    try {
      const scale = Math.min(1, 1920 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const context = canvas.getContext("2d");
      if (!context) return false;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return true;
    } catch {
      return false;
    }
  }, []);

  /**
   * L'image figée s'efface quand le nouveau lecteur a la sienne : `ready` ne suffit pas, il dit que
   * le pipeline est monté, pas que la première image est peinte. Au plus quelques secondes quoi
   * qu'il arrive — une image figée qui resterait serait pire que le noir.
   */
  useEffect(() => {
    if (!frozen) return;
    // Le calque garde ses pixels jusqu'à la prochaine image figée, qui le redimensionne : les
    // rendre après le fondu, par un minuteur, pouvait effacer une seconde image figée prise dans
    // l'intervalle — quelques mégaoctets ne valent pas ce risque.
    const release = () => setFrozen(false);
    const deadline = setTimeout(release, FREEZE_MAX_MS);
    if (!ready) return () => clearTimeout(deadline);
    const video = videoElRef.current;
    /**
     * Levée à la première image *affichée* du nouveau lecteur, quand le navigateur sait le dire.
     *
     * `readyState` dit qu'une image est décodée, pas qu'elle est à l'écran : l'image figée
     * partait parfois sur un noir d'une fraction de seconde, ce qui rendait le changement de piste
     * « sec » (22/09/2026). `requestVideoFrameCallback` répond à l'image effectivement présentée.
     */
    const presented = video as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (id: number) => void }) | null;
    if (presented?.requestVideoFrameCallback) {
      const handle = presented.requestVideoFrameCallback(release);
      return () => {
        clearTimeout(deadline);
        presented.cancelVideoFrameCallback?.(handle);
      };
    }
    if (!video || video.readyState >= 2) {
      const soon = setTimeout(release, 0);
      return () => {
        clearTimeout(soon);
        clearTimeout(deadline);
      };
    }
    video.addEventListener("loadeddata", release, { once: true });
    video.addEventListener("seeked", release, { once: true });
    return () => {
      clearTimeout(deadline);
      video.removeEventListener("loadeddata", release);
      video.removeEventListener("seeked", release);
    };
  }, [frozen, ready]);

  /**
   * Builds the pipeline again from where the viewer is, keeping what they had chosen.
   *
   * Reconstruire le pipeline à `at`. `byViewer` : la demande vient du spectateur (réessayer, une
   * piste, le plafond HDR) — elle passe toujours ; une reconstruction automatique est refusée par
   * `lifecycle.restart` une fois la main passée ou pendant la fermeture.
   */
  const restart = useCallback((at: number, why: string, byViewer = false) => {
    if (!lifecycle.restart(at, { ...background.pauseFacts(), byViewer })) {
      trace(`reprise refusée : ${why} — le lecteur a passé la main ou se ferme`);
      return;
    }
    trace(`reprise : ${why} — reconstruction à ${at.toFixed(1)} s`);
    // Le registre des tentatives (§67), en observation : une reconstruction automatique qui en rejoue
    // une déjà échouée, au même endroit et sur la même piste, sans lecture entre-temps, est notée.
    if (!byViewer) {
      const rank = tally.retries.noteFailure(retrySignature(why, { track: wantedAudioRef.current, pos: positionBucket(at) }));
      if (rank > 1) trace(`tentative identique n°${rank} : ${retryMotif(why)}`);
    }
    // Une reconstruction ne relance pas un film que le spectateur avait mis en pause : seuls le
    // changement de piste et le plafond HDR y veillaient, et un film arrêté, rendu par iOS au
    // retour d'arrière-plan, repartait tout seul (relu le 24/09/2026). Une pause suivie de près par
    // le passage en arrière-plan peut être celle d'iOS lui-même : elle ne compte que si elle le
    // précède d'une seconde au moins — sinon la reprise se fait comme avant.
    traceKeepAcrossReset();
    setOpenedAt(Date.now());
    setNetworkLost(null);
    setReady(false);
    // Rien ne joue pendant une reconstruction, et l'élément démonté ne le dira pas : ses écouteurs
    // sont déjà retirés. Resté vrai, `playing` comptait ce temps comme regardé et le rapportait
    // à Jellyfin « en lecture » (relu le 24/09/2026). Le pipeline suivant le repasse à vrai.
    setPlaying(false);
    clearStall();
    setRuntimeError(null);
    setRebuildCount((count) => count + 1);
  }, [lifecycle, background, tally, clearStall]);

  /**
   * Reconstruire sur place à la demande du spectateur — une piste audio, « Améliorer les dialogues »,
   * le plafond HDR : à la position voulue (un saut encore en chargement n'a pas encore déplacé la
   * position lue), pause et image figée comprises. Un film à l'arrêt reste à l'arrêt : le spectateur a
   * changé un réglage, pas lancé la lecture. Écrit une fois pour les trois gestes : la pause et l'image
   * figée, nées pour la piste (`a68efdb6`), avaient manqué au plafond HDR — un film à l'arrêt y
   * repartait sur un écran noir (`913125c3`).
   */
  const rebuildHereForViewer = useCallback(
    (why: string) => {
      lifecycle.setKeepPaused(videoElRef.current?.paused ?? false);
      setFrozen(freezeFrame());
      restart(intendedPosition(), why, true);
    },
    [lifecycle, freezeFrame, restart, intendedPosition]
  );

  /**
   * Entrer en coupure : l'écran « connexion perdue », à la position et sur la piste du moment —
   * écrit une seule fois pour ses trois chemins (23/10/2026, DECISIONS.md §115) : la description du
   * fichier impossible à obtenir (SWR), l'erreur réseau du moteur en pleine lecture, l'ouverture du
   * fichier impossible. Rien une fois la main passée ou pendant la fermeture : une coupure n'a plus
   * d'écran à montrer. `traced` : la phrase de la trace, propre à chaque chemin.
   *
   * `line` : la ligne `network` et la position gardée — le moteur seulement, « pas pendant le sondage
   * ou l'attache » (docs/cycle-de-vie-lecteur.md) ; les étendre aux deux autres chemins est une
   * décision à part.
   */
  const enterNetworkLost = useCallback(
    (message: string, traced: string, line = false) => {
      if (lifecycle.isOver()) return;
      trace(traced);
      lifecycle.noteNetworkLost();
      if (line) {
        reportPlayback("network", { ...describeFileRef.current(), reason: message, at: positionRef.current });
        // La position de la coupure, gardée sur l'appareil : si rien ne repasse avant la fermeture,
        // elle part au retour du réseau ou au lancement suivant (`unsentPosition.ts`, §78).
        // Ni pour une scène (§91) : c'est la position que la séance ne doit pas écrire.
        if (everReadyRef.current && recordsResume(session.bench, isSceneRef.current)) saveUnsentPosition(itemId, positionRef.current);
      }
      setNetworkLost({ message, at: positionRef.current, audio: wantedAudioRef.current });
      setPlaying(false);
    },
    [lifecycle, itemId, session.bench]
  );

  // Fetched once and then left alone. The description of a file does not change while it is
  // being watched, and every revalidation handed back a fresh object — which the effect below
  // depends on, so the whole pipeline was torn down and rebuilt behind the viewer's back: a
  // second decoder, a second encoder, a second MediaSource, and the first one's read loop still
  // running against buffers its source had already released.
  //
  // Fetched once *per opening*, though: the key carries this mount's identity. Under the bare
  // address, SWR served whatever an earlier opening — or a `preload` nobody had taken yet — left
  // there, never revalidated, and that description names the file the device's bytes must match:
  // a file replaced since was opened on its old bytes (Ted Lasso S04E09, Android, 30/09/2026).
  // What the sheet asked for in advance is still taken, through `directInfoForOpening`, as long
  // as it is under five minutes old (`directInfo.ts`).
  const openingId = useId();
  // Le numéro de l'essai : une description perdue faute de réseau est redemandée sous une clé
  // neuve, la seule façon de faire reposer la question à SWR sans revalidation (voir plus bas).
  const [infoAttempt, setInfoAttempt] = useState(0);
  const { data: fileInfo, error: infoError } = useSWR<DirectPlayInfo>([directInfoKey(itemId), openingId, infoAttempt], () => directInfoForOpening(itemId), {
    // La description du fichier est ce qui décide du chemin de lecture : la mettre en pause parce
    // qu'un film occupe l'écran, c'est attendre que le film commence pour savoir comment le lire.
    ...playerBootstrapOptions,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    // Pas de réseau à l'ouverture : l'écran « connexion perdue », comme une coupure en plein film,
    // et non le lecteur serveur — qui a besoin du même réseau (Mac de kab, 07/10/2026 ; voir
    // `asNetworkFailure`). Posé ici, dans le rappel de SWR, plutôt que par un effet qui lirait
    // l'erreur après coup.
    onError: (cause: unknown) => {
      if (!isNetworkFailure(cause)) return;
      const message = cause instanceof Error ? cause.message : "réseau indisponible";
      enterNetworkLost(message, `réseau : description du fichier impossible à obtenir — ${message}`);
    },
  });
  // Un extrait du test de qualité hors ligne se décrit lui-même (`labSamples.ts`) : sa description
  // remplace celle du film, demandée quand même par la ligne ci-dessus — la clé que la fiche précharge
  // reste la seule façon d'obtenir une description.
  const [labInfo] = useState(() => {
    const sample = session.labSample ? labSampleByFile(session.labSample.file) : null;
    return sample && session.labSample ? labSampleInfo(sample, session.labSample.sizeBytes) : null;
  });
  const info = labInfo ?? fileInfo;
  /**
   * Quand la description du fichier est arrivée — la condition de tout le reste : le lecteur ne lit
   * pas un octet du film avant elle. Pour la ligne `opening` (`infoMs`) : trois ouvertures sur 291
   * attendaient 3 à 8 s avant d'ouvrir le fichier, sans rien dans la trace pour dire quoi (relu le
   * 20/10/2026) — la trace repart de zéro à l'ouverture du fichier, après cette attente.
   */
  const infoAtRef = useRef<number | null>(null);
  /** Ni le banc ni un extrait de test : ce que fait cette lecture dit quelque chose du spectateur. */
  const observesViewerRef = useRef(!session.bench && !session.labSample);
  useEffect(() => {
    observesViewerRef.current = !session.bench && !session.labSample;
  }, [session.bench, session.labSample]);
  useEffect(() => {
    if (info && infoAtRef.current === null) infoAtRef.current = Date.now();
  }, [info]);

  /**
   * Le nouvel essai après une coupure : une reconstruction si le fichier était ouvert, sinon une
   * nouvelle demande de sa description — `restart` relancerait un pipeline qui attend une
   * description qu'il n'aura jamais, et sa position effacerait celle de l'ouverture.
   */
  const retryAfterNetwork = useCallback(
    (at: number, why: string, byViewer = false) => {
      if (info) {
        restart(at, why, byViewer);
        return;
      }
      if (!lifecycle.retryOpening(byViewer)) return;
      trace(`reprise : ${why} — nouvelle demande de la description du fichier`);
      setOpenedAt(Date.now());
      setNetworkLost(null);
      setInfoAttempt((attempt) => attempt + 1);
    },
    [info, restart, lifecycle]
  );

  /**
   * Les étiquettes des pistes audio, calculées une fois pour les deux menus qui les montrent.
   *
   * La mention « (VO) » vient de la langue de tournage, que Jellyfin n'expose pas sur un item :
   * elle est reliée au film par son identifiant TMDB, dans la route qui décrit le fichier, et
   * puisée dans le cache Radarr déjà chargé. Nulle pour une série et pour toute langue non
   * reconnue — une mention qu'on ne peut pas garantir vaut moins que pas de mention du tout.
   */
  const audioLabels = useAudioLabels(tracks.audio, info?.audio, info?.originalLanguage ?? null);
  /**
   * Les sous-titres du menu : ceux du fichier, puis ceux posés à côté de lui.
   *
   * Construits ici plutôt que dans le rendu, pour que les étiquettes soient calculées sur la
   * liste complète — savoir qu'une étiquette est ambiguë demande de voir les autres, et une
   * piste interne peut être le sosie d'une externe.
   */
  // Les fichiers à côté du film : ceux de l'ouverture, ou la liste relue après une génération.
  const externals: ExternalSubtitleSource[] = useMemo(
    () => refreshedExternals ?? info?.externalSubtitles ?? [],
    [refreshedExternals, info?.externalSubtitles]
  );
  const externalsRef = useRef(externals);
  useEffect(() => {
    externalsRef.current = externals;
  }, [externals]);
  // Puis les générations en cours, en entrées temporaires (DECISIONS.md §70).
  const generationView = useMemo(() => generationMenu(generationState, externals, locale, t), [generationState, externals, locale, t]);
  const subtitleChoices = useMemo(
    () => [...tracks.subtitles, ...externals.map(externalToPlayerTrack), ...generationView.entries.map((entry) => entry.track)],
    [tracks.subtitles, externals, generationView]
  );
  const subtitleOrigins = useMemo(() => {
    const origins = new Map<number, "generating" | "generated">();
    for (const source of externals) if (source.generated === true) origins.set(source.id, "generated");
    for (const entry of generationView.entries) origins.set(entry.track.number, "generating");
    return origins;
  }, [externals, generationView]);
  const subtitleLabels = useSubtitleLabels(subtitleChoices, subtitleOrigins);
  /** Une piste du menu par son numéro — ce que « deux sous-titres » retient d'elle, c'est sa langue (§87). */
  const trackOfSubtitle = useCallback(
    (id: number | null) => (id === null ? null : (subtitleChoices.find((track) => track.number === id) ?? null)),
    [subtitleChoices]
  );
  const subtitleDetails = useMemo(
    () => new Map(generationView.entries.map((entry) => [entry.track.number, entry.detail])),
    [generationView]
  );

  const { requestGeneration, requestSecondGeneration } = useNativeSubtitleGeneration({
    generation,
    bench: session.bench,
    shareMode,
    intendedPosition,
    describeFileRef,
    showWarning,
    tRef,
    setRefreshedExternals,
    wantedSubtitleRef,
    setCurrentSubtitle,
    setSubtitle,
    externalSubtitleRef,
    setSubtitleIsNotice,
    subtitleFetchRef,
    subtitleOffsetRef,
    secondWantedRef,
    setSecondSubtitle,
    secondExternalRef,
    setSecondIsNotice,
    secondFetchRef,
    secondOffsetRef,
    fileDelayRef,
    videoElRef,
    externalsRef,
    generationLane,
    clearSecond,
    showGeneratedAt,
    showSecondGeneratedAt,
    chooseSubtitle,
    chooseSecond,
  });

  /**
   * Où en est cette lecture, dans les termes que le lecteur qui reprend comprend.
   *
   * Deux gestes s'en servent — la piste que ce chemin ne peut pas porter, et la diffusion — et ils
   * décrivent exactement la même chose. Deux copies finiraient par diverger sur la seule valeur
   * qui compte : la position.
   *
   * Mémorisé, et placé après ce qu'il lit : une fonction nue dans le corps du composant fait
   * renoncer le compilateur React à mémoriser le reste — il l'a dit, et il avait raison de le
   * dire. La position, elle, se lit dans la référence au moment de l'appel : c'est celle de
   * l'appui qu'on veut, pas celle du rendu qui a créé le gestionnaire.
   */
  const takeoverNow = useCallback(
    (): StableTakeover => ({
      // Un nombre, jamais un champ omis : voir `PlaybackSession.resumeAt`. La position suivie, et
      // non celle de l'élément : juste après une reconstruction, il n'a pas encore été posé là où
      // le film en était.
      resumeAt: positionKnownRef.current ? positionRef.current : session.resumeAt ?? 0,
      audioStreamIndex: jellyfinAudioIndex(tracks.audio, info?.audio, currentAudio ?? -1),
    }),
    [session.resumeAt, tracks.audio, info?.audio, currentAudio]
  );
  useEffect(() => {
    takeoverNowRef.current = takeoverNow;
  }, [takeoverNow]);
  /**
   * La piste du relais d'une zone illisible (§93) : la même pour son préchauffage et pour le relais,
   * sans quoi le lecteur serveur ne reprendrait pas le préchauffage (`takeOrdinaryPrewarm`).
   */
  const zoneAudioRef = useRef<() => number | undefined>(() => undefined);
  useEffect(() => {
    zoneAudioRef.current = () => jellyfinAudioIndex(tracks.audio, info?.audio, wantedAudioRef.current ?? currentAudio ?? -1);
  }, [tracks.audio, info?.audio, currentAudio]);
  /**
   * Le relais préparé avant une zone illisible (§93, `unreadableZoneHandover.ts`) : préchauffé par la
   * mécanique de la connexion lente, passé à la tête. Un par lecteur, créé une fois ; ce qu'il lit de
   * ce lecteur passe par des références.
   */
  const [zoneHandover] = useState(() => new ZoneHandover());
  useEffect(() => {
    zoneHandover.attach({
      itemId,
      // Sans lecteur serveur, ou pour le banc d'essai : rien à préparer. WebKit en HLS natif : le
      // relais tout de suite (voir le module). Ailleurs : préchauffer.
      mode: () => (serverFallbackRef.current !== true || session.bench ? "wait" : playsHlsNatively(videoElRef.current) ? "immediate" : "prepare"),
      audioStreamIndex: () => zoneAudioRef.current(),
      maxBitrate: () => pickMaxBitrate(),
      paused: () => videoElRef.current?.paused ?? true,
      trace,
    });
  }, [zoneHandover, itemId, session.bench]);
  useEffect(() => () => zoneHandover.dispose(), [zoneHandover]);
  /**
   * Passer la main pour une zone illisible (§93) : à la position du relais, avec le préchauffage s'il
   * convient. `switchedAt` : le lecteur serveur mesure l'interruption jusqu'à son image
   * (`switchGapMs`, sur son bilan) — comme pour une bascule de la connexion lente. Sans lecteur
   * serveur, `fallToStable` écrit l'erreur et l'affiche.
   */
  const handZone = useCallback(
    (message: string, resumeAt: number, facts: Record<string, unknown>) => {
      if (lifecycle.isOver()) return;
      const prewarm = zoneHandover.take(resumeAt);
      const base = everReadyRef.current ? takeoverNowRef.current() : undefined;
      fallToStable(
        message,
        { ...base, resumeAt, audioStreamIndex: zoneAudioRef.current(), switchedAt: Date.now() },
        { ...facts, ...(prewarm ? { prewarm: prewarmFields(prewarm) } : {}) }
      );
    },
    [lifecycle, zoneHandover, fallToStable]
  );
  /**
   * Le Chromecast (DECISIONS.md §64) : proposé seulement s'il y a un lecteur serveur pour préparer
   * le flux (`serverFallback` connu et vrai — dans le doute, pas de bouton), hors banc d'essai, et
   * pour un compte et un navigateur qui y ont droit (`useChromecastAllowed`). Ailleurs le kit de
   * Google n'est jamais chargé et rien de ce lecteur ne change.
   *
   * Le récepteur choisi dans la liste de Chrome, la main passe comme pour AirPlay — `cast: true`,
   * un choix et non un échec — mais à `ChromecastPlayer`, qui pilote le téléviseur (`castTarget`).
   * Une session déjà ouverte (un autre onglet, un essai précédent) est reprise sans redemander.
   */
  // Ni pour un lien de partage (§112) : sa question (`/api/player/cast`) lui serait refusée.
  const chromecastAllowed = useChromecastAllowed(serverFallback === true && !session.bench && !shareMode);
  const chromecastState = useChromecast(chromecastAllowed);
  const requestChromecast = useCallback(() => {
    const handOver = () => fallToStable("diffusion demandée", { ...takeoverNow(), cast: true, castTarget: "chromecast" });
    if (chromecastSnapshot().connected) {
      handOver();
      return;
    }
    void requestChromecastSession().then((answer) => {
      if (answer.ok) handOver();
      else if (answer.code !== "cancel") trace(`chromecast : session refusée — ${answer.code}`);
    });
  }, [fallToStable, takeoverNow]);
  /**
   * Où en est ce spectateur, et dans quelles langues il regarde — relu à chaque ouverture.
   *
   * Volontairement hors de SWR, et volontairement pas dans la charge du fichier. Ces deux faits
   * changent entre deux lectures du même film, alors que la description du fichier ne bouge
   * jamais : les mélanger revenait à geler les premiers avec la seconde jusqu'au rechargement de
   * la page. Changer sa langue de sous-titres puis relancer un film déjà lu dans la session
   * appliquait l'ancienne, à tous les coups.
   *
   * Une lecture nue plutôt qu'une clé mise en cache, parce que la valeur alimente l'effet qui
   * construit tout le pipeline : elle doit changer *une seule fois*, de « pas encore su » à
   * « su ». Une clé SWR rendrait d'abord la valeur mémorisée puis la fraîche — deux changements,
   * donc un pipeline reconstruit et un film qui repart en cours de route.
   *
   * `undefined` tant qu'on ne sait pas, `null` si le serveur n'a pas répondu — auquel cas le film
   * s'ouvre à son début sur ses pistes par défaut, ce qui vaut mieux que de ne pas s'ouvrir.
   */
  const [playbackState, setPlaybackState] = useState<PlaybackState | null | undefined>(undefined);
  useEffect(() => {
    let abandoned = false;
    // Un délai de garde, parce que cette lecture est devenue une condition d'ouverture.
    //
    // Le film n'attendait qu'une chose avant de se construire — la description du fichier — et il
    // en attend deux depuis que l'état du spectateur a sa propre adresse. Une requête qui ne
    // répond jamais, ni par un succès ni par une erreur, laisserait donc un spinner qui ne
    // s'arrête pas : `.catch()` attrape un refus, pas une absence.
    //
    // Huit secondes, comme les routes qui vont chercher chez Jellyfin. Passé ce délai on ouvre le
    // film à son début sur ses pistes par défaut, ce qui vaut infiniment mieux que de ne pas
    // l'ouvrir — et c'est déjà ce que fait ce chemin quand le serveur refuse de répondre.
    //
    // La réponse que la fiche a demandée à son ouverture, quand elle a moins de trente secondes et
    // n'a encore servi à aucune lecture — un aller-retour de moins avant le premier octet. Sinon
    // la question est posée ici, comme avant. Voir `playbackPrefetch.ts`.
    void (takePrefetchedPlaybackState(itemId) ?? fetchPlaybackState(itemId)).then((value) => {
      if (!abandoned) setPlaybackState(value);
    });
    return () => {
      abandoned = true;
    };
  }, [itemId]);

  /** L'erreur affichée est-elle celle d'une connexion trop lente ? Voir `slowLink`. */
  const slowShown = slowLink !== null && runtimeError === SLOW_LINK_REASON;
  /**
   * La position de reprise est inconnue — Jellyfin ne répond pas à `playback-state` (14/10/2026,
   * §92) — et l'appelant n'en affirme aucune. Ouvrir au début, c'était laisser les rapports de
   * progression effacer la reprise chez Jellyfin dès son retour : le lecteur le dit et n'ouvre pas.
   */
  const positionUnknown = playbackState?.positionUnknown === true && (session.resumeAt ?? null) === null;
  // Une zone illisible sans lecteur serveur (§93) : la phrase du compte, dans sa langue, avec l'instant
  // — le motif technique reste au journal et sous « Signaler un problème ».
  const zoneError = runtimeError !== null && isUnreadableZoneReason(runtimeError) ? t("player.unreadableZone", { time: formatTime(zoneSecondsOf(runtimeError)) }) : null;
  /**
   * Un serveur absent se dit autrement qu'un fichier illisible (`errorMessage`, dernière ligne).
   *
   * Les deux échouaient sur la même phrase, qui décrivait le symptôme sans nommer la cause — et
   * quand la cause est « le serveur média est arrêté », c'est la seule chose que le spectateur ait
   * besoin de savoir : il n'y a rien à réessayer tout de suite, et rien de cassé chez lui.
   */
  const error =
    zoneError ??
    runtimeError ??
    info?.refusedReason ??
    (positionUnknown ? t("player.libraryUnreachable") : null) ??
    (infoError && !isNetworkFailure(infoError) ? errorMessage(infoError, t, t("errors.fileInfoFailed"), locale) : null);
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
      session: sessionId,
      // Les lignes écrites pendant un banc d'essai, reconnaissables — voir `PlaybackSession.bench`.
      ...(session.bench ? { bench: session.bench } : {}),
      // Une scène (§91) : `scene`, puis `sceneNormal` une fois devenue lecture — lu à chaque ligne.
      ...sceneLogFields(),
    }),
    [itemId, info, openedAs, session.bench, sessionId, sceneLogFields]
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
  const stallFor = useElapsedSince(stallAt);
  // Nothing has failed, so there is no error screen — and this is exactly the case that leaves
  // nothing at all behind: a spinner that never stops, on a device with no console.
  const stuck = openingFor !== null && openingFor >= STUCK_AFTER_MS;

  /**
   * L'ouverture de la lecture (DECISIONS.md §60), par-dessus l'élément tant que la première image
   * n'est pas là. Décidée une fois, au montage : une lecture qui a déjà montré une image — un relais
   * revenu, une diffusion rendue — ne la rejoue pas, et son horloge est celle posée à l'appui, que
   * le lecteur serveur reprendra s'il prend la main avant la première image.
   */
  const thisIntro = introKey(session.openId, itemId);
  const [introEligible] = useState(() => introAllowedFor(session) && !introFinished(thisIntro));
  const [introStartedAt] = useState(() => startIntroClock(thisIntro));
  // `announced` dit le lecteur prêt — en-tête et premier segment posés —, pas la lecture partie :
  // l'horloge attend encore que le navigateur ait de quoi jouer, et l'ouverture effacée là laissait
  // la roue de l'attente prendre la suite une ou deux secondes (vu par Louis le 10/10/2026 : « la
  // première image, puis le chargement classique »). Elle tient donc jusqu'à ce que l'horloge
  // avance vraiment — ou, la lecture automatique refusée, jusqu'à un élément arrêté sans attente.
  const startingRef = useRef(startingAt !== null);
  useEffect(() => {
    startingRef.current = startingAt !== null;
  }, [startingAt]);
  // La règle elle-même, et pourquoi un élément arrêté ne suffit pas : `useIntroPlaybackStarted`.
  const introPlaying = useIntroPlaybackStarted(announced, videoElRef, startingRef);
  useEffect(() => {
    if (introPlaying) finishIntro(thisIntro);
  }, [introPlaying, thisIntro]);
  /** La lecture a montré sa première image et son horloge avance — lu par `sourceLost`. */
  const pictureSeenRef = useRef(false);
  useEffect(() => {
    if (introPlaying) pictureSeenRef.current = true;
  }, [introPlaying]);
  /**
   * La ligne `opening` : ce que la source a fait de l'appui jusqu'à six secondes après que le film
   * a bougé. Ajoutée le 10/10/2026 parce qu'un « second petit chargement » juste après l'ouverture,
   * surtout sur les reprises, ne laissait rien : moins de 250 ms, hors du bilan (`waits`), et la
   * trace n'était écrite qu'au-delà de cinq secondes de blocage (`stall`). Une par séance ouverte.
   */
  useEffect(() => {
    if (!introPlaying || !introEligible) return;
    const movedAt = Date.now();
    let sent = false;
    // Six secondes après le premier mouvement, ou à la fermeture si elle vient avant : les essais
    // durent souvent moins que ça, et ce sont eux qui montrent le défaut.
    const send = () => {
      if (sent) return;
      sent = true;
      reportPlayback("opening", {
        ...describeFileRef.current(),
        path: "remux",
        firstMoveMs: movedAt - introStartedAt,
        // Depuis l'appui, comme `firstMoveMs` : 0 quand la fiche l'avait déjà préchargée.
        ...(infoAtRef.current !== null ? { infoMs: Math.max(0, infoAtRef.current - introStartedAt) } : {}),
        // Ce que la lenteur a fait paraître pendant cette ouverture, et les choix faits (§78).
        ...slowFields(),
        steps: traceRecent(Date.now() - introStartedAt + 300).slice(-60).join(" | "),
      });
    };
    const timer = window.setTimeout(send, 6000);
    return () => {
      window.clearTimeout(timer);
      send();
    };
  }, [introPlaying, introEligible, introStartedAt, slowFields]);
  /**
   * La version allégée existe-t-elle ici, et le lecteur a-t-il le droit d'y passer de lui-même (§78) ?
   * Un lecteur serveur sur l'installation, le transcodage vidéo permis au compte (`lighterAllowed` de
   * la description, lu chez Jellyfin) et le réglage « Qualité » sur Automatique. Sinon : l'indice, et
   * l'écran final au renoncement — le comportement « Originale ». Jamais pour le banc d'essai : il
   * mesure ce lecteur-ci sur cet appareil, une bascule fausserait sa mesure.
   */
  const quality = usePlaybackQuality();
  const autoLighter = quality === "auto" && serverFallback !== false && info?.lighterAllowed !== false && !session.bench;
  const autoLighterRef = useRef(autoLighter);
  useEffect(() => {
    autoLighterRef.current = autoLighter;
  }, [autoLighter]);

  // L'indice « Connexion lente… » (§78) : celui de cette ouverture-ci,
  // tant qu'aucune image n'est là ni aucune erreur. « Connexion perdue ou instable… » passe avant :
  // une coupure n'est pas une lenteur.
  const slowCurrent = slowSignal.at === openedAt && openingFor !== null && !ready && !runtimeError && !networkLost;
  const unstableShown = unstable && openingFor !== null && !ready && !runtimeError && !networkLost;
  const slowHintShown = slowCurrent && slowSignal.hint && !unstableShown;
  // L'ouverture reste tant qu'un préchauffage attend sa bascule : elle explique l'attente (§78).
  const lighterPending = slowCurrent && slowSignal.hint && autoLighter;
  // Une erreur, la connexion perdue, l'attente devenue anormale (le rapport doit se lire), le
  // mini-lecteur : l'ouverture s'efface à l'instant et l'écran d'avant se montre, inchangé — sauf
  // l'attente longue quand une bascule sur la version allégée se prépare (§78) : l'ouverture reste,
  // l'indice dessous, jusqu'à la bascule.
  const introPhase: IntroPhase =
    !introEligible || isMini ? "gone" : introPlaying
        ? "picture"
        : error || networkLost || (stuck && !lighterPending) || (startingFor !== null && startingFor >= STUCK_AFTER_MS)
          ? "gone"
          : "waiting";
  // Le calque couvre-t-il le lecteur ? L'ouverture entière dès l'appui, jusqu'au film qui bouge
  // (`introPlaying`), ou `COVER_HOLD_MS` sur une image décodée qui ne part pas — voir `PlaybackIntro`.
  // Il tient lieu de roue : les deux ne se montrent jamais ensemble.
  const [introCovering, setIntroCovering] = useState(() => introEligible && !isMini);
  const introCovers = introPhase === "waiting" && introCovering;

  /** L'instant du montage — pour `gaveUpAfterMs`, dans le bilan d'une séance fermée avant l'image. */
  const mountedAtRef = useRef(0);
  const { reportStop } = useNativeSessionRecord({
    itemId,
    bench: session.bench,
    info,
    playing,
    ready,
    ended,
    error,
    currentAudio,
    rebuildCount,
    sessionId,
    lifecycle,
    tally,
    watched,
    background,
    intendedPosition,
    slowFields,
    describeFileRef,
    pathRef,
    remuxRef,
    videoElRef,
    lastVideoElRef,
    positionRef,
    isSceneRef,
    mountedAtRef,
    everReadyRef,
  });

  const { stop: stopPlaybackNow, resume: resumePlaybackSession, savePaused, reportNow: reportPositionNow } = usePlaybackSession(
    // La cible d'un saut en cours plutôt que la position d'avant — voir `stopFields`.
    intendedPosition,
    // The native player reads the file directly, so there is no Jellyfin transcode session — but
    // progress still has to be reported, or resume points would stop updating for this player.
    // It announces its own start for the same reason: nothing else tells the server this film is
    // being watched, so without it the reports described a session Jellyfin had never heard of.
    // Rien pour le banc d'essai : il saute jusqu'à la fin des films, qui seraient tous marqués vus.
    // Rien non plus pendant une scène (§91) : devenue lecture, la séance s'annonce à cet instant.
    announced && !session.bench && !scene.active
      ? {
          itemId,
          // « engine » : le nom sous lequel Jellyfin connaît ce lecteur depuis le début (sessions,
          // greffon de statistiques). Gardé tel quel, même sans moteur canevas.
          playSessionId: `cine-engine-${itemId}`,
          mediaSourceId: itemId,
          playMethod: "DirectPlay",
          client: PLAYBACK_CLIENTS.engine,
          announce: true,
        }
      : null,
    useCallback(() => !playing, [playing])
  );
  // Lu par une référence depuis les écouteurs de l'élément, posés une fois pour toutes.
  const stopPlaybackRef = useRef(stopPlaybackNow);
  const resumePlaybackRef = useRef(resumePlaybackSession);
  useEffect(() => {
    stopPlaybackRef.current = stopPlaybackNow;
    resumePlaybackRef.current = resumePlaybackSession;
  }, [stopPlaybackNow, resumePlaybackSession]);
  /**
   * La séance a été close par la fin du fichier, et rien ne l'a rouverte depuis.
   *
   * « Revoir » la rouvrait, mais il n'existe que pour les films. Un épisode reste jouable après sa
   * fin — la carte de l'épisode suivant écartée, on revient en arrière ou on relance —, et cette
   * seconde lecture ne battait plus et n'enregistrait plus rien : Jellyfin gardait l'épisode « vu à
   * la fin » (relu le 24/09/2026). Toute reprise de la lecture rouvre donc la séance.
   */
  // « Fini, et l'arrêt déjà envoyé » vit dans `lifecycle` (`isEnded`) — un seul endroit pour ce
  // fait : une seconde copie, tenue à la main à côté, finirait par diverger.
  const reopenAfterEnd = useCallback(() => {
    if (!lifecycle.isEnded()) return;
    lifecycle.noteResumedAfterEnd();
    resumePlaybackRef.current();
  }, [lifecycle]);

  useEffect(() => () => subtitleFetchRef.current?.abort(), []);
  useEffect(() => () => secondFetchRef.current?.abort(), []);

  // La suite commune aux quatre hôtes : `closePlayerSession` (DECISIONS.md §114).
  const handleClose = useCallback(() => {
    closePlayerSession({
      // Plus aucune initiative pendant le fondu — voir `PlayerLifecycle.stepAside`. Et une seule
      // fermeture : un second appui ne renvoie ni arrêt ni relecture des vues.
      claim: () => lifecycle.noteClosing(),
      leaveFullscreen: true,
      reportStop: () => reportStop("close"),
      stopReporting: stopPlaybackNow,
      setClosing,
      playback,
      openId: session.openId,
      itemId,
      // Pas après une scène (§91), qui n'a rien changé de ce que montrent la fiche et « Reprendre ».
      refresh: !isSceneRef.current(),
    });
  }, [playback, stopPlaybackNow, itemId, reportStop, session.openId, lifecycle]);
  // Retour ferme le lecteur comme sa croix (`playerHistory.ts`) — écran de fin compris.
  usePlayerBackClose(handleClose);

  // Pas d'épisode suivant pendant une scène (§91) : on est venu voir une réplique.
  const nextEpisode = scene.active ? null : (session.getNextEpisode?.(itemId) ?? null);

  /**
   * La minuterie de veille — son décompte vit au-dessus de ce lecteur, remonté à chaque épisode
   * (`sleepTimer.ts`). Quand elle arrête le film : une ligne `pause` au journal, et la position à
   * Jellyfin tout de suite, comme une pause qu'on ne reprendra que demain.
   */
  const onSlept = useCallback(
    (mode: SleepMode) => {
      reportPlayback("pause", {
        ...describeFileRef.current(),
        path: pathRef.current ?? "non décidé",
        why: "veille",
        sleepTimer: mode,
        at: intendedPosition(),
      });
      savePaused();
    },
    [intendedPosition, savePaused]
  );
  const { blocksAdvance: sleepHoldsAtEnd, holdAtEnd } = useSleepTimer(videoElRef, onSlept);
  // Lu par l'écouteur `ended`, posé une fois pour toutes avec le pipeline.
  const holdAtEndRef = useRef(holdAtEnd);
  useEffect(() => {
    holdAtEndRef.current = holdAtEnd;
  }, [holdAtEnd]);
  /**
   * L'écran de fin : celle d'un film — ou d'un épisode que « Fin de l'épisode » retient. Jamais
   * sinon pour un épisode : une série a son propre enchaînement, et deux propositions au même moment
   * se disputeraient l'écran.
   */
  const endScreen = ended && (!nextEpisode || sleepHoldsAtEnd) && !isMini && !error;

  // Swaps to the next episode in place: the current one's final position is reported first, as
  // on a manual close, but the player stays open so there is no close/reopen flicker between
  // episodes.
  const handleAdvance = useCallback(() => {
    // Rien à enchaîner sur une séance close : le décompte de l'épisode suivant peut arriver à zéro
    // pendant le fondu de la croix, et l'épisode 2 était alors monté puis démonté aussitôt (faux
    // `stop unmount`, avance automatique comptée, flash). Même garde que `PlayerHost`.
    advanceTo(nextEpisode, { over: lifecycle.isOver(), reportStop: () => reportStop("next"), stopReporting: stopPlaybackNow, playback });
  }, [nextEpisode, playback, stopPlaybackNow, reportStop, lifecycle]);

  // Un épisode choisi dans le menu « Épisodes » (19/10/2026) : le même passage que l'épisode suivant —
  // arrêt rapporté (`next`), lecture coupée, `advance` —, avec la position que la liste connaît de lui.
  const handlePlayEpisode = useCallback(
    (episode: { itemId: string; title: string; resumeAt: number }) => {
      advanceTo(episode, {
        over: lifecycle.isOver() || episode.itemId === itemId,
        reportStop: () => reportStop("next"),
        stopReporting: stopPlaybackNow,
        playback,
      });
    },
    [itemId, playback, stopPlaybackNow, reportStop, lifecycle]
  );

  // Lu par les écouteurs de l'horloge, posés une fois pour toutes — voir `warmNextEpisode`.
  const nextEpisodeIdRef = useRef<string | null>(null);
  useEffect(() => {
    nextEpisodeIdRef.current = session.bench ? null : (nextEpisode?.itemId ?? null);
  }, [nextEpisode?.itemId, session.bench]);

  const handleExpand = useCallback(() => playback.expand(), [playback]);
  const { pos, size, isDragging, handlers } = useMiniPlayerDrag(isMini, handleExpand);
  // Le focus entre dans le lecteur, sur lecture/pause : il restait sur le bouton « Lecture » de la
  // fiche, sous le film, et Entrée — le centre d'une télécommande — l'actionnait (voir `usePlayerFocus`).
  usePlayerFocus(containerRef, !isMini);

  // Polled only while the panel is open: it is a debugging surface, not something to run twice a
  // second behind a closed drawer.
  useEffect(() => {
    if (!showInfo && !error && !stuck) return;
    const read = () => {
      try {
        setDiagnostics(remuxRef.current?.diagnostics ?? { Moteur: "non démarré" });
      } catch (error) {
        // A panel that silently shows nothing is worse than one that shows why.
        setDiagnostics({ "Diagnostic indisponible": error instanceof Error ? error.message : "erreur" });
      }
      // Le lien (§77) : pendant l'ouverture, le compteur qui suit chaque octet ; ensuite, les
      // trente dernières secondes de requêtes du moteur. `readLink` ne lève pas.
      const need = needBpsRef.current ?? diagNeedBps();
      setLinkLive(readLink(!ready && openingMeterRef.current ? openingMeterRef.current.measure() : diagLinkMeasure(), need));
    };
    read(); // straight away, not after the first tick
    const id = setInterval(read, 500);
    return () => clearInterval(id);
  }, [showInfo, error, stuck, ready]);


  /**
   * Ce que le lien livre pendant l'ouverture — de quoi dire, au moment de renoncer, si c'est lui
   * (« connexion trop lente », DECISIONS.md §77).
   *
   * Armé tant qu'aucune image n'est prête, et réarmé à chaque reconstruction (`openedAt`) : la
   * fenêtre mesurée est celle du minuteur d'abandon. Déclaré *avant* l'effet du pipeline, pour être
   * armé quand la source envoie ses premières requêtes (les effets partent dans l'ordre). Désarmé à
   * la première image : une lecture en cours ne passe jamais par le compteur.
   */
  useEffect(() => {
    if (ready) return;
    const meter = armOpeningMeter();
    openingMeterRef.current = meter;
    return () => disarmOpeningMeter(meter);
    // `measureEpoch` : réarmé au retour du premier plan — voir sa déclaration (§78).
  }, [ready, openedAt, measureEpoch]);
  useEffect(() => {
    needBpsRef.current = fileNeedBps(info?.sizeBytes, info?.runtimeSeconds);
  }, [info]);

  // Sets up the whole pipeline once the file's description has arrived. Everything it can refuse
  // is refused here, with the reason, rather than deeper down where the message would be opaque.
  useEffect(() => {
    if (!info && infoError) {
      /**
       * Sauf quand c'est le serveur qui manque : passer la main ne mène nulle part.
       *
       * Le lecteur stable a besoin du même Jellyfin. Lui céder la place sur une panne amont, c'est
       * refaire la même attente une seconde fois avant d'afficher le même échec — l'erreur met
       * alors deux fois plus longtemps à apparaître qu'à se produire.
       */
      // Une coupure réseau a son propre écran, posé par `onError` ci-dessus.
      if (!isUpstreamUnreachable(infoError) && !isNetworkFailure(infoError)) {
        fallToStable("les informations du fichier n'ont pas pu être récupérées");
      }
      return;
    }
    // Nothing is started for a file the server already refused: it named the reason, and the
    // stable player is the one that can negotiate around it.
    if (info?.refusedReason) {
      fallToStable(info.refusedReason);
      return;
    }
    // `playbackState` est attendu au même titre que la description : ouvrir le film sans savoir
    // où l'on en est, c'est l'ouvrir au mauvais endroit.
    if (!info || playbackState === undefined || !videoElRef.current) return;
    // Position inconnue et rien d'affirmé : pas d'ouverture à zéro (voir `positionUnknown`).
    if (playbackState?.positionUnknown && (session.resumeAt ?? null) === null && lifecycle.rebuildAt === null && positionRef.current <= 0) {
      trace("reprise : position inconnue (Jellyfin ne répond pas) — pas d'ouverture au début");
      return;
    }

    let cancelled = false;
    // Ce pipeline-ci a-t-il donné une image ? Propre à chaque ouverture — un changement de piste ou
    // une reconstruction en ouvre une neuve. `everReadyRef` (le lecteur a-t-il jamais joué) ne
    // suffisait pas : après la première image, une piste à PCE choisie au menu et refusée par Safari
    // n'était jamais essayée décodée — la piste d'avant revenait (chasse du 11/10/2026, B3).
    // Seulement à l'ouverture du film ou après un changement de piste (`pendingSwitchRef`) : une
    // reconstruction de récupération (arrière-plan, réseau) qui échoue n'est pas un refus du PCE —
    // la retenir ferait décoder pour toujours une piste que ce navigateur copiait.
    let pipelineShowedPicture = false;
    let unsubscribes: (() => void)[] = [];
    // Le traitement des voix demandé à CETTE ouverture : c'est lui qu'un échec désigne, pas le
    // réglage courant, qui a pu changer depuis.
    const openedDialogue = dialogueOpenRef.current;
    /**
     * Une ouverture avec « Améliorer les dialogues » qui échoue avant sa première image : on repart
     * une fois, au même endroit, sans le traitement — un réglage d'écoute ne doit jamais coûter le
     * film ni l'envoyer au lecteur serveur. Le réglage retenu sur l'appareil n'est pas effacé : le
     * film suivant le reprend.
     */
    const dropDialogue = (why: string): boolean => {
      if (openedDialogue === "off" || pipelineShowedPicture || dialogueFellBackRef.current) return false;
      if (!lifecycle.mayRebuild()) return true;
      dialogueFellBackRef.current = true;
      dialogueOpenRef.current = "off";
      setDialogueMode("off");
      const at = positionRef.current || startSeconds;
      trace(`dialogues améliorés impossibles ici (${why}) — reprise sans eux`);
      reportPlayback("rebuild", rebuildLine(describeFileRef.current(), `dialogues améliorés impossibles — ${why}`, at));
      showWarning(tRef.current("player.dialogue.unavailable"));
      restart(at, "dialogues améliorés impossibles, reprise sans eux");
      return true;
    };

    /**
     * Un AAC à PCE copié tel quel que ce navigateur refuse, avant toute image de ce pipeline : la
     * réponse est gardée (`takePceCopyRefusal`) et le pipeline reconstruit une seule fois en le
     * décodant ; le lecteur serveur ne vient qu'après (DECISIONS.md §62). Écrit une fois pour ses
     * deux appelants — l'erreur du moteur et l'échec de l'ouverture — dont la garde avait déjà dû
     * être corrigée deux fois à l'identique (`a69ecaa6`). Seul `refused` les distingue au journal :
     * « refusée » ou « refusée à l'ouverture ».
     *
     * La main passée ou la fermeture en cours : le refus est retenu (c'est un fait sur ce navigateur),
     * mais rien n'est écrit ni reconstruit — la règle de `c1a8160c`, que `dropDialogue` et
     * `revertFailedSwitch` suivaient déjà. Jusqu'au 23/10/2026 (audit F2-3, §116), la ligne `rebuild`
     * partait, puis `restart` refusait (« reprise refusée ») : une reconstruction écrite qui n'a
     * jamais eu lieu.
     */
    const pceRebuild = (message: string, refused: string): boolean => {
      if ((!everReadyRef.current || pendingSwitchRef.current) && !pipelineShowedPicture && !pceRebuildRef.current && takePceCopyRefusal(message)) {
        if (!lifecycle.mayRebuild()) return true;
        pceRebuildRef.current = true;
        const at = positionRef.current || startSeconds;
        reportPlayback("rebuild", rebuildLine(describeFileRef.current(), `copie AAC à PCE ${refused} — ${message}`, at));
        restart(at, "copie AAC à PCE refusée par le navigateur, décodée à la place");
        return true;
      }
      return false;
    };

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
    const applyPreferences = (
      audio: PlayerTrack[],
      subtitles: PlayerTrack[],
      /**
       * « Cette piste joue-t-elle par ce chemin ? », posée par celui qui sait répondre — le chemin
       * remultiplexé. Sans elle, le classement ignore ce critère.
       */
      carriable?: (track: PlayerTrack) => boolean,
      /** La piste sur laquelle ce chemin s'est ouvert — celle qu'on entend faute de préférence. */
      openedAudio: number | null = null,
      /**
       * Ce que ce chemin livrerait de chaque piste — canaux reçus, copie —, le départage de `rank`
       * depuis le 29/09/2026 (audit P5). Le même que celui de l'ouverture, sinon on bascule.
       */
      delivered?: (track: PlayerTrack) => { channels: number; copied: boolean }
    ): number | null => {
      const preferences = playbackState?.preferences ?? null;
      if (!preferences || preferencesAppliedRef.current || wantedAudioRef.current !== null || wantedSubtitleRef.current !== null) return null;
      // Une fois par lecteur. `null` dans les deux refs voulait dire à la fois « jamais choisi » et
      // « sous-titres éteints exprès » : chaque reconstruction (retour d'arrière-plan, source
      // perdue, réseau revenu) rallumait les sous-titres que le spectateur venait de couper
      // (relu le 24/09/2026).
      preferencesAppliedRef.current = true;

      // La même question que celle posée à l'ouverture, et il faut qu'elle le reste : une piste
      // que ce chemin ne porte pas ne doit pas être « voulue », sinon on ouvre sur l'une et on
      // bascule vers l'autre — ou, pire, on cède la place au lecteur serveur alors qu'une piste
      // de la même langue joue très bien ici. Voir `preferredAudio` et `rank`.
      const wantedAudio = chooseAudioTrack(audio, preferences, carriable, delivered);
      // La langue qu'on entend vraiment : sans préférence, celle de la piste ouverte, et non celle
      // que le fichier marque par défaut — une VO japonaise marquée par défaut sous une piste
      // française ouverte donnait des sous-titres complets en français sur du français (23/09/2026).
      const spoken = trackLanguage(wantedAudio ?? audio.find((track) => track.number === openedAudio) ?? audio.find((track) => track.isDefault) ?? audio[0] ?? {
        language: null,
        name: null,
        isDefault: false,
        isForced: false,
      });
      const wantedSubtitle = chooseSubtitleTrack(
        [...subtitles, ...(info.externalSubtitles ?? []).map(externalToPlayerTrack)],
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

    /**
     * « Deux sous-titres » retenu sur l'appareil (§87) : réappliqué une fois par lecteur, après les
     * préférences du compte, si ses langues existent dans ce titre — sinon un seul sous-titre. Pas
     * pendant un banc d'essai, qui mesure la lecture telle qu'elle s'ouvre.
     */
    const applyDualMemory = (subtitles: PlayerTrack[]) => {
      if (dualMemoryAppliedRef.current || session.bench) return;
      dualMemoryAppliedRef.current = true;
      const externalsNow = info.externalSubtitles ?? [];
      const pair = pickRememberedDual([...subtitles, ...externalsNow.map(externalToPlayerTrack)], wantedSubtitleRef.current, dualSubtitleMemory.read());
      if (!pair) return;
      trace(`deux sous-titres retenus : principal ${pair.primary.number}, second ${pair.second.number}`);
      if (wantedSubtitleRef.current !== pair.primary.number) chooseSubtitle(pair.primary.number, externalsNow);
      chooseSecond(pair.second.number, externalsNow);
    };

    // Timed from here rather than from the `openedAt` state: that one is reset by a restart, so
    // depending on it would make every restart rebuild the pipeline a second time.
    const attemptStartedAt = Date.now();
    let announced = false;
    /** Written once per pipeline: what was actually chosen, and how long it took to get there. */
    const announceStart = (chosen: "remux", why: string | null) => {
      if (announced) return;
      announced = true;
      reportPlayback("start", {
        ...describeFileRef.current(),
        path: chosen,
        reason: why ?? "",
        openedInMs: Date.now() - attemptStartedAt,
        at: startSeconds,
        rebuild: rebuildCount,
        // L'écran tel que le navigateur le voit, et le plafond de lumière HDR qui en découle —
        // voir hdrDisplay.ts. De quoi relire au journal pourquoi un film HDR a le rendu qu'il a.
        displayHdr: displayIsHdr() ?? "inconnu",
        hdrLightCap: hdrLightCap() ?? "natif",
        // Le choix d'où vient ce plafond : « auto » d'office, ou un réglage fait à la main.
        hdrChoice: String(readHdrCapChoice()),
        wideGamut: displayIsWideGamut() ?? "inconnu",
        // D'où l'ouverture a été servie — l'appareil, le réseau, ou les deux —, et combien d'octets
        // venaient de l'appareil : de quoi comparer `openedInMs` avant et après la reprise
        // instantanée (`src/lib/resumeCache/`, 25/09/2026).
        ...openingFacts(info.streamUrl),
        // Le plan d'un AAC à PCE (copie, réécriture, décodage) et la réponse gardée du navigateur —
        // de quoi lire, la prochaine fois, pourquoi « Ruby » est passé ou non (DECISIONS.md §62).
        ...pceDecisionFacts(),
        // Et, décodé, par quel décodeur : FFmpeg en WebAssembly hors Chromium, le navigateur sinon.
        ...aacRouteFacts(),
        // Écrit seulement quand il est actif : la ligne de tout autre compte ne change pas.
        ...(openedDialogue !== "off" ? { dialogue: openedDialogue } : {}),
        // Ce que la réserve d'avance s'autorise sur cet appareil — c'était la ligne `reserve/départ`,
        // une requête de plus à chaque pipeline (13/10/2026, `reservePlanFacts`).
        ...reservePlanFacts(),
      });
    };

    // A pipeline that has just become ready cannot owe a resume or a track change: whatever the
    // previous one was waiting for died with it, and a wait nobody will ever answer is a spinner
    // that never stops. Cleared where readiness is declared rather than in an effect watching
    // for it, so nothing is left hanging for a render.
    const declareReady = () => {
      setStartingAt(null);
      // The position this pipeline was built to resume at has now been used, and is cleared here
      // rather than from an effect watching readiness. That effect could land *after* a newer
      // failure had already written the next position — and it did: a source lost in the same
      // tick as the start had its position wiped, so the film began again from zero instead of
      // resuming. Cleared at the exact moment the pipeline that consumed it is running, nothing
      // written afterwards can be undone by it.
      lifecycle.ready();
      // Un saut demandé pendant la reconstruction, ailleurs que là où elle a rouvert : il est
      // honoré maintenant, sur le lecteur neuf, au lieu d'être écrasé par sa position de départ.
      const asked = seeks.consumeAtReady(startSeconds);
      if (asked !== null) {
        const media = videoElRef.current;
        if (media) media.currentTime = asked;
      }
      pictureAtRef.current = Date.now();
      setReady(true);
      setAnnounced(true);
      // Une image : si un AAC à PCE a été copié tel quel, ce navigateur le prend — c'est gardé.
      notePceCopyWorked();
      everReadyRef.current = true;
      pipelineShowedPicture = true;
      pceRebuildRef.current = false;
    };
    // Where to open. A rebuild that asked for a position gets it; otherwise the film resumes
    // where it actually is, and only a player that has never played anything falls back to where
    // it was told to start. Without that last part, a rebuild nobody asked for — and there was
    // one, every time the player was minimised — sent the film back to where it began.
    let startSeconds = lifecycle.openingSeconds(positionRef.current, session.resumeAt, playbackState?.resumeSeconds);
    // Reprendre quelques secondes avant, à la première ouverture seulement — jamais pour une
    // reconstruction, qui rouvre là où l'image vient de s'arrêter. Voir `resumeRewind.ts`.
    if (!openingDecidedRef.current) {
      openingDecidedRef.current = true;
      // Ni pour une scène (§91) : elle part déjà cinq secondes avant la réplique.
      if (lifecycle.rebuildAt === null && recordsResume(session.bench, isSceneRef.current)) {
        // La même règle que celle qui choisit, en arrière-plan, quels octets garder pour une reprise
        // instantanée (`src/lib/resumeCache/`) : une seule fonction, pour que les deux ne visent
        // jamais deux positions différentes.
        const earlier = openingPosition(itemId, startSeconds, info.runtimeSeconds);
        if (earlier < startSeconds) trace(`reprise : ${startSeconds.toFixed(1)} s, reculée à ${earlier.toFixed(1)} s`);
        startSeconds = earlier;
      }
    }
    // Connue avant que le moteur n'ouvre quoi que ce soit : entre ici et la première image il
    // s'écoule le temps de télécharger un en-tête et un groupe d'images, et une fermeture dans
    // cette fenêtre rapportait zéro.
    positionRef.current = startSeconds;
    positionKnownRef.current = true;

    // The file decides which pipeline runs, not a setting: repackaging it for the browser's own
    // decoder is better on every axis when the codecs allow it, and decoding it ourselves is the
    // fallback for when they do not. Whichever loses says why, in the technical panel.
    const startRemux = async (element: HTMLVideoElement, begin: (video: HTMLVideoElement) => Promise<RemuxPlayback>) => {
      const playback = await begin(element);
      if (cancelled) return playback.destroy();
      // Arrivé après que le lecteur a passé la main, ou pendant sa fermeture : il ne sert plus. Sans
      // cela, un pipeline lent qui aboutissait après l'abandon (sans lecteur serveur) se déclarait
      // prêt et lançait le son sous l'écran d'erreur (relu le 27/09/2026).
      if (lifecycle.isOver()) return playback.destroy();

      remuxRef.current = playback;
      /*
       * Le chemin retenu, noté au moment où il est choisi.
       *
       * Ce ref ne servait qu'au rapport d'échec, et il était recopié depuis l'état — donc un rendu
       * après la décision. Un échec survenant dans cet intervalle se rapportait « non décidé », et
       * neuf replis du journal disent exactement ça : le seul champ qui aurait dit ce que le lecteur
       * tentait est vide sur les seules lectures qui ont échoué. Il est écrit ici, en même temps
       * que l'état, dans l'effet qui décide — jamais pendant un rendu. (L'effet qui le recopiait
       * encore depuis l'état, sans plus rien y changer, a été retiré le 22/10/2026.)
       */
      pathRef.current = "remux";
      setPath("remux");
      announceStart("remux", "remultiplexage → lecteur natif");
      setTracks({ audio: playback.audioTracks, subtitles: playback.subtitleTracks });
      // Une question annexe, posée sur le chemin du démarrage : elle ne doit jamais en devenir la
      // panne (CLAUDE.md). Sans réponse, le menu ne dit simplement rien de la piste.
      try {
        setDialogueShapeable(new Set(playback.audioTracks.filter((track) => playback.canShapeDialogue(track.number)).map((track) => track.number)));
      } catch {
        setDialogueShapeable(new Set(playback.audioTracks.map((track) => track.number)));
      }

      // Given back what the viewer had chosen, if this pipeline is a replacement for one that
      // had it. A film that comes back after a network cut in the wrong language, with the
      // subtitles gone, has not really come back.
      // What the viewer chose, if this pipeline replaces one that had it — and otherwise what
      // their account asks for, which is what a first opening gets.
      const preferred = applyPreferences(
        playback.audioTracks,
        playback.subtitleTracks,
        (track) => playback.canCarryAudio(track.number),
        playback.currentAudioTrack,
        // Sans réponse du chemin, les canaux de la source et aucune copie : le classement d'avant.
        (track) => track.delivered ?? { channels: track.channels ?? 0, copied: false }
      );
      applyDualMemory(playback.subtitleTracks);
      const wantedAudio = wantedAudioRef.current ?? preferred;
      const wantedSubtitle = wantedSubtitleRef.current;
      // A track number from a file beside the film means nothing to a pipeline reading the
      // file itself; it is answered here instead, out of what was already fetched.
      if (wantedSubtitle !== null && !isExternalTrack(wantedSubtitle)) playback.selectSubtitleTrack(wantedSubtitle);
      setCurrentSubtitle(wantedSubtitle);
      setCurrentAudio(playback.currentAudioTrack);
      declareReady();
      // La réserve d'avance en mémoire, à côté de ce lecteur-ci — voir `MemoryReserve`. Celle d'un
      // lecteur remplacé a été arrêtée par le nettoyage de l'effet, ses morceaux laissés au relais de
      // la source : celle-ci les a repris. Pendant un banc aussi : c'est la lecture que le banc éprouve.
      try {
        const context = playback.reserveContext?.();
        // Une seule réserve par source, quoi qu'il arrive ; ses morceaux restent à celle qui suit.
        reserveRef.current?.stop("remplacée", true);
        // Ses lignes `reserve`, décrites comme les autres lignes du lecteur (fichier, séance, appareil).
        const report = (fields: Record<string, unknown>) => reportPlayback("reserve", { ...describeFileRef.current(), path: "remux", ...fields });
        // Le temps regardé de la séance, qui survit aux reconstructions : la réserve attend une
        // minute de lecture réelle avant de rien télécharger (`START_AFTER_WATCHED_SECONDS`).
        reserveRef.current = context ? MemoryReserve.start({ ...context, watched: () => watched.seconds(Date.now()) }, report) : null;
      } catch {
        reserveRef.current = null;
      }
      // Un changement de piste qui a demandé cette reconstruction : il se termine ici, sur la
      // piste voulue, et c'est ici qu'on sait combien il a coûté.
      const pendingSwitch = pendingSwitchRef.current;
      if (pendingSwitch) {
        pendingSwitchRef.current = null;
        reportAudioSwitch(pendingSwitch.from, pendingSwitch.fromLabel, pendingSwitch.to, pendingSwitch.startedAt, playback, "reconstruction");
        // Un choix à la main, arrivé sur la piste voulue : la langue retenue par série en tient compte
        // (`seriesLanguage.ts`). Ni le banc ni un extrait de test n'en disent rien du spectateur.
        if (playback.currentAudioTrack === pendingSwitch.to && observesViewerRef.current) {
          const chosen = playback.audioTracks.find((track) => track.number === pendingSwitch.to);
          noteSeriesLanguage(itemId, toJellyfinLanguage(chosen ? trackLanguage(chosen) : null));
        }
      }
      // La piste voulue n'est pas celle sur laquelle on a ouvert : on reconstruit dessus, comme
      // pour tout changement de piste. Rare — l'ouverture et l'écran choisissent avec la même
      // fonction. Sur un fichier sans index en cours de film, la demande est refusée (avertissement
      // compris) et la piste ouverte continue.
      // Une piste que ce chemin ne portera jamais : la même réponse que depuis le menu — le
      // lecteur serveur, qui sait la porter. Demandée comme un changement de piste, elle
      // reconstruisait sur la piste d'avant, puis redemandait, sans fin (relevé le 23/09/2026 :
      // un compte réglé sur le japonais, une piste Opus 3.0 sur iPhone).
      if (wantedAudio !== null && wantedAudio !== playback.currentAudioTrack && !playback.canCarryAudio(wantedAudio)) {
        const wanted = playback.audioTracks.find((track) => track.number === wantedAudio);
        fallToStable(`la piste ${wanted?.codecId ?? "demandée"} ne peut pas être portée ici`, {
          // À l'ouverture, là où le film s'ouvre — voir `PlaybackSession.resumeAt`.
          resumeAt: startSeconds,
          audioStreamIndex: jellyfinAudioIndex(playback.audioTracks, info?.audio, wantedAudio),
        });
        return;
      }
      const openingSwitch =
        wantedAudio !== null && wantedAudio !== playback.currentAudioTrack
          ? playback.requestAudioTrack(wantedAudio)
          : null;
      if (openingSwitch === "rebuild" && wantedAudio !== null && lifecycle.mayRebuild()) {
        beginAudioSwitch(playback, wantedAudio);
        restart(startSeconds, `piste ${wantedAudio} voulue, autre que celle ouverte — reconstruction sur elle`);
        return;
      }
      if (openingSwitch === "refused" && wantedAudio !== null) {
        reportAudioSwitch(playback.currentAudioTrack, playback.diagnostics["Audio"] ?? "", wantedAudio, Date.now(), playback, "refus");
      }

      // La lecture notée et le recul après une longue pause : `habitWatch`, commun aux deux lecteurs
      // (§28, §115). Ici, une pause compte toujours (même sans image), et le recul est tracé. Et la
      // position rapportée au registre des tentatives, que le natif ne nourrissait pas (§67, §116).
      const habits = habitWatch({
        itemId,
        bench: session.bench,
        isScene: () => isSceneRef.current(),
        pauseCounts: () => true,
        isEnded: () => lifecycle.isEnded(),
        onRewind: (target, pausedAt) => trace(`reprise après ${Math.round((Date.now() - pausedAt) / 60_000)} min de pause : ${target.toFixed(1)} s`),
        notePosition: (seconds) => tally.retries.notePosition(seconds),
      });
      const onTime = () => {
        positionRef.current = element.currentTime;
        showSubtitleAt(element.currentTime, (at, track) => playback.subtitleAt(at, track), playback.presentationDelay);
        // Retenu toutes les quinze secondes de lecture : ce qui distingue, à la prochaine
        // ouverture, un relais d'une vraie reprise (voir `resumeRewind.ts`).
        habits.time(element);
        warmNextNear(nextEpisodeIdRef.current, element.currentTime, element.duration, info.creditsStart ?? null);
      };
      // A warning about not being able to reach a position is obsolete the instant pictures are
      // moving again. Leaving it up made a recovered hiccup look like a lasting fault.
      const onPlay = () => {
        // Après une longue pause, quelques secondes en arrière pour se remettre dans la scène.
        // Pas après la fin — c'est « Revoir », ou un épisode relancé —, ni pendant un saut.
        habits.play(element);
        background.notePlaying();
        setPlaying(true);
        setEnded(false);
        showWarning(null);
        reopenAfterEnd();
      };
      const onPause = () => {
        setPlaying(false);
        background.notePaused(Date.now(), { visible: document.visibilityState === "visible", ended: element.ended });
        tally.waitEnded(Date.now());
        endWait(diagWaitEnded());
        // Un saut posé en pause a son image : il n'attend plus rien (§78).
        if (element.paused && !element.seeking) runner.seekDone();
        habits.pause(element);
      };
      /**
       * Les attentes en pleine lecture — voir `SessionTally`. Ni celles d'un saut, qui a sa ligne,
       * ni celle d'avant la première image de ce lecteur, qui est l'ouverture.
       */
      let playedOnce = false;
      const onWaiting = () => {
        // Au fil : les attentes de moins de 250 ms n'entrent pas au bilan (`waits`), et c'est
        // justement l'un de ces « second petit chargement » après l'ouverture qu'il fallait voir
        // (10/10/2026) — voir la ligne `opening`.
        trace(`élément : en attente à ${element.currentTime.toFixed(2)} s${element.seeking ? " (saut)" : ""}, readyState ${element.readyState}`);
        if (playedOnce && !element.seeking && !seeks.pending()) {
          tally.waitStarted(Date.now());
          diagWaitStarted(leadAt(element));
          if (stallAtRef.current === null) {
            stallAtRef.current = Date.now();
            setStallAt(stallAtRef.current);
          }
          if (networkUnstable()) setStallUnstable(true);
          // Un blocage qui dure : à 5 s, la bascule s'il tient au réseau (§78).
          stalls.started(() => {
            const wait = diagCurrentWait();
            return wait ? networkStall(wait.verdict) : null;
          });
        }
      };
      /**
       * Les blocages en pleine lecture, pour la bascule sur des saccades (§78) : réseau d'après le
       * diagnostic, sous un débit mesuré inférieur au besoin, jamais pendant une coupure (elle a son
       * message), jamais page cachée. Ceux d'un saut n'y entrent jamais : `onWaiting` ne les compte pas.
       * La règle de bascule et son minuteur de 5 s : `StallSignals`, commun aux deux lecteurs (§115).
       */
      const stalls = new StallSignals(() => stutter, {
        onSwitch: (kind) => offerStutterRef.current(kind),
        onPrewarm: () => playbackDecisionRef.current(false, true),
      });
      /** L'attente en pleine lecture est finie (image, pause, saut, fin) : le mot s'en va avec elle. */
      const endStall = () => {
        if (stallAtRef.current === null) return;
        clearStall();
      };
      const networkStall = (verdict: string) =>
        verdict === "réseau" &&
        document.visibilityState !== "hidden" &&
        !networkUnstable() &&
        playbackLinkSlow(diagLinkMeasure(PLAYBACK_MEASURE_WINDOW_MS), needBpsRef.current);
      const endWait = (wait: { verdict: string; ms: number } | null) => {
        endStall();
        // Le texte du simulateur de la page de test : la durée et le verdict du diagnostic.
        stalls.ended(
          Date.now(),
          wait ? { ms: wait.ms, text: `blocage de ${Math.round(wait.ms)} ms (${wait.verdict})`, network: () => networkStall(wait.verdict) } : null
        );
      };
      const onPlaying = () => {
        trace(`élément : repart à ${element.currentTime.toFixed(2)} s`);
        playedOnce = true;
        // L'image est là : un saut qui l'attendait n'attend plus (§78).
        runner.seekDone();
        tally.waitEnded(Date.now());
        endWait(diagWaitEnded());
      };
      const onSeeking = () => {
        tally.waitAbandoned();
        diagWaitEnded(false);
        endStall();
        stalls.cancel();
        // Un saut en pleine lecture attend son image : traité comme une ouverture au-delà de 10 s (§78).
        if (playedOnce) runner.seekStarted();
      };
      const onEnded = () => {
        setPlaying(false);
        setEnded(true);
        endStall();
        // La fin est annoncée à Jellyfin tout de suite : c'est cet arrêt, en fin de fichier, qui
        // marque le film « vu ». Il ne partait qu'à la fermeture — « Revoir » le remplaçait par
        // la position de la seconde vision, et une application tuée en arrière-plan sur l'écran
        // de fin ne l'envoyait jamais (relevé le 23/09/2026).
        void stopPlaybackRef.current();
        lifecycle.noteEnded();
        // « Fin de l'épisode » : l'écran de fin, et la mise en veille au journal.
        holdAtEndRef.current();
        // Fini : ses octets gardés pour une reprise instantanée n'ont plus rien à reprendre. Effacés
        // en arrière-plan ; le prochain passage l'aurait fait aussi, le titre quittant « Reprendre ».
        // La réserve d'avance, elle, reste : elle ne vit qu'en mémoire, n'écrit rien sur l'appareil,
        // et à la fin du fichier elle n'a plus rien à prendre — mais « Revoir » repart au début sur
        // ce même pipeline, et l'arrêter ici l'en privait pour tout le second visionnage (chasse aux
        // défauts du 28/09). Elle s'arrête avec le pipeline.
        // Ni pour une scène (§91) : finie, elle ne dit rien de la reprise du vrai visionnage, dont
        // les octets gardés restent utiles (relecture du 14/10/2026).
        if (recordsResume(session.bench, isSceneRef.current)) forgetResumeCache(itemId);
      };
      // Le saut demandé est atteint : la position lue redevient la vérité.
      const onSeeked = () => {
        // Posé en pause, ou de quoi repartir aussitôt : ce saut n'attend plus son image (§78). Sans cela,
        // un saut fait en pause devenait, dix secondes plus tard, une « ouverture » à préchauffer.
        if (element.paused || element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) runner.seekDone();
        const timing = seeks.seeked(element.currentTime);
        // Posée ailleurs que la cible — sur le premier média, sur l'image clé suivante — mais
        // arrivée selon la source : la cible demandée ne vaut plus (voir `HostSeek.settled`). Lu
        // après ce tour : la source écoute le même événement, et après l'hôte.
        // Posé ailleurs et fini : sa ligne part ici, avec l'endroit où il est tombé.
        setTimeout(() => {
          const landed = seeks.settled(remuxRef.current?.seekPending, element.seeking);
          if (!landed) return;
          tally.seekArrived(seekElapsed(tally, landed));
          reportUnarrivedSeekRef.current(landed, element.currentTime, false, false);
        }, 0);
        if (timing) {
          tally.seekArrived(seekElapsed(tally, timing));
          // Les champs et leur ordre : `seekLineFields`, partagé avec `reportUnarrivedSeek`.
          reportPlayback("seek", { ...describeFileRef.current(), ...seekLineFields(tally, timing) });
        }
      };
      element.addEventListener("timeupdate", onTime);
      element.addEventListener("play", onPlay);
      element.addEventListener("pause", onPause);
      element.addEventListener("ended", onEnded);
      element.addEventListener("seeked", onSeeked);
      element.addEventListener("waiting", onWaiting);
      element.addEventListener("playing", onPlaying);
      element.addEventListener("seeking", onSeeking);
      // Le temps regardé s'arrête pendant une attente de l'élément (`WatchedClock.stall`).
      unsubscribes.push(watchElementWaits(element, watched));
      unsubscribes.push(() => {
        // Le blocage de 5 s en attente meurt avec ce pipeline : il ne doit rien décider pour le suivant.
        stalls.cancel();
        element.removeEventListener("timeupdate", onTime);
        element.removeEventListener("play", onPlay);
        element.removeEventListener("pause", onPause);
        element.removeEventListener("ended", onEnded);
        element.removeEventListener("seeked", onSeeked);
        element.removeEventListener("waiting", onWaiting);
        element.removeEventListener("playing", onPlaying);
        element.removeEventListener("seeking", onSeeking);
      });

      // Reconstruit pour un changement de piste pendant une pause : il reste en pause.
      if (lifecycle.consumeKeepPaused()) return;
      // Une coupure signalée pendant l'attache : l'écran de coupure est là, et le nouvel essai
      // rouvrira à sa position — ce qui est en tampon ne doit pas jouer derrière lui.
      if (lifecycle.isNetworkLost()) return;
      await element.play().catch(() => {});
    };

    /**
     * Un changement de piste qui a demandé cette reconstruction et qui n'aboutit pas : on rouvre
     * sur la piste d'avant, avec un mot, au lieu de laisser le film glisser vers un autre lecteur.
     * Une seule fois — la réouverture n'a plus de changement en attente, donc un second échec
     * suit le chemin ordinaire. Relevé par la relecture du 22/09/2026 : avant la livraison par
     * piste, un changement raté laissait la piste d'avant jouer ; il ne faut pas perdre ça.
     */
    const revertFailedSwitch = (why: string): boolean => {
      const pending = pendingSwitchRef.current;
      if (!pending || pending.from === null) return false;
      // Le lecteur a passé la main ou se ferme : rien à rétablir, et surtout rien à écrire — une
      // ligne `audio` après la ligne `stop`, un menu qui change sous un écran qui part.
      if (!lifecycle.mayRebuild()) return true;
      pendingSwitchRef.current = null;
      trace(`changement de piste impossible par ce lecteur (${why}) — retour à la piste ${pending.from}`);
      reportPlayback("audio", {
        ...describeFileRef.current(),
        from: pending.from,
        to: pending.to,
        via: "reconstruction",
        applied: false,
        tookMs: Date.now() - pending.startedAt,
        reason: why,
        at: Math.round(positionRef.current),
      });
      wantedAudioRef.current = pending.from;
      setCurrentAudio(pending.from);
      showWarning(tRef.current("player.experimental.audioTrackRefused"));
      restart(startSeconds, "retour à la piste d'avant, que le lecteur natif sait ouvrir");
      return true;
    };

    const element = videoElRef.current;
    // Gardée pour la ligne de fin de séance : au démontage, React a déjà détaché la ref.
    lastVideoElRef.current = element;
    // Le préchauffage d'un relais de zone (§93) ne tient pas pendant une pause : arrêté chez Jellyfin,
    // refait à la reprise si la zone est toujours devant.
    const onZonePause = () => zoneHandover.paused();
    const onZonePlay = () => zoneHandover.played();
    element.addEventListener("pause", onZonePause);
    element.addEventListener("play", onZonePlay);
    unsubscribes.push(() => {
      element.removeEventListener("pause", onZonePause);
      element.removeEventListener("play", onZonePlay);
    });
    probePlaybackPath({
      streamUrl: info.streamUrl,
      // La taille, déjà dans la description du fichier : l'ouverture n'a plus à la demander par
      // un HEAD, et les deux premières plages partent sans attendre cet aller-retour.
      knownSize: info.sizeBytes,
      // Sa version (l'ETag de la MediaSource) : l'en-tête gardé en mémoire est nommé par elle et
      // l'adresse, qu'un fichier remplacé au même chemin garde — voir `mediaHeaderKey`.
      fileVersion: info.fileVersion ?? null,
      // L'en-tête, l'index et le passage de reprise, s'ils sont gardés sur l'appareil pour ce
      // fichier-là (`src/lib/resumeCache/`). Vérifiés contre ce que la description dit du fichier ;
      // l'ouverture ne les attend que 150 ms au plus.
      disk: openDiskChunks({ itemId, streamUrl: info.streamUrl, size: info.sizeBytes, fileVersion: info.fileVersion ?? null }),
      startSeconds,
      // Ce que le serveur sait de la plage dynamique : le conteneur seul ne suffit pas à décider
      // si un Dolby Vision refusé a une couche de base où se rattraper. Voir `planDolbyVision`.
      videoRangeType: info.video?.rangeType ?? null,
      // Connue avant que quoi que ce soit ne soit ouvert — elle vient de la même charge que la
      // position de reprise. La donner ici évite le changement de piste immédiat qui suivait le
      // démarrage, et qui était le plus cher de tous ceux qu'on a mesurés.
      audioPreferences: playbackState?.preferences ?? null,
      // Ce que le spectateur a choisi, si ce pipeline en remplace un : on ouvre dessus, au lieu
      // d'ouvrir ailleurs puis d'y basculer. Voir `openingAudio`.
      audioTrackNumber: wantedAudioRef.current,
      // « Améliorer les dialogues », lu à cette ouverture — absent tant qu'il est désactivé.
      ...(openedDialogue !== "off" ? { dialogue: openedDialogue } : {}),
      // Reconstruit pour un changement de piste pendant une pause : rien ne doit le relancer, ni
      // ce composant (voir startRemux) ni la garde de démarrage de la source.
      startPaused: lifecycle.keepPaused,
      onError: (message, kind, facts) => {
        // Une zone illisible (§93), la tête arrivée au relais : rien de ce qui suit ne la concerne —
        // ni reconstruction (la même zone attendrait), ni piste, ni dialogues. La main passe.
        if (facts?.unreadableZone === true) {
          handZone(message, typeof facts.resumeAt === "number" ? facts.resumeAt : positionRef.current, facts);
          return;
        }
        // A network failure is not this path's fault and not this path's to fix.
        if (kind === "network") {
          // Le lecteur a passé la main ou se ferme : une coupure n'a plus d'écran à montrer
          // (`enterNetworkLost` le vérifie). Ligne `network` et position gardée : ici seulement.
          enterNetworkLost(message, `réseau : lecture interrompue — ${message}`, true);
          return;
        }
        // Un AAC à PCE copié tel quel — hors Chromium, comme avant le 10/10/2026 — que ce navigateur
        // refuse à l'envoi, avant toute image : la réponse est gardée et le pipeline reconstruit une
        // seule fois en le décodant ; le lecteur serveur ne vient qu'après (DECISIONS.md §62).
        if (pceRebuild(message, "refusée")) return;
        if (dropDialogue(message)) return;
        // Page cachée : la reconstruction attend le retour, comme une source fermée sans erreur —
        // la vérification d'arrière-plan plus bas la fera, à la position et avec la retenue du
        // retour. iPhone, 21/10/2026 : un réveil après 34 min d'écran verrouillé, un « Media failed
        // to decode » avant que la page soit visible, et trois reconstructions refusées en 20 ms ont
        // épuisé le budget et passé le film au lecteur serveur pour rien.
        if (remuxRef.current?.lost && typeof document !== "undefined" && document.visibilityState === "hidden") {
          trace(`source perdue page cachée — reconstruction au retour (${message})`);
          return;
        }
        // A closed source is not a fault to report, it is a pipeline to build again. Safari
        // closes one from time to time — a decode failure it will not explain, sometimes on a
        // seek, sometimes at a change of track — and everything that follows is wreckage. The
        // machinery for the sleep case already knows how to come back at the right position, so
        // it is used here too, and only a loss that keeps happening is finally reported.
        // Le même endroit deux fois, c'est ce que la plateforme ne peut pas prendre : la décision
        // (budget, saut au-delà du passage) est dans `lifecycle.sourceLost`.
        // Avant la première image de la lecture, pas de saut au-delà : voir `sourceLost`.
        const lost = remuxRef.current?.lost ? lifecycle.sourceLost(remuxRef.current.position || positionRef.current, Date.now(), pictureSeenRef.current) : null;
        if (lost?.kind === "ignore") return;
        if (lost?.kind === "rebuild") {
          const { at, from: where, skipped: again, attempt } = lost;
          reportPlayback(
            "rebuild",
            rebuildLine(describeFileRef.current(), message, at, {
              attempt,
              skipped: again,
              // Un retour d'arrière-plan récent, s'il y en a un — voir `backgroundFacts`.
              ...tally.backgroundFacts(Date.now()),
              // Les tampons et la trace au moment de la perte : sans eux, un « Media failed to
              // decode » ne disait pas si c'étaient nos données ou l'appareil (23/09/2026).
              ...remuxRef.current?.lossReport(),
            })
          );
          restart(
            at,
            `la source a été perdue (${attempt})` +
              (again ? `, au-delà de ${where.toFixed(1)} s qui vient d'échouer` : "")
          );
          // Only the first of these is the viewer's business: a passage of the film is being
          // skipped, and a jump nobody explained looks like a fault. Rebuilding in place and
          // carrying on is not something they need to be told about — it is in the record.
          if (again) showWarning(tRef.current("player.experimental.passageSkipped"));
          return;
        }
        // Une perte au bout du budget de reconstructions : la ligne `fallback` (ou `error` sans
        // lecteur serveur) porte le même relevé que `rebuild` — tampons au dernier envoi, images,
        // fragment sous la tête (14/10/2026). Le relais lui-même n'en dépend pas.
        let lossFacts: Record<string, unknown> | undefined;
        if (lost?.kind === "giveUp") {
          try {
            lossFacts = remuxRef.current?.lossReport();
          } catch {
            lossFacts = undefined;
          }
        }
        fallToStable(message, undefined, lossFacts);
      },
      // La lecture en avance a atteint une zone illisible (§93) : préparer le relais — ou, sur WebKit en
      // HLS natif, le faire tout de suite, à la tête.
      onUnreadableZone: (event) => {
        if (lifecycle.isOver()) return;
        if (zoneHandover.event(event) === "immediate") {
          handZone(event.zone.message, positionRef.current, {
            unreadableZone: true,
            zoneByte: event.zone.byteOffset,
            zoneSeconds: Math.round(event.zone.zoneSeconds * 10) / 10,
            at: Math.round(positionRef.current * 10) / 10,
            immediate: true,
          });
        }
      },
      onWarning: showPipelineWarning,
      onStarting: (at) => {
        setStartingAt(at);
        // Seules les reprises comptent : la toute première lecture est l'ouverture, que la ligne
        // `start` mesure déjà (`openedInMs`).
        if (at !== null) {
          if (readyRef.current) tally.resumeStarted(at);
        } else {
          tally.resumeEnded(Date.now());
        }
      },
      // Une horloge qui ne bouge plus alors que l'élément dit jouer : écrit tel quel, une fois par
      // blocage. Rien à décider ici — les reprises sont déjà en cours dans la source.
      onStall: (facts) => reportPlayback("stall", { ...describeFileRef.current(), path: "remux", ...facts, ...tally.backgroundFacts(Date.now()) }),
    })
      .then((probe) => {
        if (cancelled) {
          // Abandoned before it could be used, and it is holding a decoder, an encoder and an
          // open stream. Nothing else will ever come back for them.
          probe.discard();
          return;
        }
        // Le chemin retenu, nommé ici : le rapport technique le montre aussi quand tout va bien,
        // et pas seulement quand la lecture se dégrade.
        setPathReason(NATIVE_PATH);
        return startRemux(element, probe.start);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "Le fichier n'a pas pu être ouvert.";
        // A file that could not even be opened because there is no network is not a file this
        // player cannot play. It gets the waiting screen, like a cut that happens mid-film.
        if (isNetworkFailure(cause)) {
          enterNetworkLost(message, `réseau : ouverture impossible — ${message}`);
          return;
        }
        // Un AAC à PCE copié tel quel que ce navigateur refuse PENDANT l'ouverture — avant même que
        // le chemin soit choisi : le segment d'initialisation est envoyé là. C'est ce que montrait
        // l'iPhone de Louis le 11/10/2026 (« Elle s'appelle Ruby », `path: "non décidé"`) : le refus
        // n'arrivait jamais au `onError` du pipeline, et le film partait au lecteur serveur sans la
        // reconstruction prévue. Retenu pour cette forme, reconstruit une fois en décodant
        // (DECISIONS.md §62) ; le lecteur serveur ne vient qu'après.
        if (pceRebuild(message, "refusée à l'ouverture")) return;
        // Reconstruit pour une piste que le lecteur natif n'a finalement pas pu ouvrir — module
        // TrueHD injoignable, encodeur qui refuse : le lecteur serveur coûterait un film qui jouait
        // très bien, pour un choix de langue. On revient à la piste d'avant.
        if (dropDialogue(message)) return;
        if (revertFailedSwitch(message)) return;
        fallToStable(message);
      });

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      // Ses morceaux restent à la source, que `destroy` ferme en les laissant au relais : une
      // reconstruction sur le même fichier les retrouve. Une fermeture du lecteur les rend au bout
      // de quelques secondes (`HANDOVER_MS`).
      reserveRef.current?.stop("fin du pipeline", true);
      reserveRef.current = null;
      remuxRef.current?.destroy();
      remuxRef.current = null;
    };
  // `reportAudioSwitch` ne dépend que de `tally`, fixé au montage : son identité ne change jamais,
  // donc l'ajouter ici ne peut pas relancer la construction du pipeline. C'est la seule raison
  // pour laquelle il peut y figurer — voir la note sur les rappels lus à travers une `ref`. Même
  // chose pour `showPipelineWarning`, qui ne dépend que de `showWarning`, stable lui aussi, et
  // pour `tally`, créé une fois au montage (`useState`) et jamais remplacé, pour
  // `reopenAfterEnd`, qui ne dépend que de `lifecycle` — créé une fois au montage (`useState`),
  // comme `tally`, `seeks` et `background` —, et pour `itemId` et `session.bench`,
  // fixés pour toute la vie de ce lecteur — sa clé est `itemId:openId` (voir PlayerHost). Même
  // chose pour `watched`, créé une fois au montage (`useState`) et jamais remplacé (la réserve lit
  // le temps regardé, 28/09/2026). `stutter` et `runner` aussi (§78) : créés une fois au montage.
  // `zoneHandover` et `handZone` (§93) : le premier créé une fois au montage, le second ne dépend que
  // de lui, de `lifecycle` et de `fallToStable` — stables tous trois.
  }, [info, infoError, playbackState, fallToStable, restart, session.resumeAt, rebuildCount, showSubtitleAt, showWarning, showPipelineWarning, chooseSubtitle, chooseSecond, lifecycle, seeks, background, reportAudioSwitch, tally, watched, reopenAfterEnd, itemId, session.bench, stutter, runner, zoneHandover, handZone, enterNetworkLost, clearStall, beginAudioSwitch]);

  useNativeRecovery({
    path,
    restart,
    lifecycle,
    background,
    tally,
    networkLost,
    online,
    setOnline,
    retryAfterNetwork,
    remuxRef,
    positionRef,
    describeFileRef,
  });

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


  const { closeFromScreen } = useNativeSlowLink({
    itemId,
    tracks,
    info,
    currentAudio,
    currentSubtitle,
    generationView,
    externals,
    runner,
    slowLog,
    lifecycle,
    fallToStable,
    slowFields,
    sessionId,
    tally,
    runtimeError,
    networkLost,
    error,
    intendedPosition,
    ready,
    openedAt,
    measureEpoch,
    handleClose,
    setSlowLink,
    setRuntimeError,
    setNetworkLost,
    setSeekSignal,
    setSlowSignal,
    setUnstable,
    setStallUnstable,
    setMeasureEpoch,
    everReadyRef,
    takeoverNowRef,
    wantedAudioRef,
    positionRef,
    describeFileRef,
    pathRef,
    autoLighterRef,
    playbackDecisionRef,
    readyRef,
    videoElRef,
    needBpsRef,
    openingMeterRef,
    pictureAtRef,
    stallAtRef,
    mountedAtRef,
    offerStutterRef,
  });

  // Below the threshold nothing is shown, and a resume that takes a moment reads as instant
  // rather than as a flash of spinner drawing attention to itself.
  //
  // The two waits are answered in different places, and deliberately never both at once: opening
  // has no controls on screen yet, so it gets this component's own overlay, while a resume
  // borrows the spinner the controls already put in place of the button. Driving both from one
  // flag stacked one spinner on top of the other.
  const openingSpinner = openingFor !== null && openingFor >= SPINNER_AFTER_MS && !introCovers;
  // Sous l'ouverture, la roue de l'attente ne se montre pas non plus : l'une tient lieu de l'autre.
  // Et au tout premier départ, sur une image déjà montrée (l'ouverture partie au bout de
  // `COVER_HOLD_MS`, ou une séance sans ouverture), pas avant une vraie attente : la roue revenait par-
  // dessus à 120 ms — le « chargement classique après la première image » signalé par Louis
  // (10/10/2026).
  const openingGrace = introEligible && !introPlaying && startingFor !== null && startingFor < OPENING_SPINNER_GRACE_MS;
  const resumeSpinner = startingFor !== null && startingFor >= SPINNER_AFTER_MS && !introCovers && !openingGrace;
  // Les commandes ont leur propre roue et leur fil, montés sur l'événement `waiting` de l'élément, sans
  // délai : même règle pour eux — rien sous le calque, rien pendant la grâce du premier départ.
  const openingQuiet = introCovers || openingGrace;
  const waitingWord =
    waitingFor === null || waitingFor < WORD_AFTER_MS
      ? null
      : unstable
        ? t("player.slowLink.unstable")
        : slowHintShown || (ready && seekSignal?.hint)
        ? t("player.slowLink.hint")
        : waitingFor >= STILL_WORKING_AFTER_MS
          ? t("player.experimental.stillWorking")
          : openingFor !== null
            ? t("player.experimental.loading")
            : t("player.experimental.preparing");

  // L'attente en pleine lecture (`stallAt`) : seulement « Connexion perdue ou instable… », au même
  // délai que les autres mots (§78) ; une attente ordinaire garde la seule roue des commandes.
  const stallWord =
    waitingFor === null && stallFor !== null && stallFor >= WORD_AFTER_MS && stallUnstable ? t("player.slowLink.unstable") : null;
  const centerWord = resumeSpinner ? waitingWord : stallWord;

  const report: ReportInput = {
    error,
    elapsedMs: openingFor,
    title,
    itemId,
    // Les deux champs du spectateur sont réintégrés ici : ils ont quitté la charge du fichier,
    // mais un rapport qui ne dit plus où l'on en était serait moins utile qu'avant.
    file: info
      ? ({ ...(info as unknown as Record<string, unknown>), ...(playbackState ?? {}) } as Record<string, unknown>)
      : null,
    pathReason,
    diagnostics: {
      ...diagnostics,
      // The spinner's own state. It has told the viewer it was working when it was not, and
      // nothing in the report said which of the three reasons was holding it up.
      Attente: [
        ready ? null : "démarrage",
        startingAt !== null ? "reprise" : null,
      ]
        .filter(Boolean)
        .join(" · ") || "aucune",
    },
    running: ready && !error,
  };

  const style = nativeFrameStyle({ isMini, pos, size, isDragging, resizing, revealed, closing });

  /**
   * Un saut demandé depuis les commandes — ou depuis le banc d'essai, qui passe par ici pour que
   * ce qu'il mesure soit ce que vit le spectateur.
   */
  const noteSeekRequest = (seconds: number) => {
    seeks.request(seconds);
    // Une génération active l'apprend tout de suite (sur l'horloge du fichier) : le serveur traduit
    // d'abord là où le spectateur va, et un saut dans une zone pas encore faite est mesuré.
    generation.noteSeek(seconds - (generationLane() === "second" ? secondOffsetRef.current : subtitleOffsetRef.current) - fileDelayRef.current);
    // Une reconstruction pas encore ouverte rouvre directement là.
    lifecycle.seekDuringRebuild(seconds);
    // Mesuré une fois le chemin natif en marche : c'est le `seeked` de son élément qui ferme la
    // mesure. Avant, rien ne la fermerait, et le saut suivant écrirait celle-ci en ligne fausse —
    // tombée à 0, jamais arrivée (le cas du chemin canevas, chasse aux bugs du 22/09/2026).
    if (pathRef.current !== "remux") {
      seeks.dropMeasure();
      return;
    }
    // Mesuré jusqu'à l'arrivée (`seeked`). Un saut qui en remplace un autre en cours
    // remplace aussi sa mesure : c'est le dernier geste qui compte.
    const element = videoElRef.current;
    // Les plages autour de la cible, pour la ligne du journal — voir `describeBufferedAround`.
    const { buffered, ranges } = describeBufferedAround(element?.buffered ?? null, seconds);
    // Le saut remplacé d'abord, puis la nouvelle mesure : son départ ne compte pas le temps d'écrire
    // la ligne du précédent.
    reportUnarrivedSeek(seeks.takeMeasure(), element?.currentTime ?? positionRef.current, element?.seeking ?? false);
    seeks.startMeasure({ from: positionRef.current, to: seconds, startedAt: Date.now(), hiddenAtStart: tally.hiddenMsSoFar(Date.now()), buffered, ranges });
  };

  /** Un changement de piste audio — les commandes et le banc d'essai, par le même chemin. */
  const changeAudioTrack = (id: number) => {
    // La position part à Jellyfin tout de suite : un changement de piste est un événement de la
    // séance, il n'attend pas le battement de 30 s (13/10/2026, `usePlaybackSession`).
    reportPositionNow();
    // Une piste que ce chemin ne portera jamais n'est pas un échec à signaler : c'est
    // un fichier pour le lecteur qui, lui, sait la porter. La question est posée avant
    // que le menu bouge et avant qu'un seul tampon soit touché — voir `canCarryAudio`.
    // Le spectateur qui demande la VO obtient la VO, au lieu d'un bandeau lui disant
    // que sa langue est indisponible.
    if (path === "remux" && remuxRef.current?.canCarryAudio(id) === false) {
      const wanted = tracks.audio.find((track) => track.number === id);
      fallToStable(`la piste ${wanted?.codecId ?? "demandée"} ne peut pas être portée ici`, {
        ...takeoverNow(),
        // La piste *demandée*, et non celle qui joue : c'est elle qu'on va chercher.
        audioStreamIndex: jellyfinAudioIndex(tracks.audio, info?.audio, id),
      });
      return;
    }
    if (path === "remux") {
      const playback = remuxRef.current;
      if (!playback) {
        // Entre deux pipelines (une reconstruction en cours) : retenue, et celui qui
        // s'ouvre la rejoint dès qu'il est prêt — voir `startRemux`.
        wantedAudioRef.current = id;
        setCurrentAudio(id);
        return;
      }
      // Tout changement de piste reconstruit le lecteur à la même position, directement
      // sur la nouvelle piste — le mécanisme qui le relève déjà d'une coupure. Voir
      // `requestAudioTrack` pour pourquoi il n'y a plus d'autre façon de changer.
      const request = playback.requestAudioTrack(id);
      if (request === "refused") {
        // Fichier sans index, en cours de film : l'avertissement est déjà affiché, la
        // piste d'avant continue et le menu reste sur elle.
        reportAudioSwitch(playback.currentAudioTrack, playback.diagnostics["Audio"] ?? "", id, Date.now(), playback, "refus");
        return;
      }
      if (request !== "rebuild") return;
      beginAudioSwitch(playback, id);
      setCurrentAudio(id);
      // Un film à l'arrêt reste à l'arrêt : le spectateur a changé de langue, pas lancé
      // la lecture. Là où le spectateur a demandé d'être, pas seulement là où il en était.
      rebuildHereForViewer(`piste ${id} — reconstruction sur elle`);
      return;
    }
    // Avant que le chemin natif ne soit en marche : retenue, et le pipeline qui s'ouvre la prend.
    setCurrentAudio(id);
    wantedAudioRef.current = id;
    };

  /**
   * Le banc d'essai — voir `playerBench/bridge.ts`. Ce qu'il lit est recopié ici à chaque rendu,
   * par un effet et non pendant le rendu ; le pont lui-même n'est posé qu'une fois par séance.
   */
  useNativeBenchBridge({
    bench: session.bench,
    itemId,
    videoElRef,
    remuxRef,
    lastVideoElRef,
    live: () => ({
      seek: noteSeekRequest,
      changeAudio: changeAudioTrack,
      changeSubtitle: (id) => chooseSubtitle(id, externals),
      ready,
      path,
      error: runtimeError ?? (networkLost ? "connexion perdue" : null),
      audio: tracks.audio.map((track) => ({ id: track.number, label: audioLabels.get(track.number) ?? String(track.number) })),
      subtitles: subtitleChoices.map((track) => ({ id: track.number, label: subtitleLabels.get(track.number) ?? String(track.number) })),
      currentAudio,
      currentSubtitle,
      subtitle,
      fps: info?.video?.frameRate ?? null,
    }),
  });

  // Les bandes noires incrustées dans le fichier : l'image est agrandie jusqu'au bord le plus
  // proche, sans rien couper — voir `frameFit`. Pas dans le mini-lecteur, qui remplit déjà sa
  // fenêtre (`object-cover`).
  const frameFitState = useFrameFit(itemId, !isMini, containerRef, videoElRef);

  // Après tous les hooks : le banc d'essai en a ajouté trois au-dessus, et un retour anticipé
  // avant eux en changeait le nombre d'un rendu à l'autre.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      // Rien à sélectionner dans le lecteur, vidéo et sous-titres compris (globals.css).
      data-player-frame
      ref={containerRef}
      style={style}
      className={isMini ? "animate-fade-in-scale" : "app-viewport"}
      {...(isMini ? handlers : {})}
    >
      {/* The element is mounted from the start: the remux path needs a <video> to attach to before
          it can begin. It stays hidden until the file has been examined and the path is running. */}
      {/* Fondu depuis le noir sur la première image. La toute première frame d'une MediaSource
          arrive rarement seule et proprement — il y a un battement entre l'élément qui se
          déclare prêt et l'image qui s'installe. Trois cents millisecondes de fondu couvrent
          ce battement et, surtout, donnent une intention à ce qui ressemblait à un à-coup. */}
      {/* Deux cadres autour des surfaces : l'extérieur coupe ce qui déborde, l'intérieur porte
          l'agrandissement (`frameFitState`). Posé sur un cadre plutôt que sur chaque surface, il ne
          touche pas à leurs propres transitions d'opacité. */}
      <div className="relative h-full w-full overflow-hidden">
        <div className="relative h-full w-full" style={frameFitState.style}>
          <video
            ref={videoElRef}
            playsInline
            hidden={!onElement}
            // Sous une image figée, l'élément reste pleinement visible : s'il s'éteignait pendant que
            // l'image figée s'efface, les deux passaient ensemble par la demi-transparence et le noir
            // se voyait au travers — un creux sombre au lieu d'un fondu.
            className={`${isMini ? "h-full w-full object-cover" : "h-full w-full object-contain"} transition-opacity duration-300 ease-out ${
              ready || frozen ? "opacity-100" : "opacity-0"
            }`}
          />
          {/* L'image d'avant, le temps d'une reconstruction pour changement de piste : posée par-dessus,
              elle s'efface en fondu pendant que la nouvelle apparaît dessous. Voir `freezeFrame`. */}
          <canvas
            ref={freezeRef}
            aria-hidden
            // Là d'un coup, partie en fondu : apparue en fondu, elle laissait voir le noir de l'élément
            // qu'on démonte pendant ses premières centaines de millisecondes.
            className={`pointer-events-none absolute inset-0 ${isMini ? "h-full w-full object-cover" : "h-full w-full object-contain"} transition-opacity ease-out ${
              frozen ? "opacity-100 duration-0" : "opacity-0 duration-200"
            }`}
          />
        </div>
      </div>

      {introPhase !== "gone" && (
        <PlaybackIntro
          phase={introPhase}
          startedAt={introStartedAt}
          clockKey={thisIntro}
          art={session.introArt ?? null}
          imageShown={announced}
          onCoverChange={setIntroCovering}
          fallbackName={openedAs}
          caption={introCaption(
            { ...session.introArt, resumeSeconds: session.resumeAt ?? playbackState?.resumeSeconds ?? null },
            t
          )}
          // Un mot seulement quand l'attente devient vraiment longue : l'ouverture se suffit, et
          // « Analyse du fichier… » à trois secondes y serait du bruit.
          // « Connexion perdue ou instable… » d'abord (une coupure), puis l'indice d'une connexion lente
          // (§78) : ils disent pourquoi, dès qu'on le sait.
          note={
            unstableShown
              ? t("player.slowLink.unstable")
              : slowHintShown
                ? t("player.slowLink.hint")
                : openingFor !== null && openingFor >= STILL_WORKING_AFTER_MS
                  ? t("player.experimental.stillWorking")
                  : null
          }
          onClose={handleClose}
          closeLabel={t("common.close")}
          className="absolute inset-0 z-[15]"
        />
      )}

      {/* Les lignes sous l'image — le principal, et le second au-dessus en mode « deux sous-titres »
          (§87). Un seul : le calque d'avant à l'identique (`SubtitleLayer`). */}
      {!isMini && (
        <SubtitleLayer
          primary={subtitle}
          primaryNotice={subtitleIsNotice}
          second={secondText}
          secondNotice={secondIsNotice}
          dual={secondSubtitle !== null}
          style={subtitleStyle}
          chromeEdges={chromeEdges}
        />
      )}

      {/* A network cut is not a fault to report, it is a wait to sit through — so it gets its own
          screen rather than the error one. The film is not lost: the position, the language and
          the subtitles are all still here, and pressing the button gives them back. */}
      {networkLost && !isMini && (
        <NetworkLostScreen
          t={t}
          online={online}
          networkLost={networkLost}
          audioTracks={tracks.audio}
          retryAfterNetwork={retryAfterNetwork}
          onClose={handleClose}
        />
      )}

      {/* La fin d'un film, ou d'un épisode retenu par la minuterie de veille — voir `endScreen`. */}
      {endScreen && (
        <PlayerEndScreen
          itemId={itemId}
          title={info?.title ?? openedAs}
          onReplay={() => {
            const media = videoElRef.current;
            if (media) {
              media.currentTime = 0;
              void media.play().catch(() => {});
            }
            // La séance a été close à la fin du film : la seconde vision la rouvre.
            resumePlaybackSession();
            setEnded(false);
          }}
          onClose={handleClose}
          onOpenTitle={(movie) => {
            handleClose();
            openLibraryTitle("movie", movie.radarrId);
          }}
          // « La suite » de la saga : ce film-ci se ferme comme à la croix (arrêt, relecture des
          // vues), et le suivant s'ouvre à la position que l'écran de fin a lue chez Jellyfin —
          // un nombre, zéro pour un film jamais commencé (DECISIONS.md §1).
          onPlayNext={(movie, resumeAt) => {
            handleClose();
            playback.play({ itemId: movie.jellyfinItemId, title: movie.title, resumeAt });
          }}
        />
      )}

      {/* « Lecture impossible : la connexion est trop lente. » (§78) — le lien ne porte pas le film. Pas
          de chiffres (ils sont au journal et au panneau technique). Version allégée si le lecteur
          serveur n'est pas en jeu ici : cet écran n'existe qu'en « Originale » ou sans version allégée
          permise. Réessayer rouvre au même endroit ; Fermer ferme le lecteur. */}
      {slowShown && slowLink && !networkLost && !isMini && (
        <SlowLinkScreen
          t={t}
          onRetry={() => {
            slowLog.choose("réessayer", Date.now() - openedAt);
            setSlowLink(null);
            retryAfterNetwork(positionRef.current, "réessai demandé après une connexion trop lente", true);
          }}
          onClose={closeFromScreen}
        />
      )}

      {error && !slowShown && !networkLost && !isMini && (
        <NativeErrorScreen
          t={t}
          error={error}
          serverFallback={serverFallback}
          report={report}
          onSwitchToStable={() => fallToStable(error ?? "demandé par le spectateur")}
          onClose={handleClose}
        />
      )}

      {warning && !error && !isMini && <NativeWarning text={warning.text} />}

      {/* The technical panel is this player's own: the stable one's reads Jellyfin's transcode
          session, and there is no transcode session here — everything below is what the browser
          is actually doing. */}
      {/* Le même panneau que le lecteur stable, nourri par ce que ce chemin-ci sait dire. */}
      <PlaybackInfoPanel
        open={showInfo && !isMini}
        onClose={() => setShowInfo(false)}
        data={{
          ...describeRemuxPlayback(
            {
              path,
              pathReason,
              container: info?.container ?? null,
              video: info?.video
                ? {
                    codec: info.video.codec ?? null,
                    width: info.video.width ?? null,
                    height: info.video.height ?? null,
                    bitDepth: info.video.bitDepth ?? null,
                    rangeType: info.video.rangeType ?? null,
                  }
                : null,
              audioTrackCount: tracks.audio.length,
              subtitleTrackCount: tracks.subtitles.length,
              currentAudioCodec:
                currentAudio !== null
                  ? tracks.audio.find((a) => a.number === currentAudio)?.codecId.replace("A_", "") ?? "?"
                  : null,
              diagnostics,
              // Figé au moment d'une connexion trop lente : ce sont ces chiffres-là qui ont décidé.
              link: slowShown && slowLink ? frozenReading(slowLink) : linkLive,
            },
            t
          ),
          report,
        }}
      />

      {isMini ? (
        <MiniPlayerChrome
          title={title}
          playing={playing}
          onTogglePlay={() => {
            const element = videoElRef.current;
            if (!onElement || !element) return;
            if (element.paused) void element.play();
            else element.pause();
          }}
          onClose={handleClose}
        />
      ) : (
        // Gardées pendant une reconstruction pour changement de piste (`frozen`), le temps de
        // s'estomper puis de revenir : elles disparaissaient d'un coup et réapparaissaient d'un
        // coup, ce qui ajoutait à l'effet « sec » du changement (22/09/2026).
        (ready || frozen) &&
        onElement &&
        !error && (
          <div
            // Effacées aussi sous l'écran de fin (07/10/2026) : la croix, AirPlay, le volume et les sauts
            // de dix secondes transparaissaient sous ses boutons et sa question, et s'y mêlaient.
            className={`absolute inset-0 z-10 transition-opacity duration-200 ease-out ${
              ready && !endScreen ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
            // Hors d'atteinte tant qu'elles s'effacent : ni toucher, ni focus.
            inert={!ready || endScreen}
          >
          <PlayerControls
            lab={!!session.labSample}
            // A real media element: seeking, volume and rate are the browser's own.
            videoRef={videoElRef}
            onSeekRequest={noteSeekRequest}
            positionNow={intendedPosition}
            containerRef={containerRef}
            itemId={itemId}
            title={title}
            // Le logo du titre, à la place du titre écrit — voir `PlayerTitle` (09/10/2026).
            logoUrl={info?.logoUrl ?? null}
            onChromeEdges={setChromeEdges}
            onClose={handleClose}
            onMinimize={() => playback.minimize()}
            // Straight from the container the player is reading, not from Jellyfin's view of the
            // file: those are the tracks it can actually switch between.
            audioTracks={tracks.audio.map((track) => ({ id: track.number, label: audioLabels.get(track.number) ?? String(track.number) }))}
            /* Diffuser depuis ce lecteur est impossible : il alimente son élément vidéo par
               MediaSource, et ni AirPlay ni Remote Playback ne diffusent autre chose qu'une
               adresse que le récepteur ira chercher. On cède donc la place au lecteur serveur, qui
               en joue une — et `cast: true` dit que ce n'est pas un échec, donc qu'on pourra
               revenir quand la diffusion s'arrêtera. */
            onCastRequest={
              // Seulement s'il y a quelqu'un à qui confier le film. Sans lecteur serveur,
              // `fallToStable` affiche la raison comme une erreur de lecture — « diffusion
              // demandée » présenté comme une panne. Le bouton retombe alors sur le sélecteur,
              // c'est-à-dire exactement ce qu'il faisait avant cette fonctionnalité.
              //
              // `undefined` compte comme « il y en a un », comme `fallToStable` le fait déjà pour
              // lui-même : se tromper dans ce sens donne une bascule, jamais une fausse erreur.
              serverFallback === false
                ? undefined
                : () => fallToStable("diffusion demandée", { ...takeoverNow(), cast: true })
            }
            chromecast={chromecastAllowed && chromecastState.devices ? { active: chromecastState.connected, onRequest: requestChromecast } : undefined}
            currentAudioId={currentAudio}
            onChangeAudio={changeAudioTrack}
            subtitleTracks={subtitleChoices.map((track) => ({
              id: track.number,
              label: subtitleLabels.get(track.number) ?? String(track.number),
              detail: subtitleDetails.get(track.number),
            }))}
            currentSubtitleId={currentSubtitle}
            onChangeSubtitle={(id) => {
              // Comme la piste audio : à l'instant, pas au battement suivant.
              reportPositionNow();
              const wasDual = secondWantedRef.current !== null;
              chooseSubtitle(id, externals);
              // En mode deux sous-titres, le principal fait partie du choix retenu (§87).
              if (wasDual) rememberDual(trackOfSubtitle(wantedSubtitleRef.current), trackOfSubtitle(secondWantedRef.current));
            }}
            secondSubtitle={
              path === "remux"
                ? ({
                    currentId: secondSubtitle,
                    onChange: (id) => {
                      chooseSecond(id, externals);
                      rememberDual(trackOfSubtitle(wantedSubtitleRef.current), trackOfSubtitle(secondWantedRef.current));
                    },
                    // Une seule génération dessinée à la fois : le principal en affiche une, le second
                    // ne peut ni en prendre une autre, ni en lancer une.
                    ...(isGeneratingTrack(currentSubtitle)
                      ? {
                          tracks: subtitleChoices
                            .filter((track) => !isGeneratingTrack(track.number))
                            .map((track) => ({ id: track.number, label: subtitleLabels.get(track.number) ?? String(track.number) })),
                        }
                      : session.bench || generationView.targets.length === 0
                        ? {}
                        : {
                            generation: {
                              targets: generationView.targets,
                              busy: generationState.requesting !== null,
                              onGenerate: requestSecondGeneration,
                            },
                          }),
                    offset: {
                      seconds: secondOffset,
                      onShift: (delta) => {
                        const next = Math.round((secondOffsetRef.current + delta) * 10) / 10;
                        secondOffsetRef.current = next;
                        setSecondOffset(next);
                      },
                    },
                  } satisfies SecondSubtitleMenu)
                : undefined
            }
            // « Générer des sous-titres » (DECISIONS.md §70) : lecteur natif seulement, et seulement
            // s'il reste une langue à demander ou une génération à reprendre.
            subtitleGeneration={
              path === "remux" && (generationView.targets.length > 0 || generationView.resumable.length > 0)
                ? ({
                    targets: generationView.targets,
                    busy: generationState.requesting !== null,
                    onGenerate: requestGeneration,
                    resumable: generationView.resumable,
                    onResume: (code) => void generation.resume(code),
                  } satisfies SubtitleGenerationMenu)
                : undefined
            }
            subtitleOffset={{
              seconds: subtitleOffset,
              onShift: (delta) => {
                const next = Math.round((subtitleOffsetRef.current + delta) * 10) / 10;
                subtitleOffsetRef.current = next;
                setSubtitleOffset(next);
              },
            }}
            onTogglePlaybackInfo={() => setShowInfo((open) => !open)}
            hidden={false}
            // L'ouverture seule est un chargement. Une reprise après une pause n'en est plus un
            // (04/10/2026) : les commandes restent, lecture/pause passe aussitôt sur pause et reste
            // touchable, et la reprise se dit par un anneau autour du bouton et le fil du haut —
            // voir `resuming` dans PlayerControls.
            loading={!ready}
            resuming={ready && startingAt !== null}
            openingQuiet={openingQuiet}
            // Jellyfin's own analysis of the episode, fetched alongside the file's description.
            // Playback speed needs nothing here: on the native path these controls hold a real
            // media element, so it is the browser's own.
            introSkip={info?.introSkip ?? null}
            recapSkip={info?.recapSkip ?? null}
            creditsStart={info?.creditsStart ?? null}
            nextEpisode={nextEpisode}
            onPlayEpisode={scene.active || session.bench ? undefined : handlePlayEpisode}
            onAdvance={handleAdvance}
            // Et pas de clavier non plus : l'écouteur est posé sur la fenêtre, `inert` ne l'arrête pas.
            // Ni sous l'écran de fin : la barre d'espace y relançait le film par-dessous, sans
            // rouvrir la séance que la fin avait close — « Revoir » le fait, pas le clavier.
            // Sous l'écran « connexion perdue » aussi : une flèche y déplaçait la reprise annoncée,
            // et la barre d'espace jouait un élément mort (relu le 24/09/2026).
            suspended={!ready || networkLost !== null || endScreen}
            // L'interrupteur n'apparaît que s'il y a un agrandissement à défaire — voir `useFrameFit`.
            frameFit={frameFitState.available ? { on: frameFitState.on, onChange: frameFitState.setOn } : undefined}
            dialogue={
              path === "remux"
                ? {
                    mode: dialogueMode,
                    // Sans effet sur la piste qui joue (un AAC 5.1, un MP3…) : dit dans le menu, pour
                    // qu'un réglage inaudible ne passe pas pour un réglage cassé.
                    applies: currentAudio === null || dialogueShapeable.has(currentAudio),
                    onChange: (mode) => {
                      writeDialogueMode(mode);
                      setDialogueMode(mode);
                      dialogueFellBackRef.current = false;
                      dialogueOpenRef.current = mode;
                      if (!remuxRef.current) return; // entre deux pipelines : le suivant le lira
                      // Le traitement est dans la chaîne audio : il faut la reconstruire, à la même
                      // position, comme pour un changement de piste — pause et image figée comprises.
                      rebuildHereForViewer(`dialogues améliorés : ${mode}`);
                    },
                  }
                : undefined
            }
            hdrCap={
              path === "remux" && hdrCapContext.relevant && info?.video?.rangeType && info.video.rangeType !== "SDR"
                ? {
                    current: hdrCapChoice,
                    autoNits: hdrCapContext.autoNits,
                    onPick: (choice) => {
                      writeHdrCapChoice(choice);
                      setHdrCapChoice(choice);
                      // Le plafond est écrit dans l'en-tête du flux : il faut le reconstruire,
                      // à la même position, comme pour un changement de piste — pause et image
                      // figée comprises : sans elles, un film à l'arrêt repartait sur un écran noir.
                      rebuildHereForViewer(`plafond HDR ${choice}`);
                    },
                  }
                : undefined
            }
          />
          </div>
        )
      )}

      {/* Rien sous l'écran de coupure : « Analyse du fichier… » et son cercle transparaissaient à
          travers son voile, deux messages contraires à la fois (vu sur iPhone le 21/09/2026). */}
      {openingSpinner && !error && !networkLost && !isMini && <OpeningSpinner waitingWord={waitingWord} />}

      {/* The wait has gone past explaining itself. The report is pointer-enabled where the
          spinner above is not: it exists to be selected and copied. */}
      {/* Pas sous l'écran de coupure non plus, comme la roue au-dessus : l'horloge de l'ouverture
          court pendant une coupure, et passé vingt secondes « le chargement n'aboutit pas » montait
          par-dessus « Connexion perdue » et ses boutons (chasse aux défauts du 13/10/2026). */}
      {stuck && !error && !networkLost && !isMini && <StuckReport report={report} />}

      {/* A resume long enough to deserve a word gets the word only: the controls are already
          showing the spinner, and a second one beside it is what this looked like at first. */}
      {/* Et une attente en pleine lecture, quand le réseau est en cause : le mot seul, sous la roue
          ou le fil des commandes — voir `stallWord`. */}
      {!openingSpinner && centerWord && !error && !networkLost && !isMini && <CenterWord word={centerWord} />}
    </div>,
    document.body
  );
}
