"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { AlertTriangle, RotateCw, WifiOff, X } from "lucide-react";
import { fetcher, playerBootstrapOptions, refreshAfterPlayback } from "@/lib/swr";
import { directInfoKey, fetchPlaybackState, takePrefetchedPlaybackState } from "@/lib/playbackPrefetch";
import { errorMessage, isUpstreamUnreachable } from "@/lib/upstreamError";
import { usePlayback } from "@/components/PlaybackProvider";
import { PlayerControls } from "@/components/PlayerControls";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { isPlayerWarning } from "@/lib/webcodecs/playerWarning";
import { subtitlePlacement } from "@/lib/webcodecs/subtitleMarkup";
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
import { PLAYBACK_CLIENTS } from "@/lib/playbackClients";
import { useViewportResizing } from "@/lib/useViewportResizing";
import { useT, useLocale } from "@/components/TranslationProvider";
import { probePlaybackPath, type RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";
import { NATIVE_PATH } from "@/lib/webcodecs/pathSelector";
import { trace, traceKeepAcrossReset, traceRecent } from "@/lib/webcodecs/trace";
import { isNetworkFailure } from "@/lib/webcodecs/byteSource";
import { reportPlayback } from "@/lib/reportPlayback";
import { usePlayerServerFallback } from "@/lib/usePlayerEnabled";
import type { StableTakeover } from "@/lib/useStableFallback";
import { ExperimentalPlayerReport, type ReportInput } from "@/components/ExperimentalPlayerReport";
import { PlaybackInfoPanel } from "@/components/PlaybackInfoPanel";
import { PlayerEndScreen } from "@/components/player/PlayerEndScreen";
import { openLibraryTitle } from "@/lib/cinemaRoute";
import { subtitleStyleStore, overlayCss } from "@/lib/subtitleStyle";
import { useFrameFit } from "@/lib/frameFit";
import { awayFrom, noteWatching, rewound, AWAY_MS } from "@/lib/resumeRewind";
import { warmNextEpisode } from "@/lib/nextEpisodeWarmup";
import { prefetchPlaybackState } from "@/lib/playbackPrefetch";

/** À combien de la fin l'épisode suivant est préparé : de quoi finir bien avant le décompte. */
const NEXT_EPISODE_WARMUP_SECONDS = 60;

/**
 * L'épisode suivant, préparé une fois qu'on approche de la fin — voir `nextEpisodeWarmup.ts`.
 *
 * « La fin », c'est le générique quand on le connaît : c'est lui qui déclenche l'enchaînement, dix
 * secondes après. Comptée depuis la fin du fichier, la préparation arrivait après le passage pour
 * un générique de plus de 70 s. Et l'état du spectateur est redemandé tant qu'on attend (la
 * demande se limite elle-même à une toutes les 30 s) : préparé une minute avant, il était jugé
 * périmé au moment d'ouvrir, et redemandé (relu le 24/09/2026).
 */
function warmNextNear(nextId: string | null, position: number, duration: number, creditsStart: number | null): void {
  if (!nextId || !(duration > 0)) return;
  const endsAt = creditsStart !== null && creditsStart > 0 && creditsStart < duration ? creditsStart : duration;
  if (endsAt - position > NEXT_EPISODE_WARMUP_SECONDS) return;
  void warmNextEpisode(nextId);
  prefetchPlaybackState(nextId);
}
import { describeRemuxPlayback } from "@/lib/playbackPanel";
import type { PlayerTrack } from "@/lib/webcodecs/playerTrack";
import type { RecoveryFacts } from "@/lib/webcodecs/mseSource";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import type { PlaybackState } from "@/app/api/jellyfin/playback-state/[itemId]/route";
import {
  ExternalSubtitleTrack,
  isExternalTrack,
  toPlayerTrack as externalToPlayerTrack,
  type ExternalSubtitleSource,
} from "@/lib/webcodecs/externalSubtitles";
import { chooseAudioTrack, chooseSubtitleTrack, trackLanguage } from "@/lib/trackPreferences";
import { labelAudioTracks, labelSubtitleTracks } from "@/lib/trackLabel";
import { useWakeLock } from "@/lib/useWakeLock";
import { registerBenchBridge } from "@/lib/playerBench/bridge";
import { seekArrived } from "@/lib/webcodecs/seekArrival";
import { SessionTally, newPlayerSessionId } from "@/lib/playerSessionTally";
import { saveUnsentStop, clearUnsentStop } from "@/lib/unsentStop";

/** Which of the pipeline's own readings belong under the sound rather than under the stream. */

/** How long a threshold has to be crossed before anything is shown at all. */
const SPINNER_AFTER_MS = 120;

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
 * And how long a run of them counts as one run.
 *
 * A budget that never decays is a budget a long film exhausts by accident: three hiccups an hour
 * apart are not the fault that limit exists to stop.
 */
const REBUILD_WINDOW_MS = 180_000;

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

/** "1 h 12" — where the film will pick up, said the way a viewer thinks of it. */
/**
 * Ce qu'on sait, en fin de séance, de l'accord entre le son et l'image.
 *
 * Un spectateur sur Chrome Android voyait le son se décaler peu à peu, et un saut le recaler
 * (22/09/2026) — sans que rien, nulle part, n'en garde la trace. Deux faits pour trancher : les
 * horloges du son ré-encodé (`audioSync`, voir `AudioTimingStats` ; absent quand le son est copié),
 * et les images que le navigateur a sautées (`frames`) — un appareil qui n'arrive plus à suivre
 * décale aussi l'image du son. Mesuré sans rien montrer, et sans jamais faire échouer la ligne
 * qui le porte.
 */
function syncFacts(
  remux: {
    audioTiming(): { sourceMs: number; encoderMs: number } | null;
    recoveryFacts?(): RecoveryFacts | null;
  } | null,
  element: HTMLVideoElement | null
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  try {
    const timing = remux?.audioTiming();
    if (timing) facts.audioSync = timing;
  } catch {
    // Un pipeline déjà détruit : rien à dire.
  }
  try {
    // Combien de fois la source a dû se reprendre sur la séance. Une séance à douze reprises et
    // une séance à zéro se lisaient pareil ; les barreaux gravis ne sont écrits que s'il y en a eu.
    const recovery = remux?.recoveryFacts?.();
    if (recovery) {
      facts.recoveries = recovery.recoveries;
      facts.frozenNudges = recovery.frozenNudges;
      if (recovery.escalations > 0) facts.escalations = recovery.escalations;
      // Ce que Safari a retiré de lui-même (24/09/2026) : écrit seulement s'il y en a eu, comme
      // les barreaux.
      if (recovery.evictions > 0) {
        facts.evictions = recovery.evictions;
        facts.evictionsAhead = recovery.evictionsAhead;
      }
    }
  } catch {
    // Idem.
  }
  try {
    const quality = element?.getVideoPlaybackQuality?.();
    if (quality && quality.totalVideoFrames > 0) {
      facts.frames = { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
    }
  } catch {
    // Non pris en charge ici.
  }
  return facts;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min ${String(sec).padStart(2, "0")}`;
}

/** "Français — VFF", falling back to whatever the file actually gives us. */
/**
 * Jellyfin's stream index for one of the file's audio tracks, or undefined if it cannot be
 * named with confidence.
 *
 * The two lists describe the same file from two sides: the player reads Matroska track *numbers*
 * out of the container, Jellyfin reports ffmpeg stream *indices*. Neither converts into the
 * other — Matroska only requires a track number to be unique and positive, so the tempting
 * `index = number - 1` holds for files mkvmerge wrote and is arithmetic elsewhere. What is
 * reliable is the order: both lists enumerate the file's audio streams in the order the file
 * stores them, so the nth audio track here is the nth audio stream there.
 *
 * Returns undefined rather than a guess when the two disagree on how many audio streams exist.
 * The stable player then picks its own default — a film that opens in the wrong language is a
 * better failure than one that opens on a track chosen by a rule that did not hold.
 */
function jellyfinAudioIndex(
  fileTracks: PlayerTrack[],
  jellyfinTracks: DirectPlayInfo["audio"] | undefined,
  trackNumber: number
): number | undefined {
  if (!jellyfinTracks || jellyfinTracks.length !== fileTracks.length) return undefined;
  const ordinal = fileTracks.findIndex((t) => t.number === trackNumber);
  if (ordinal < 0) return undefined;
  return jellyfinTracks[ordinal]?.index;
}

/**
 * Les étiquettes des sous-titres — langue et type, dans la même forme que l'audio.
 *
 * Les pistes externes portent un identifiant négatif (voir `ExternalSubtitle`), ce qui suffit à
 * les reconnaître sans leur ajouter un champ.
 */
function useSubtitleLabels(tracks: PlayerTrack[]) {
  const t = useT();
  const { locale } = useLocale();
  return useMemo(() => {
    const etiquettes = labelSubtitleTracks(
      tracks.map((track) => ({ ...track, isExternal: track.number < 0 })),
      {
        locale,
        forces: t("player.trackLabel.forced"),
        complets: t("player.trackLabel.full"),
        malentendants: t("player.trackLabel.sdh"),
        externe: t("player.trackLabel.external"),
        piste: (n) => t("player.trackLabel.track", { n }),
      }
    );
    return new Map(etiquettes.map((e) => [e.number, e.label]));
  }, [tracks, locale, t]);
}

/**
 * Les étiquettes des pistes audio, dans la forme partagée par toute l'application.
 *
 * Le fichier et Jellyfin décrivent les mêmes pistes, chacun avec ce que l'autre n'a pas : le
 * premier porte la langue et le nom bruts, le second le profil — Atmos, DTS-HD MA — et un nombre
 * de canaux déjà résolu. On les apparie dans l'ordre, comme `jellyfinAudioIndex` le fait déjà, et
 * on étiquette avec les deux. Sans Jellyfin, l'étiquette est simplement moins précise.
 */
function useAudioLabels(fileTracks: PlayerTrack[], jellyfin: DirectPlayInfo["audio"] | undefined, originalLanguage: string | null) {
  const t = useT();
  const { locale } = useLocale();
  return useMemo(() => {
    const apparie = jellyfin && jellyfin.length === fileTracks.length ? jellyfin : null;
    const faits = fileTracks.map((track, i) => ({
      ...track,
      codecId: track.codecId || apparie?.[i]?.codec || null,
      channels: track.channels ?? apparie?.[i]?.channels ?? null,
      profile: apparie?.[i]?.profile ?? null,
      name: track.name ?? apparie?.[i]?.displayTitle ?? null,
    }));
    const etiquettes = labelAudioTracks(faits, {
      locale,
      originalLanguage,
      canaux: (n) => t("player.trackLabel.channels", { n }),
      piste: (n) => t("player.trackLabel.track", { n }),
    });
    return new Map(etiquettes.map((e) => [e.number, e.label]));
  }, [fileTracks, jellyfin, originalLanguage, locale, t]);
}

const TRANSITION =
  "top 300ms cubic-bezier(0.4,0,0.2,1), left 300ms cubic-bezier(0.4,0,0.2,1), width 300ms cubic-bezier(0.4,0,0.2,1), height 300ms cubic-bezier(0.4,0,0.2,1), border-radius 300ms cubic-bezier(0.4,0,0.2,1)";

/**
 * The native player: the same chrome as the stable one, over a <video> element fed by the remuxer
 * (MediaSource) instead of an HLS stream transcoded by the server.
 *
 * A file it cannot carry, or a failure it cannot recover from, is handed to the server player
 * (`fallToStable`), with the reason written to the record — never repaired silently, so the record
 * always says which files this path cannot handle. The controls are the stable player's,
 * unmodified: here they drive a real media element.
 */
/** Le plus longtemps qu'une image figée reste à l'écran, quoi qu'il arrive. */
const FREEZE_MAX_MS = 4000;

/**
 * La durée d'un saut, sans le temps passé en arrière-plan pendant qu'il attendait. Un saut lancé
 * juste avant de quitter l'application et arrivé au retour comptait l'absence entière : 286 s pour
 * un Mac mis en veille (24/09/2026), ce qui faussait tout bilan des attentes.
 */
function seekElapsed(tally: SessionTally, timing: { startedAt: number; hiddenAtStart: number }): number {
  const now = Date.now();
  return Math.max(0, now - timing.startedAt - (tally.hiddenMsSoFar(now) - timing.hiddenAtStart));
}

export function ExperimentalPlayerHost({
  session,
  mode,
  onFallback,
}: {
  session: NonNullable<ReturnType<typeof usePlayback>["session"]>;
  mode: "full" | "mini";
  onFallback: (reason: string, takeover?: StableTakeover) => void;
}) {
  const t = useT();
  // Pour les phrases écrites depuis le pipeline : ses gestionnaires sont construits par un effet
  // qu'il ne faut pas reconstruire au changement de langue — ils lisent la traduction par ici.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const playback = usePlayback();
  const { itemId, title: openedAs } = session;

  const videoElRef = useRef<HTMLVideoElement>(null);
  const remuxRef = useRef<RemuxPlayback | null>(null);
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
  /** `takeoverNow`, pour `fallToStable` qui est déclaré avant lui et doit rester stable. */
  const takeoverNowRef = useRef<() => StableTakeover | undefined>(() => undefined);

  const [ready, setReady] = useState(false);
  /**
   * Prêt au moins une fois : la séance Jellyfin commence là, et ne finit qu'avec le lecteur.
   *
   * Elle suivait `ready`, que chaque reconstruction rabaisse — et une reconstruction est devenue
   * un geste ordinaire : changer pour une piste d'un autre format, revenir d'un iPhone verrouillé,
   * se remettre d'une coupure. Chacune envoyait à Jellyfin un arrêt puis une nouvelle lecture :
   * des séances fantômes dans son activité, et « en cours » qui clignotait (relu le 22/09/2026).
   */
  const [announced, setAnnounced] = useState(false);
  /** Relances automatiques après une coupure depuis la dernière image — voir leur espacement. */
  const networkRetriesRef = useRef(0);
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
   * Cette séance, de l'ouverture au démontage, reconstructions comprises : son identifiant, porté
   * par chacune de ses lignes, et le décompte qui fait son bilan — voir `SessionTally`.
   */
  const [sessionId] = useState(newPlayerSessionId);
  const [tally] = useState(() => new SessionTally());
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
  const fallToStable = useCallback((reason: string, takeover?: StableTakeover) => {
    if (steppedAside.current) return;
    steppedAside.current = true;
    // La ligne `fallback` dit comment la séance a fini ici : pas de bilan « perdu » en plus.
    clearUnsentStop(sessionId);
    const file = describeFileRef.current();
    const path = pathRef.current ?? "non décidé";
    if (serverFallbackRef.current === false) {
      trace(`abandon : aucun lecteur serveur sur cette installation — ${reason}`);
      reportPlayback("error", { ...file, reason, path });
      setRuntimeError(reason);
      return;
    }
    // Un renoncement en cours de film emporte où en est le film. Seuls deux appelants passaient
    // un relais — la diffusion et la piste impossible — et tous les autres renoncements en cours
    // de route (moteur à bout de reconstructions, source perdue, 35 s sans image après une
    // reconstruction, bouton de l'écran d'erreur) rouvraient le lecteur stable à la position
    // d'ouverture, sur la piste par défaut : une heure de film rembobinée, dans une autre langue
    // (relu le 22/09/2026). Avant la première image, rien : la séance dit déjà tout — voir
    // `StableTakeover`.
    const handover = takeover ?? (everReadyRef.current ? takeoverNowRef.current() : undefined);
    trace(`repli : passage au lecteur stable — ${reason}`);
    // `cast` à plat : une diffusion demandée n'est pas un échec, et le journal doit pouvoir le dire
    // sans comparer des phrases (voir `seances.ts`).
    reportPlayback("fallback", { ...file, reason, path, ...(handover ? { takeover: handover } : {}), ...(handover?.cast ? { cast: true } : {}) });
    onFallbackRef.current(reason, handover);
  }, [sessionId]);
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
  // Why this file is being played the way it is. Kept for the panel on *both* paths: a fallback
  // whose reason is only visible on the path that was not taken explains nothing at all.
  const [pathReason, setPathReason] = useState<string | null>(null);
  // The picture is on the element once the native path is running.
  const onElement = path === "remux";
  /**
   * Le chemin retenu, noté au moment où il est choisi.
   *
   * Ce ref ne servait qu'au rapport d'échec, et il était recopié depuis l'état — donc un rendu
   * après la décision. Un échec survenant dans cet intervalle se rapportait « non décidé », et
   * neuf replis du journal disent exactement ça : le seul champ qui aurait dit ce que le lecteur
   * tentait est vide sur les seules lectures qui ont échoué. `choosePath` l'écrit maintenant en
   * même temps que l'état, dans l'effet qui décide — jamais pendant un rendu.
   */
  useEffect(() => {
    if (path !== null) pathRef.current = path;
  }, [path]);
  // Bumped to build the pipeline again from scratch. iOS takes the media resources back when the
  // page goes to the background, and a MediaSource it has closed cannot be reopened — so coming
  // back from a locked screen means starting over, at the position the viewer left.
  const [rebuildCount, setRebuildCount] = useState(0);
  const rebuildAtRef = useRef<number | null>(null);
  /**
   * La dernière position demandée par le spectateur et pas encore atteinte — voir
   * `onSeekRequest`. Deux gestes rapprochés ne doivent pas en perdre un : un saut encore en
   * chargement suivi d'un changement de piste reconstruisait le lecteur à la position d'*avant*
   * le saut, et un saut fait pendant la reconstruction était écrasé par la position de départ du
   * nouveau lecteur (22/09/2026).
   */
  const requestedSeekRef = useRef<number | null>(null);
  /** Le saut en cours de mesure, pour la ligne `seek` du journal — le dernier demandé seulement. */
  const seekTimingRef = useRef<{ from: number; to: number; startedAt: number; hiddenAtStart: number; buffered: boolean; ranges: string } | null>(null);
  /**
   * Un saut qui n'arrive pas là où il était demandé n'écrivait rien : la ligne ne part qu'à
   * l'arrivée. 2012 sur iPhone (22/09/2026) : une tête passée de 2141 à 1681 s sans une trace.
   * Il est désormais écrit quand un autre geste le remplace, avec l'endroit où il est tombé.
   */
  const reportUnarrivedSeek = (landedAt: number, stillSeeking: boolean) => {
    const timing = seekTimingRef.current;
    if (!timing) return;
    seekTimingRef.current = null;
    // Remplacé par le geste suivant avant son `seeked` : le cas ordinaire d'une rafale. Arrivé
    // s'il était à sa cible — 125 lignes sur 128 « jamais arrivé » à tort le 22/09/2026.
    // Sauf pendant `seeking`, où currentTime vaut déjà la cible avant que rien n'y soit : un
    // saut remplacé en plein chargement se lisait « arrivé ». Là, le verdict n'est pas écrit —
    // l'endroit, si (chasse aux bugs du 22/09/2026).
    reportPlayback("seek", {
      ...describeFileRef.current(),
      path: "remux",
      from: Math.round(timing.from),
      to: Math.round(timing.to),
      buffered: timing.buffered,
      ranges: timing.ranges,
      ...(stillSeeking ? {} : { arrived: seekArrived(landedAt, timing.to) }),
      superseded: true,
      landedAt: Math.round(landedAt * 10) / 10,
      tookMs: seekElapsed(tally, timing),
      steps: traceRecent(Date.now() - timing.startedAt + 500).join(" | "),
    });
  };
  /** Où en est le film selon ce que le spectateur a demandé, pas seulement selon ce qu'il a vu. */
  const intendedPosition = useCallback((): number => {
    if (requestedSeekRef.current !== null) return requestedSeekRef.current;
    const element = videoElRef.current;
    // Un saut lancé par autre chose que les commandes (le système, la télécommande) : l'élément
    // dit déjà où il va, la position lue ne le saura qu'une fois le saut fini.
    if (element?.seeking) return element.currentTime;
    return positionRef.current;
  }, []);
  // Bounded, so a source that closes the instant it opens cannot become a rebuild loop.
  const rebuildsRef = useRef(0);
  const lastRebuildAtTimeRef = useRef(0);
  /**
   * Spends one of the rebuilds a session is allowed, or refuses.
   *
   * The budget decays, which it did not: three losses spread across a two-hour film exhausted it
   * as surely as three in nine seconds, and the fourth — an hour after the third, with everything
   * having worked in between — handed the film to the stable player mid-viewing. A loss that
   * keeps happening is a fault; one that happened once, was repaired, and did not come back for
   * several minutes is not the same fault, and the source below already reasons this way about
   * its own recoveries.
   */
  const spendRebuild = useCallback(() => {
    if (Date.now() - lastRebuildAtTimeRef.current > REBUILD_WINDOW_MS) rebuildsRef.current = 0;
    if (rebuildsRef.current >= MAX_REBUILDS) return false;
    rebuildsRef.current += 1;
    lastRebuildAtTimeRef.current = Date.now();
    return true;
  }, []);
  const lastRebuildAtRef = useRef<number | null>(null);
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
  const keepPausedRef = useRef(false);
  /** Quand le spectateur a mis en pause (page visible, film pas fini) — nul dès que ça rejoue. */
  const viewerPausedAtRef = useRef<number | null>(null);
  /** Le dernier passage en arrière-plan. */
  const hiddenAtRef = useRef<number | null>(null);
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
   * Chooses a subtitle, from the menu or from the viewer's account — a track of the file, told to
   * the pipeline, or a file beside the film, fetched here.
   */
  const chooseSubtitle = useCallback(
    (id: number | null, sources: ExternalSubtitleSource[]) => {
      wantedSubtitleRef.current = id;
      // Un décalage corrige une piste, pas la suivante.
      subtitleOffsetRef.current = 0;
      setSubtitleOffset(0);
      setCurrentSubtitle(id);
      setSubtitle(null);

      // Whichever is chosen, the other is turned off first: the pipeline showing a track from
      // the container and a file showing its own would both write the same line.
      const external = id !== null && isExternalTrack(id);
      remuxRef.current?.selectSubtitleTrack(external ? null : id);

      // Retiré tout de suite, y compris pour un autre fichier : l'ancien restait affiché pendant le
      // chargement du nouveau, et pour de bon si ce chargement échouait — du français sous un menu
      // qui disait anglais (relu le 24/09/2026).
      externalSubtitleRef.current = null;
      if (!external) return;
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
          if (!fetching.signal.aborted) showWarning(tRef.current("player.experimental.externalSubtitlesUnavailable"));
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
  const showSubtitleAt = useCallback(
    (playerSeconds: number, fromContainer: (at: number) => string | null, fileDelay = 0) => {
      const at = playerSeconds - subtitleOffsetRef.current;
      const external = externalSubtitleRef.current;
      // Un fichier à côté du film est daté sur l'horloge du fichier, pas sur celle du lecteur.
      setSubtitle(external ? external.textAt(at - fileDelay) : fromContainer(at));
    },
    []
  );

  // Reset for every attempt, not fixed at the mount. A rebuild lowers `ready`, and measured from
  // the mount the wait was instantly minutes long — so a rebuild that takes half a second
  // announced itself as "still working", which is a spinner lying about what it knows.
  const [openedAt, setOpenedAt] = useState(() => Date.now());

  /** Builds the pipeline again from where the viewer is, keeping what they had chosen. */
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

  const restart = useCallback((at: number, why: string) => {
    trace(`reprise : ${why} — reconstruction à ${at.toFixed(1)} s`);
    // Une reconstruction ne relance pas un film que le spectateur avait mis en pause : seuls le
    // changement de piste et le plafond HDR y veillaient, et un film arrêté, rendu par iOS au
    // retour d'arrière-plan, repartait tout seul (relu le 24/09/2026). Une pause suivie de près par
    // le passage en arrière-plan peut être celle d'iOS lui-même : elle ne compte que si elle le
    // précède d'une seconde au moins — sinon la reprise se fait comme avant.
    const pausedAt = viewerPausedAtRef.current;
    const hiddenAt = hiddenAtRef.current;
    if (pausedAt !== null && (hiddenAt === null || hiddenAt < pausedAt || pausedAt < hiddenAt - 1000)) keepPausedRef.current = true;
    traceKeepAcrossReset();
    rebuildAtRef.current = at;
    setOpenedAt(Date.now());
    setNetworkLost(null);
    setReady(false);
    // Rien ne joue pendant une reconstruction, et l'élément démonté ne le dira pas : ses écouteurs
    // sont déjà retirés. Resté vrai, `playing` comptait ce temps comme regardé et le rapportait
    // à Jellyfin « en lecture » (relu le 24/09/2026). Le pipeline suivant le repasse à vrai.
    setPlaying(false);
    setRuntimeError(null);
    setRebuildCount((count) => count + 1);
  }, []);

  // Fetched once and then left alone. The description of a file does not change while it is
  // being watched, and every revalidation handed back a fresh object — which the effect below
  // depends on, so the whole pipeline was torn down and rebuilt behind the viewer's back: a
  // second decoder, a second encoder, a second MediaSource, and the first one's read loop still
  // running against buffers its source had already released.
  // La clé que la fiche a préchargée à son ouverture (`usePlaybackPrefetch`) : la même, sans quoi
  // le préchargement tomberait à côté et Lire reposerait la question.
  const { data: info, error: infoError } = useSWR<DirectPlayInfo>(directInfoKey(itemId), fetcher, {
    // La description du fichier est ce qui décide du chemin de lecture : la mettre en pause parce
    // qu'un film occupe l'écran, c'est attendre que le film commence pour savoir comment le lire.
    ...playerBootstrapOptions,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
  });

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
  const subtitleChoices = useMemo(
    () => [...tracks.subtitles, ...(info?.externalSubtitles ?? []).map(externalToPlayerTrack)],
    [tracks.subtitles, info?.externalSubtitles]
  );
  const subtitleLabels = useSubtitleLabels(subtitleChoices);

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

  /**
   * Un serveur absent se dit autrement qu'un fichier illisible.
   *
   * Les deux échouaient sur la même phrase, qui décrivait le symptôme sans nommer la cause — et
   * quand la cause est « le serveur média est arrêté », c'est la seule chose que le spectateur ait
   * besoin de savoir : il n'y a rien à réessayer tout de suite, et rien de cassé chez lui.
   */
  const error =
    runtimeError ??
    info?.refusedReason ??
    (infoError ? errorMessage(infoError, t, "Impossible de récupérer les informations du fichier.") : null);
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
    }),
    [itemId, info, openedAs, session.bench, sessionId]
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

  /**
   * Comment la séance s'est terminée — la ligne `stop` du journal.
   *
   * Le type existait depuis le premier jour et rien ne l'envoyait : sur 503 lignes au 21/09, 444
   * `start` et pas un seul `stop`. Un film vu jusqu'au bout et un film abandonné au bout de trente
   * secondes laissaient donc exactement la même trace — et l'abandon silencieux, celui d'un
   * spectateur qui ferme plutôt que de se plaindre, est précisément la panne qu'aucun autre
   * enregistrement ne montre.
   *
   * Une seule fois par lecteur (il est remonté à chaque titre, voir la `key` de `PlayerHost`),
   * par le premier qui arrive : la croix, l'épisode suivant, la page qui s'en va, et le démontage
   * en dernier filet. Rien après un repli : la ligne `fallback` a déjà tout dit, et le lecteur
   * stable prend la suite de la séance.
   *
   * Tout est lu par des refs : les appelants — un écouteur `pagehide`, un nettoyage d'effet —
   * vivent plus longtemps que le rendu qui les a créés.
   */
  const stopReportedRef = useRef(false);
  const mountedAtRef = useRef(0);
  useEffect(() => {
    mountedAtRef.current = Date.now();
  }, []);
  // Le temps passé à jouer, pas l'écart entre la position d'arrivée et celle de départ : un saut
  // de quarante minutes n'est pas quarante minutes regardées.
  const watchedRef = useRef<{ total: number; since: number | null }>({ total: 0, since: null });
  useEffect(() => {
    if (!playing) return;
    const watched = watchedRef.current;
    watched.since = Date.now();
    return () => {
      if (watched.since !== null) watched.total += Date.now() - watched.since;
      watched.since = null;
    };
  }, [playing]);
  const stopFactsRef = useRef({ ready: false, ended: false, error: null as string | null, audio: null as number | null, rebuilds: 0 });
  useEffect(() => {
    stopFactsRef.current = { ready, ended, error, audio: currentAudio, rebuilds: rebuildCount };
  }, [ready, ended, error, currentAudio, rebuildCount]);
  /**
   * Le bilan de la séance à cet instant — ce que dit la ligne `stop`, et ce qui est gardé sur
   * l'appareil au cas où elle ne pourrait pas partir (voir unsentStop.ts).
   */
  const stopFields = useCallback(
    (why: "close" | "next" | "page" | "unmount" | "lost") => {
      const now = Date.now();
      const facts = stopFactsRef.current;
      const watched = watchedRef.current;
      const watchedMs = watched.total + (watched.since !== null ? now - watched.since : 0);
      return {
        ...describeFileRef.current(),
        path: pathRef.current ?? "non décidé",
        why,
        at: positionRef.current,
        watched: Math.round(watchedMs / 1000),
        ended: facts.ended,
        rebuild: facts.rebuilds,
        ...(facts.audio !== null ? { audio: facts.audio } : {}),
        // Fermé avant la première image : combien de temps le spectateur a attendu avant de renoncer.
        ...(facts.ready ? {} : { gaveUpAfterMs: now - mountedAtRef.current }),
        ...(facts.error ? { error: facts.error } : {}),
        // Attentes, sauts, changements de piste : le confort de la séance en quelques chiffres.
        ...tally.summary(now),
        ...syncFacts(remuxRef.current, videoElRef.current ?? lastVideoElRef.current),
      };
    },
    [tally]
  );
  const reportStop = useCallback(
    (why: "close" | "next" | "page" | "unmount") => {
      if (stopReportedRef.current || steppedAside.current) return;
      stopReportedRef.current = true;
      reportPlayback("stop", stopFields(why));
      clearUnsentStop(sessionId);
    },
    [stopFields, sessionId]
  );
  /**
   * Le bilan gardé sur l'appareil, réécrit tant que la séance vit.
   *
   * Toutes les 30 s, et à chaque passage en arrière-plan — le dernier instant où une page qu'iOS
   * va tuer peut encore écrire quoi que ce soit. Jamais une fois l'arrêt parti ou la main passée.
   */
  useEffect(() => {
    const save = () => {
      if (stopReportedRef.current || steppedAside.current) return;
      saveUnsentStop(sessionId, stopFields("lost"));
    };
    save();
    const timer = setInterval(save, 30_000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        tally.hidden(Date.now());
        hiddenAtRef.current = Date.now();
        save();
      } else {
        tally.shown(Date.now());
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sessionId, stopFields, tally]);
  useEffect(() => {
    const onPageHide = () => reportStop("page");
    // Une page rendue depuis le cache du navigateur (retour arrière) reprend le film : son arrêt
    // réel, plus tard, doit être noté lui aussi — il ne l'était jamais (23/09/2026).
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) stopReportedRef.current = false;
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      reportStop("unmount");
    };
  }, [reportStop]);

  const { stop: stopPlaybackNow, resume: resumePlaybackSession } = usePlaybackSession(
    useCallback(() => positionRef.current, []),
    // The native player reads the file directly, so there is no Jellyfin transcode session — but
    // progress still has to be reported, or resume points would stop updating for this player.
    // It announces its own start for the same reason: nothing else tells the server this film is
    // being watched, so without it the reports described a session Jellyfin had never heard of.
    // Rien pour le banc d'essai : il saute jusqu'à la fin des films, qui seraient tous marqués vus.
    announced && !session.bench
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
  const endStoppedRef = useRef(false);
  const reopenAfterEnd = useCallback(() => {
    if (!endStoppedRef.current) return;
    endStoppedRef.current = false;
    resumePlaybackRef.current();
  }, []);

  useEffect(() => () => subtitleFetchRef.current?.abort(), []);

  const handleClose = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    reportStop("close");
    const reported = stopPlaybackNow();
    setClosing(true);
    // Cette lecture-ci seulement : voir `close(openId)`.
    const openId = session.openId;
    setTimeout(() => playback.close(openId), 200);
    // Voir PlayerHost : la fiche et la rangée « Reprendre » sont fausses dès qu'on quitte le film,
    // et les deux lecteurs doivent les relire de la même façon.
    void refreshAfterPlayback(reported, itemId);
  }, [playback, stopPlaybackNow, itemId, reportStop, session.openId]);

  const nextEpisode = session.getNextEpisode?.(itemId) ?? null;

  // Swaps to the next episode in place: the current one's final position is reported first, as
  // on a manual close, but the player stays open so there is no close/reopen flicker between
  // episodes.
  const handleAdvance = useCallback(() => {
    if (!nextEpisode) return;
    reportStop("next");
    stopPlaybackNow();
    playback.advance(nextEpisode);
  }, [nextEpisode, playback, stopPlaybackNow, reportStop]);

  // Lu par les écouteurs de l'horloge, posés une fois pour toutes — voir `warmNextEpisode`.
  const nextEpisodeIdRef = useRef<string | null>(null);
  useEffect(() => {
    nextEpisodeIdRef.current = session.bench ? null : (nextEpisode?.itemId ?? null);
  }, [nextEpisode?.itemId, session.bench]);

  const handleExpand = useCallback(() => playback.expand(), [playback]);
  const { pos, size, isDragging, handlers } = useMiniPlayerDrag(isMini, handleExpand);

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
    };
    read(); // straight away, not after the first tick
    const id = setInterval(read, 500);
    return () => clearInterval(id);
  }, [showInfo, error, stuck]);


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
      if (!isUpstreamUnreachable(infoError)) {
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
    const applyPreferences = (
      audio: PlayerTrack[],
      subtitles: PlayerTrack[],
      /**
       * « Cette piste joue-t-elle par ce chemin ? », posée par celui qui sait répondre — le chemin
       * remultiplexé. Sans elle, le classement ignore ce critère.
       */
      carriable?: (track: PlayerTrack) => boolean,
      /** La piste sur laquelle ce chemin s'est ouvert — celle qu'on entend faute de préférence. */
      openedAudio: number | null = null
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
      const wantedAudio = chooseAudioTrack(audio, preferences, carriable);
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
      });
    };

    const declareReady = () => {
      setStartingAt(null);
      // The position this pipeline was built to resume at has now been used, and is cleared here
      // rather than from an effect watching readiness. That effect could land *after* a newer
      // failure had already written the next position — and it did: a source lost in the same
      // tick as the start had its position wiped, so the film began again from zero instead of
      // resuming. Cleared at the exact moment the pipeline that consumed it is running, nothing
      // written afterwards can be undone by it.
      rebuildAtRef.current = null;
      // Un saut demandé pendant la reconstruction, ailleurs que là où elle a rouvert : il est
      // honoré maintenant, sur le lecteur neuf, au lieu d'être écrasé par sa position de départ.
      const asked = requestedSeekRef.current;
      if (asked !== null && Math.abs(asked - startSeconds) > 0.5) {
        const media = videoElRef.current;
        if (media) media.currentTime = asked;
      } else requestedSeekRef.current = null;
      setReady(true);
      setAnnounced(true);
      everReadyRef.current = true;
      networkRetriesRef.current = 0;
    };
    // Where to open. A rebuild that asked for a position gets it; otherwise the film resumes
    // where it actually is, and only a player that has never played anything falls back to where
    // it was told to start. Without that last part, a rebuild nobody asked for — and there was
    // one, every time the player was minimised — sent the film back to where it began.
    let startSeconds =
      rebuildAtRef.current ??
      (positionRef.current > 0 ? positionRef.current : session.resumeAt ?? playbackState?.resumeSeconds ?? 0);
    // Reprendre quelques secondes avant, à la première ouverture seulement — jamais pour une
    // reconstruction, qui rouvre là où l'image vient de s'arrêter. Voir `resumeRewind.ts`.
    if (!openingDecidedRef.current) {
      openingDecidedRef.current = true;
      if (rebuildAtRef.current === null && !session.bench && startSeconds > 0 && awayFrom(itemId)) {
        const earlier = rewound(startSeconds, info.runtimeSeconds);
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

      remuxRef.current = playback;
      pathRef.current = "remux";
      setPath("remux");
      announceStart("remux", "remultiplexage → lecteur natif");
      setTracks({ audio: playback.audioTracks, subtitles: playback.subtitleTracks });

      // Given back what the viewer had chosen, if this pipeline is a replacement for one that
      // had it. A film that comes back after a network cut in the wrong language, with the
      // subtitles gone, has not really come back.
      // What the viewer chose, if this pipeline replaces one that had it — and otherwise what
      // their account asks for, which is what a first opening gets.
      const preferred = applyPreferences(
        playback.audioTracks,
        playback.subtitleTracks,
        (track) => playback.canCarryAudio(track.number),
        playback.currentAudioTrack
      );
      const wantedAudio = wantedAudioRef.current ?? preferred;
      const wantedSubtitle = wantedSubtitleRef.current;
      // A track number from a file beside the film means nothing to a pipeline reading the
      // file itself; it is answered here instead, out of what was already fetched.
      if (wantedSubtitle !== null && !isExternalTrack(wantedSubtitle)) playback.selectSubtitleTrack(wantedSubtitle);
      setCurrentSubtitle(wantedSubtitle);
      setCurrentAudio(playback.currentAudioTrack);
      declareReady();
      // Un changement de piste qui a demandé cette reconstruction : il se termine ici, sur la
      // piste voulue, et c'est ici qu'on sait combien il a coûté.
      const pendingSwitch = pendingSwitchRef.current;
      if (pendingSwitch) {
        pendingSwitchRef.current = null;
        reportAudioSwitch(pendingSwitch.from, pendingSwitch.fromLabel, pendingSwitch.to, pendingSwitch.startedAt, playback, "reconstruction");
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
      if (openingSwitch === "rebuild" && wantedAudio !== null) {
        pendingSwitchRef.current = {
          from: playback.currentAudioTrack,
          fromLabel: playback.diagnostics["Audio"] ?? "",
          to: wantedAudio,
          startedAt: Date.now(),
        };
        wantedAudioRef.current = wantedAudio;
        restart(startSeconds, `piste ${wantedAudio} voulue, autre que celle ouverte — reconstruction sur elle`);
        return;
      }
      if (openingSwitch === "refused" && wantedAudio !== null) {
        reportAudioSwitch(playback.currentAudioTrack, playback.diagnostics["Audio"] ?? "", wantedAudio, Date.now(), playback, "refus");
      }

      let notedAt = 0;
      const onTime = () => {
        positionRef.current = element.currentTime;
        showSubtitleAt(element.currentTime, (at) => playback.subtitleAt(at), playback.presentationDelay);
        // Retenu toutes les quinze secondes de lecture : ce qui distingue, à la prochaine
        // ouverture, un relais d'une vraie reprise (voir `resumeRewind.ts`).
        if (!element.paused && !session.bench && Date.now() - notedAt > 15_000) {
          notedAt = Date.now();
          noteWatching(itemId);
        }
        warmNextNear(nextEpisodeIdRef.current, element.currentTime, element.duration, info.creditsStart ?? null);
      };
      // A warning about not being able to reach a position is obsolete the instant pictures are
      // moving again. Leaving it up made a recovered hiccup look like a lasting fault.
      let pausedAt: number | null = null;
      const onPlay = () => {
        // Après une longue pause, quelques secondes en arrière pour se remettre dans la scène.
        // Pas après la fin — c'est « Revoir », ou un épisode relancé —, ni pendant un saut.
        if (
          pausedAt !== null &&
          Date.now() - pausedAt >= AWAY_MS &&
          !endStoppedRef.current &&
          !element.seeking &&
          !session.bench
        ) {
          const target = rewound(element.currentTime, element.duration);
          if (target < element.currentTime) {
            trace(`reprise après ${Math.round((Date.now() - pausedAt) / 60_000)} min de pause : ${target.toFixed(1)} s`);
            element.currentTime = target;
          }
        }
        pausedAt = null;
        viewerPausedAtRef.current = null;
        setPlaying(true);
        setEnded(false);
        showWarning(null);
        reopenAfterEnd();
      };
      const onPause = () => {
        setPlaying(false);
        if (document.visibilityState === "visible" && !element.ended) viewerPausedAtRef.current = Date.now();
        tally.waitEnded(Date.now());
        pausedAt = Date.now();
        if (!session.bench) noteWatching(itemId);
      };
      /**
       * Les attentes en pleine lecture — voir `SessionTally`. Ni celles d'un saut, qui a sa ligne,
       * ni celle d'avant la première image de ce lecteur, qui est l'ouverture.
       */
      let playedOnce = false;
      const onWaiting = () => {
        if (playedOnce && !element.seeking && requestedSeekRef.current === null) tally.waitStarted(Date.now());
      };
      const onPlaying = () => {
        playedOnce = true;
        tally.waitEnded(Date.now());
      };
      const onSeeking = () => tally.waitAbandoned();
      const onEnded = () => {
        setPlaying(false);
        setEnded(true);
        // La fin est annoncée à Jellyfin tout de suite : c'est cet arrêt, en fin de fichier, qui
        // marque le film « vu ». Il ne partait qu'à la fermeture — « Revoir » le remplaçait par
        // la position de la seconde vision, et une application tuée en arrière-plan sur l'écran
        // de fin ne l'envoyait jamais (relevé le 23/09/2026).
        void stopPlaybackRef.current();
        endStoppedRef.current = true;
      };
      // Le saut demandé est atteint : la position lue redevient la vérité.
      const onSeeked = () => {
        if (requestedSeekRef.current !== null && seekArrived(element.currentTime, requestedSeekRef.current)) {
          requestedSeekRef.current = null;
        }
        // Posée ailleurs que la cible — sur le premier média, sur l'image clé suivante — mais
        // arrivée selon la source : la cible demandée ne vaut plus. Restée en mémoire, elle servait
        // de position au changement de piste suivant, fût-il vingt minutes plus tard (audit du
        // 22/09/2026). Lu après ce tour : la source écoute le même événement, et après l'hôte.
        setTimeout(() => {
          if (requestedSeekRef.current !== null && remuxRef.current?.seekPending === false && !element.seeking) {
            requestedSeekRef.current = null;
          }
        }, 0);
        const timing = seekTimingRef.current;
        if (timing && seekArrived(element.currentTime, timing.to)) {
          seekTimingRef.current = null;
          tally.seekArrived(seekElapsed(tally, timing));
          reportPlayback("seek", {
            ...describeFileRef.current(),
            path: "remux",
            from: Math.round(timing.from),
            to: Math.round(timing.to),
            buffered: timing.buffered,
            ranges: timing.ranges,
            tookMs: seekElapsed(tally, timing),
            // Ce que la source a fait entre la demande et l'arrivée — et une demi-seconde avant,
            // pour le geste qui l'a lancée. Un saut arrière suivi d'un blocage (22/09/2026) ne
            // laissait au journal que « de 176 à 166 en 900 ms », sans rien de ce qui l'avait servi.
            steps: traceRecent(Date.now() - timing.startedAt + 500).join(" | "),
          });
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
      unsubscribes.push(() => {
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
      if (keepPausedRef.current) {
        keepPausedRef.current = false;
        return;
      }
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
    probePlaybackPath({
      streamUrl: info.streamUrl,
      // La taille, déjà dans la description du fichier : l'ouverture n'a plus à la demander par
      // un HEAD, et les deux premières plages partent sans attendre cet aller-retour.
      knownSize: info.sizeBytes,
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
      // Reconstruit pour un changement de piste pendant une pause : rien ne doit le relancer, ni
      // ce composant (voir startRemux) ni la garde de démarrage de la source.
      startPaused: keepPausedRef.current,
      onError: (message, kind) => {
        // A network failure is not this path's fault and not this path's to fix.
        if (kind === "network") {
          trace(`réseau : lecture interrompue — ${message}`);
          reportPlayback("network", { ...describeFileRef.current(), reason: message, at: positionRef.current });
          setNetworkLost({ message, at: positionRef.current, audio: wantedAudioRef.current });
          setPlaying(false);
          return;
        }
        // A closed source is not a fault to report, it is a pipeline to build again. Safari
        // closes one from time to time — a decode failure it will not explain, sometimes on a
        // seek, sometimes at a change of track — and everything that follows is wreckage. The
        // machinery for the sleep case already knows how to come back at the right position, so
        // it is used here too, and only a loss that keeps happening is finally reported.
        if (remuxRef.current?.lost && spendRebuild()) {
          const where = remuxRef.current.position || positionRef.current;
          // The same place twice means the media there is what the platform cannot take. Reading
          // it again would fail again, identically — the record shows three rebuilds doing
          // exactly that — so the film resumes past it instead.
          const again = lastRebuildAtRef.current !== null && Math.abs(where - lastRebuildAtRef.current) < SAME_PLACE_SECONDS;
          const at = again ? where + REBUILD_STEP_SECONDS : where;
          lastRebuildAtRef.current = where;
          reportPlayback("rebuild", {
            ...describeFileRef.current(),
            // Comme la reconstruction d'arrière-plan : sans lui, une ligne sur deux n'avait pas de
            // chemin, et tout regroupement par chemin la perdait.
            path: "remux",
            reason: message,
            at,
            attempt: rebuildsRef.current,
            skipped: again,
            // Les tampons et la trace au moment de la perte : sans eux, un « Media failed to
            // decode » ne disait pas si c'étaient nos données ou l'appareil (23/09/2026).
            ...remuxRef.current?.lossReport(),
          });
          restart(
            at,
            `la source a été perdue (${rebuildsRef.current})` +
              (again ? `, au-delà de ${where.toFixed(1)} s qui vient d'échouer` : "")
          );
          // Only the first of these is the viewer's business: a passage of the film is being
          // skipped, and a jump nobody explained looks like a fault. Rebuilding in place and
          // carrying on is not something they need to be told about — it is in the record.
          if (again) showWarning(tRef.current("player.experimental.passageSkipped"));
          return;
        }
        fallToStable(message);
      },
      onWarning: showPipelineWarning,
      onStarting: (at) => setStartingAt(at),
      // Une horloge qui ne bouge plus alors que l'élément dit jouer : écrit tel quel, une fois par
      // blocage. Rien à décider ici — les reprises sont déjà en cours dans la source.
      onStall: (facts) => reportPlayback("stall", { ...describeFileRef.current(), path: "remux", ...facts }),
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
          trace(`réseau : ouverture impossible — ${message}`);
          setNetworkLost({ message, at: positionRef.current, audio: wantedAudioRef.current });
          setPlaying(false);
          return;
        }
        // Reconstruit pour une piste que le lecteur natif n'a finalement pas pu ouvrir — module
        // TrueHD injoignable, encodeur qui refuse : le lecteur serveur coûterait un film qui jouait
        // très bien, pour un choix de langue. On revient à la piste d'avant.
        if (revertFailedSwitch(message)) return;
        fallToStable(message);
      });

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      remuxRef.current?.destroy();
      remuxRef.current = null;
    };
  // `reportAudioSwitch` ne dépend que de `tally`, fixé au montage : son identité ne change jamais,
  // donc l'ajouter ici ne peut pas relancer la construction du pipeline. C'est la seule raison
  // pour laquelle il peut y figurer — voir la note sur les rappels lus à travers une `ref`. Même
  // chose pour `showPipelineWarning`, qui ne dépend que de `showWarning`, stable lui aussi, et
  // pour `tally`, créé une fois au montage (`useState`) et jamais remplacé, pour
  // `reopenAfterEnd`, sans dépendance (`useCallback([])`), et pour `itemId` et `session.bench`,
  // fixés pour toute la vie de ce lecteur — sa clé est `itemId:openId` (voir PlayerHost).
  }, [info, infoError, playbackState, fallToStable, restart, session.resumeAt, rebuildCount, showSubtitleAt, showWarning, showPipelineWarning, chooseSubtitle, spendRebuild, reportAudioSwitch, tally, reopenAfterEnd, itemId, session.bench]);

  // Watches for the platform having taken the source away while the page was not on screen. The
  // check runs on returning to the foreground, and once more a moment later: on iOS the closure
  // is not always visible in the same task as the visibility change.
  useEffect(() => {
    if (path !== "remux") return;
    const check = () => {
      const playback = remuxRef.current;
      if (!playback?.lost || rebuildAtRef.current !== null) return;
      if (!spendRebuild()) return;
      const at = playback.position || positionRef.current;
      // Écrit au journal, et plus seulement dans la trace : une reconstruction au retour se lisait
      // comme une ouverture de plus, et combien de retours d'arrière-plan en coûtent une restait
      // une question sans réponse (23/09/2026).
      tally.backgroundRebuilt();
      reportPlayback("rebuild", {
        ...describeFileRef.current(),
        path: "remux",
        reason: "source fermée en arrière-plan",
        at,
        hiddenMs: tally.lastBackgroundMs,
      });
      // Un film fini attend sur son écran de fin : reconstruit en lecture, il rejouait tout seul
      // ses deux dernières secondes, son compris, et annonçait sa fin une seconde fois (relu le
      // 24/09/2026). Reconstruit à l'arrêt, « Revoir » le relance comme avant.
      if (endStoppedRef.current) keepPausedRef.current = true;
      restart(at, "la plateforme a fermé la source");
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      check();
      setTimeout(check, 400);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [path, restart, spendRebuild, tally]);

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
  //
  // Espacé à chaque échec : « en ligne » dit que le téléphone a du réseau, pas que le serveur
  // répond. Pendant un redéploiement — plusieurs par jour — le lecteur relançait toutes les
  // 0,8 s, sans fin, une reconstruction vouée à échouer (relu le 22/09/2026). 0,8 s, puis 1,6,
  // 3,2… jusqu'à 30 s ; le compte repart à zéro dès qu'une image est revenue.
  useEffect(() => {
    if (!networkLost || !online) return;
    const at = networkLost.at;
    const delay = Math.min(800 * 2 ** networkRetriesRef.current, 30_000);
    const id = setTimeout(() => {
      networkRetriesRef.current += 1;
      restart(at, "le réseau est revenu");
    }, delay);
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
    //
    // Ni quand une erreur est déjà à l'écran — le serveur de médias injoignable, par exemple, qui
    // refuse exprès de passer la main : le minuteur la passait quand même trente-cinq secondes
    // plus tard, au lecteur serveur qui échouait de la même façon, et le titre y restait pour
    // toute la séance (relevé le 23/09/2026).
    if (ready || runtimeError || networkLost || error) return;
    const id = setTimeout(
      () => fallToStable(`aucune image après ${GIVE_UP_AFTER_MS / 1000} s`),
      Math.max(0, openedAt + GIVE_UP_AFTER_MS - Date.now())
    );
    return () => clearTimeout(id);
  }, [ready, runtimeError, networkLost, error, openedAt, fallToStable]);


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
        transition: resizing
          ? "opacity 220ms ease-out, transform 220ms cubic-bezier(0.32, 0.72, 0, 1)"
          : `${TRANSITION}, opacity 220ms ease-out, transform 220ms cubic-bezier(0.32, 0.72, 0, 1)`,
        opacity: revealed && !closing ? 1 : 0,
        // Une échelle très légère : assez pour que l'œil suive le passage d'un écran à l'autre,
        // pas assez pour que ça ressemble à un effet.
        transform: revealed && !closing ? "scale(1)" : "scale(0.985)",
      };

  /**
   * Un saut demandé depuis les commandes — ou depuis le banc d'essai, qui passe par ici pour que
   * ce qu'il mesure soit ce que vit le spectateur.
   */
  const noteSeekRequest = (seconds: number) => {
    requestedSeekRef.current = seconds;
    // Une reconstruction pas encore ouverte rouvre directement là.
    if (rebuildAtRef.current !== null) rebuildAtRef.current = seconds;
    // Mesuré une fois le chemin natif en marche : c'est le `seeked` de son élément qui ferme la
    // mesure. Avant, rien ne la fermerait, et le saut suivant écrirait celle-ci en ligne fausse —
    // tombée à 0, jamais arrivée (le cas du chemin canevas, chasse aux bugs du 22/09/2026).
    if (pathRef.current !== "remux") {
      seekTimingRef.current = null;
      return;
    }
    // Mesuré jusqu'à l'arrivée (`seeked`). Un saut qui en remplace un autre en cours
    // remplace aussi sa mesure : c'est le dernier geste qui compte.
    const element = videoElRef.current;
    let buffered = false;
    // Les plages elles-mêmes, pas seulement « la cible y est » (24/09/2026) : trois sauts notés
    // `buffered` ont trouvé leur cible vide 0,7 s plus tard, et la ligne ne permettait pas de
    // dire ce qu'il y avait autour. Les quatre plus proches de la cible, écrites court.
    const near: [number, number][] = [];
    for (let i = 0; element && i < element.buffered.length; i++) {
      const start = element.buffered.start(i);
      const end = element.buffered.end(i);
      if (start <= seconds && seconds < end) buffered = true;
      near.push([start, end]);
    }
    const ranges =
      near
        .sort((a, b) => Math.abs((a[0] + a[1]) / 2 - seconds) - Math.abs((b[0] + b[1]) / 2 - seconds))
        .slice(0, 4)
        .sort((a, b) => a[0] - b[0])
        .map(([start, end]) => `${start.toFixed(1)}–${end.toFixed(1)}`)
        .join(" · ") || "vide";
    reportUnarrivedSeek(element?.currentTime ?? positionRef.current, element?.seeking ?? false);
    seekTimingRef.current = { from: positionRef.current, to: seconds, startedAt: Date.now(), hiddenAtStart: tally.hiddenMsSoFar(Date.now()), buffered, ranges };
  };

  /** Un changement de piste audio — les commandes et le banc d'essai, par le même chemin. */
  const changeAudioTrack = (id: number) => {
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
      pendingSwitchRef.current = {
        from: playback.currentAudioTrack ?? null,
        fromLabel: playback.diagnostics["Audio"] ?? "",
        to: id,
        startedAt: Date.now(),
      };
      // Un film à l'arrêt reste à l'arrêt : le spectateur a changé de langue, pas lancé
      // la lecture.
      keepPausedRef.current = videoElRef.current?.paused ?? false;
      wantedAudioRef.current = id;
      setCurrentAudio(id);
      setFrozen(freezeFrame());
      // Là où le spectateur a demandé d'être, pas seulement là où il en était : un saut
      // encore en chargement n'a pas encore déplacé la position lue.
      restart(intendedPosition(), `piste ${id} — reconstruction sur elle`);
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
  const benchStateRef = useRef<{
    seek: (seconds: number) => void;
    changeAudio: (id: number) => void;
    changeSubtitle: (id: number | null) => void;
    ready: boolean;
    path: string | null;
    error: string | null;
    audio: { id: number; label: string }[];
    subtitles: { id: number; label: string }[];
    currentAudio: number | null;
    currentSubtitle: number | null;
    subtitle: string | null;
    fps: number | null;
  } | null>(null);
  useEffect(() => {
    benchStateRef.current = {
      seek: noteSeekRequest,
      changeAudio: changeAudioTrack,
      changeSubtitle: (id) => chooseSubtitle(id, info?.externalSubtitles ?? []),
      ready,
      path,
      error: runtimeError ?? (networkLost ? "connexion perdue" : null),
      audio: tracks.audio.map((track) => ({ id: track.number, label: audioLabels.get(track.number) ?? String(track.number) })),
      subtitles: subtitleChoices.map((track) => ({ id: track.number, label: subtitleLabels.get(track.number) ?? String(track.number) })),
      currentAudio,
      currentSubtitle,
      subtitle,
      fps: info?.video?.frameRate ?? null,
    };
  });
  useEffect(() => {
    if (!session.bench) return;
    const state = () => benchStateRef.current;
    const media = () => videoElRef.current;
    return registerBenchBridge({
      itemId,
      media,
      path: () => state()?.path ?? null,
      ready: () => state()?.ready ?? false,
      error: () => state()?.error ?? null,
      duration: () => {
        const d = media()?.duration ?? 0;
        return Number.isFinite(d) ? d : 0;
      },
      // Comme les commandes : le signal d'abord, puis l'élément (voir `commitSeek`).
      seek: (seconds) => {
        state()?.seek(seconds);
        const element = media();
        if (element) element.currentTime = seconds;
      },
      audioTracks: () => state()?.audio ?? [],
      currentAudio: () => state()?.currentAudio ?? null,
      changeAudio: (id) => state()?.changeAudio(id),
      subtitleTracks: () => state()?.subtitles ?? [],
      currentSubtitle: () => state()?.currentSubtitle ?? null,
      changeSubtitle: (id) => state()?.changeSubtitle(id),
      subtitleText: () => state()?.subtitle ?? null,
      frames: () => {
        try {
          return videoElRef.current?.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
        } catch {
          return null;
        }
      },
      nominalFps: () => state()?.fps ?? null,
      trace: (ms) => traceRecent(ms).join(" | "),
      facts: () => syncFacts(remuxRef.current, videoElRef.current ?? lastVideoElRef.current),
    });
  }, [session.bench, itemId]);

  // Les bandes noires incrustées dans le fichier : l'image est agrandie jusqu'au bord le plus
  // proche, sans rien couper — voir `frameFit`. Pas dans le mini-lecteur, qui remplit déjà sa
  // fenêtre (`object-cover`).
  const frameFitState = useFrameFit(itemId, !isMini, containerRef, videoElRef);

  // Après tous les hooks : le banc d'essai en a ajouté trois au-dessus, et un retour anticipé
  // avant eux en changeait le nombre d'un rendu à l'autre.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
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

      {subtitle && !isMini && (
        // En haut quand le fichier le demande (`{\an8}`) : un sous-titre forcé qui traduit un texte
        // à l'image ne doit pas le cacher. Voir `subtitlePlacement`.
        <div
          className={`pointer-events-none absolute inset-x-0 z-10 flex justify-center px-8 ${
            subtitlePlacement(subtitle).top ? "top-20" : "bottom-24"
          }`}
        >
          <p
            // Ni taille ni couleur écrites ici : ce lecteur dessine ses lignes lui-même, et il
            // ignorait donc les réglages de sous-titres, qui ne touchaient que les pistes natives.
            // Un réglage qui marche un film sur deux n'est pas un réglage — voir `subtitleStyle`.
            className="max-w-4xl whitespace-pre-line text-center font-display font-medium leading-snug"
            style={overlayCss(subtitleStyle)}
          >
            {subtitlePlacement(subtitle).text}
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
              {online ? t("player.experimental.connectionBack") : t("player.experimental.connectionLost")}
            </p>
            <p className="mt-1 max-w-md text-sm leading-6 text-slate-400">
              {online ? t("player.experimental.connectionBackBody") : t("player.experimental.connectionLostBody")}
            </p>
          </div>
          <p className="text-xs text-slate-500">
            {t("player.experimental.resumeAt", { time: formatClock(networkLost.at) })}
            {networkLost.audio !== null &&
              ` · ${tracks.audio.find((a) => a.number === networkLost.audio)?.language ?? t("player.experimental.chosenTrack")}`}
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => restart(networkLost.at, "réessai demandé")}
              className="btn-primary inline-flex items-center gap-2"
            >
              <RotateCw size={16} />
              {t("player.experimental.retry")}
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="btn btn-ghost px-4 py-2"
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      )}

      {/* La fin d'un film. Jamais celle d'un épisode : une série a son propre enchaînement, et
          deux propositions au même moment se disputeraient l'écran. */}
      {ended && !nextEpisode && !isMini && !error && (
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
        />
      )}

      {error && !networkLost && !isMini && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
          <AlertTriangle className="text-amber-400" size={32} />
          {/* Deux écrans, un seul gabarit. Là où un lecteur serveur existe, cet écran est une
              proposition — « celui-ci n'y arrive pas, l'autre peut-être » — et le titre dit
              lequel des deux a renoncé. Là où il n'en existe pas, c'est une fin de course : la
              phrase ne doit désigner aucun lecteur, puisqu'il n'y a pas de second à essayer, et
              le bouton qui y menait n'a plus de destination. */}
          <p className="text-base font-medium text-white">
            {serverFallback === false ? t("player.unplayable") : t("player.experimental.title")}
          </p>
          <p className="max-w-lg text-sm leading-6 text-slate-300">{error}</p>
          <ExperimentalPlayerReport input={report} />
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            {serverFallback !== false && (
              <button type="button" onClick={() => fallToStable(error ?? "demandé par le spectateur")} className="btn-primary">
                {t("player.experimental.switchToStable")}
              </button>
            )}
            <button
              type="button"
              onClick={handleClose}
              className={serverFallback === false ? "btn-primary" : "btn btn-ghost px-4 py-2"}
            >
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
            className={`absolute inset-0 z-10 transition-opacity duration-200 ease-out ${
              ready ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
            // Hors d'atteinte tant qu'elles s'effacent : ni toucher, ni focus.
            inert={!ready}
          >
          <PlayerControls
            // A real media element: seeking, volume and rate are the browser's own.
            videoRef={videoElRef}
            onSeekRequest={noteSeekRequest}
            containerRef={containerRef}
            itemId={itemId}
            title={title}
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
            currentAudioId={currentAudio}
            onChangeAudio={changeAudioTrack}
            subtitleTracks={subtitleChoices.map((track) => ({
              id: track.number,
              label: subtitleLabels.get(track.number) ?? String(track.number),
            }))}
            currentSubtitleId={currentSubtitle}
            onChangeSubtitle={(id) => chooseSubtitle(id, info?.externalSubtitles ?? [])}
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
            // Et pas de clavier non plus : l'écouteur est posé sur la fenêtre, `inert` ne l'arrête pas.
            // Ni sous l'écran de fin : la barre d'espace y relançait le film par-dessous, sans
            // rouvrir la séance que la fin avait close — « Revoir » le fait, pas le clavier.
            // Sous l'écran « connexion perdue » aussi : une flèche y déplaçait la reprise annoncée,
            // et la barre d'espace jouait un élément mort (relu le 24/09/2026).
            suspended={!ready || networkLost !== null || (ended && !nextEpisode && !isMini && !error)}
            // L'interrupteur n'apparaît que s'il y a un agrandissement à défaire — voir `useFrameFit`.
            frameFit={frameFitState.available ? { on: frameFitState.on, onChange: frameFitState.setOn } : undefined}
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
                      keepPausedRef.current = videoElRef.current?.paused ?? false;
                      setFrozen(freezeFrame());
                      restart(intendedPosition(), `plafond HDR ${choice}`);
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
      {openingSpinner && !error && !networkLost && !isMini && (
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
      {!openingSpinner && resumeSpinner && waitingWord && !error && !networkLost && !isMini && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 mt-10 flex justify-center">
          <p className="text-sm text-slate-400">{waitingWord}</p>
        </div>
      )}
    </div>,
    document.body
  );
}
