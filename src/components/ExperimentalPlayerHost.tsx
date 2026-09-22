"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { AlertTriangle, RotateCw, WifiOff, X } from "lucide-react";
import { fetcher, playerBootstrapOptions, refreshAfterPlayback } from "@/lib/swr";
import { errorMessage, isUpstreamUnreachable } from "@/lib/upstreamError";
import { usePlayback } from "@/components/PlaybackProvider";
import { PlayerControls } from "@/components/PlayerControls";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { isPlayerWarning } from "@/lib/webcodecs/playerWarning";
import { subtitlePlacement } from "@/lib/webcodecs/subtitleMarkup";
import { displayIsHdr, hdrLightCap, readHdrCapChoice, writeHdrCapChoice } from "@/lib/webcodecs/hdrDisplay";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { PLAYBACK_CLIENTS } from "@/lib/playbackClients";
import { useViewportResizing } from "@/lib/useViewportResizing";
import { useT, useLocale } from "@/components/TranslationProvider";
import { PlaybackEngine } from "@/lib/webcodecs/engine";
import { MediaElementFacade, asVideoElement } from "@/lib/webcodecs/mediaFacade";
import { probePlaybackPath, type RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";
import { describePath } from "@/lib/webcodecs/pathSelector";
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
import { describeRemuxPlayback } from "@/lib/playbackPanel";
import type { EngineTrack } from "@/lib/webcodecs/engine";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import type { PlaybackState } from "@/app/api/jellyfin/playback-state/[itemId]/route";
import {
  ExternalSubtitleTrack,
  isExternalTrack,
  toEngineTrack as externalToEngineTrack,
  type ExternalSubtitleSource,
} from "@/lib/webcodecs/externalSubtitles";
import { chooseAudioTrack, chooseSubtitleTrack, trackLanguage } from "@/lib/trackPreferences";
import { labelAudioTracks, labelSubtitleTracks } from "@/lib/trackLabel";
import { useWakeLock } from "@/lib/useWakeLock";

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
    recoveryFacts?(): { recoveries: number; frozenNudges: number; escalations: number } | null;
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
 * Jellyfin's stream index for one of the engine's audio tracks, or undefined if it cannot be
 * named with confidence.
 *
 * The two lists describe the same file from two sides: the engine reads Matroska track *numbers*
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
  engineTracks: EngineTrack[],
  jellyfinTracks: DirectPlayInfo["audio"] | undefined,
  trackNumber: number
): number | undefined {
  if (!jellyfinTracks || jellyfinTracks.length !== engineTracks.length) return undefined;
  const ordinal = engineTracks.findIndex((t) => t.number === trackNumber);
  if (ordinal < 0) return undefined;
  return jellyfinTracks[ordinal]?.index;
}

/**
 * Les étiquettes des sous-titres — langue et type, dans la même forme que l'audio.
 *
 * Les pistes externes portent un identifiant négatif (voir `ExternalSubtitle`), ce qui suffit à
 * les reconnaître sans leur ajouter un champ.
 */
function useSubtitleLabels(tracks: EngineTrack[]) {
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
function useAudioLabels(engineTracks: EngineTrack[], jellyfin: DirectPlayInfo["audio"] | undefined, originalLanguage: string | null) {
  const t = useT();
  const { locale } = useLocale();
  return useMemo(() => {
    const apparie = jellyfin && jellyfin.length === engineTracks.length ? jellyfin : null;
    const faits = engineTracks.map((track, i) => ({
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
  }, [engineTracks, jellyfin, originalLanguage, locale, t]);
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
/** Le plus longtemps qu'une image figée reste à l'écran, quoi qu'il arrive. */
const FREEZE_MAX_MS = 4000;

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

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoElRef = useRef<HTMLVideoElement>(null);
  const remuxRef = useRef<RemuxPlayback | null>(null);
  /** Le dernier élément vidéo du pipeline, pour `syncFacts` — voir `reportStop`. */
  const lastVideoElRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const facadeRef = useRef<MediaElementFacade | null>(null);
  // Semée au point de reprise plutôt qu'à zéro : fermer pendant le chargement rapportait sinon
  // un arrêt à 0:00, ce qui effaçait chez Jellyfin la position qu'on venait justement de vouloir
  // reprendre. `?? 0` et non la position du serveur : laisser zéro est ce qui permet au calcul de
  // `startSeconds` plus bas de retomber sur `playbackState`, quand la séance ne portait rien.
  const positionRef = useRef(session.resumeAt ?? 0);
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
   * The record's view of what is playing, read through refs.
   *
   * `fallToStable` must stay stable for the life of the player — a caller passing an inline arrow
   * once turned every render into a rebuilt pipeline — so it cannot close over any of this
   * directly. These are filled in by effects below, once there is something to describe.
   */
  const describeFileRef = useRef<() => Record<string, unknown>>(() => ({}));
  const pathRef = useRef<"remux" | "webcodecs" | null>(null);
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
    reportPlayback("fallback", { ...file, reason, path, ...(handover ? { takeover: handover } : {}) });
    onFallbackRef.current(reason, handover);
  }, []);
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
  const [facade, setFacade] = useState<MediaElementFacade | null>(null);
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
  // Mirrored into state from the engine so the controls' menus can be driven by props, the way
  // they already are for the stable player.
  const [tracks, setTracks] = useState<{ audio: EngineTrack[]; subtitles: EngineTrack[] }>({ audio: [], subtitles: [] });
  const [currentAudio, setCurrentAudio] = useState<number | null>(null);
  /** Le plafond de lumière HDR choisi sur cet appareil — voir `hdrDisplay.ts`. */
  const [hdrCapChoice, setHdrCapChoice] = useState<number | null>(readHdrCapChoice);
  const [currentSubtitle, setCurrentSubtitle] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Record<string, string>>({});
  // Answered once and kept: none of it changes while the page is open.
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
  // The remux path puts a real <video> on screen and is driven through it; only the WebCodecs
  // one paints a canvas and needs the façade in front of it.
  const onElement = path === "remux";
  /**
   * The façade dressed as a ref, kept stable while the façade is.
   *
   * Rebuilt inline it was a fresh object on every render, and the controls key their whole
   * mount-time synchronisation off the identity of this — so that effect ran again for every
   * render of the player, on the one path where the picture is already being painted frame by
   * frame in JavaScript.
   */
  const facadeRefObject = useMemo(
    () => ({ current: facade ? asVideoElement(facade) : null }),
    [facade]
  );
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
  const seekTimingRef = useRef<{ from: number; to: number; startedAt: number; buffered: boolean } | null>(null);
  /**
   * Un saut qui n'arrive pas là où il était demandé n'écrivait rien : la ligne ne part qu'à
   * l'arrivée. 2012 sur iPhone (22/09/2026) : une tête passée de 2141 à 1681 s sans une trace.
   * Il est désormais écrit quand un autre geste le remplace, avec l'endroit où il est tombé.
   */
  const reportUnarrivedSeek = (landedAt: number) => {
    const timing = seekTimingRef.current;
    if (!timing) return;
    seekTimingRef.current = null;
    reportPlayback("seek", {
      ...describeFileRef.current(),
      path: "remux",
      from: Math.round(timing.from),
      to: Math.round(timing.to),
      buffered: timing.buffered,
      arrived: false,
      landedAt: Math.round(landedAt * 10) / 10,
      tookMs: Date.now() - timing.startedAt,
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
  /**
   * L'image figée d'une reconstruction pour changement de piste — voir `freezeFrame`. Sans elle,
   * l'image passait au noir le temps que le nouveau lecteur s'ouvre, puis revenait en fondu :
   * « une impression trop brutale de refresh complet », pour ce qui n'est qu'un changement de son.
   */
  const freezeRef = useRef<HTMLCanvasElement>(null);
  const [frozen, setFrozen] = useState(false);
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
   * refs is ever set. Files beside the film reach both the same way.
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
  const showSubtitleAt = useCallback((seconds: number, fromContainer: () => string | null) => {
    const external = externalSubtitleRef.current;
    setSubtitle(external ? external.textAt(seconds) : fromContainer());
  }, []);

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
    []
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
    () => [...tracks.subtitles, ...(info?.externalSubtitles ?? []).map(externalToEngineTrack)],
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
      // Un nombre, jamais un champ omis : voir `PlaybackSession.resumeAt`. La position suivie sur
      // tous les chemins, et non celle de l'élément : sur le chemin canevas l'élément est une
      // coquille vide qui dit toujours zéro, et juste après une reconstruction il n'a pas encore
      // été posé là où le film en était.
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
    fetch(`/api/jellyfin/playback-state/${itemId}`, { signal: AbortSignal.timeout(8000) })
      .then((response) => (response.ok ? (response.json() as Promise<PlaybackState>) : null))
      .catch(() => null)
      .then((value) => {
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
  /**
   * Reprendre l'affichage, ou le rendre.
   *
   * L'élément n'est jamais caché ni arrêté : il décode, porte le son et mène l'horloge exactement
   * comme avant. Le canevas se pose par-dessus, et se retire dès que le présentateur renonce —
   * l'image en dessous est restée là tout du long, il n'y a jamais de noir à traverser.
   *
   * Dépend de `ready` : avant la première image décodée, il n'y a rien à interroger, et la
   * question « dans quel espace es-tu » n'a pas encore de réponse.
   */
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
  const reportStop = useCallback((why: "close" | "next" | "page" | "unmount") => {
    if (stopReportedRef.current || steppedAside.current) return;
    stopReportedRef.current = true;
    const facts = stopFactsRef.current;
    const watched = watchedRef.current;
    const watchedMs = watched.total + (watched.since !== null ? Date.now() - watched.since : 0);
    reportPlayback("stop", {
      ...describeFileRef.current(),
      path: pathRef.current ?? "non décidé",
      why,
      at: positionRef.current,
      watched: Math.round(watchedMs / 1000),
      ended: facts.ended,
      rebuild: facts.rebuilds,
      ...(facts.audio !== null ? { audio: facts.audio } : {}),
      // Fermé avant la première image : combien de temps le spectateur a attendu avant de renoncer.
      ...(facts.ready ? {} : { gaveUpAfterMs: Date.now() - mountedAtRef.current }),
      ...(facts.error ? { error: facts.error } : {}),
      ...syncFacts(remuxRef.current, videoElRef.current ?? lastVideoElRef.current),
    });
  }, []);
  useEffect(() => {
    const onPageHide = () => reportStop("page");
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      reportStop("unmount");
    };
  }, [reportStop]);

  const stopPlaybackNow = usePlaybackSession(
    useCallback(() => positionRef.current, []),
    // The engine talks to the file directly, so there is no Jellyfin transcode session — but
    // progress still has to be reported, or resume points would stop updating for this player.
    // It announces its own start for the same reason: nothing else tells the server this film is
    // being watched, so without it the reports described a session Jellyfin had never heard of.
    announced
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
    reportStop("close");
    const reported = stopPlaybackNow();
    setClosing(true);
    setTimeout(() => playback.close(), 200);
    // Voir PlayerHost : la fiche et la rangée « Reprendre » sont fausses dès qu'on quitte le film,
    // et les deux lecteurs doivent les relire de la même façon.
    void refreshAfterPlayback(reported, itemId);
  }, [playback, stopPlaybackNow, itemId, reportStop]);

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
    if (!info || playbackState === undefined || !canvasRef.current || !videoElRef.current) return;

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
      audio: EngineTrack[],
      subtitles: EngineTrack[],
      /**
       * « Cette piste joue-t-elle par ce chemin ? », posée par celui qui sait répondre.
       *
       * Fournie par le chemin remultiplexé, absente pour le chemin canevas : celui-ci décode en
       * logiciel et n'a pas les mêmes limites, donc lui prêter les réponses de l'autre serait une
       * supposition. Sans elle, le classement est exactement celui d'avant.
       */
      carriable?: (track: EngineTrack) => boolean
    ): number | null => {
      const preferences = playbackState?.preferences ?? null;
      if (!preferences || wantedAudioRef.current !== null || wantedSubtitleRef.current !== null) return null;

      // La même question que celle posée à l'ouverture, et il faut qu'elle le reste : une piste
      // que ce chemin ne porte pas ne doit pas être « voulue », sinon on ouvre sur l'une et on
      // bascule vers l'autre — ou, pire, on cède la place au lecteur serveur alors qu'une piste
      // de la même langue joue très bien ici. Voir `preferredAudio` et `rank`.
      const wantedAudio = chooseAudioTrack(audio, preferences, carriable);
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
    const announceStart = (chosen: "remux" | "webcodecs", why: string | null) => {
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
        const media = facadeRef.current ?? videoElRef.current;
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
    const startSeconds =
      rebuildAtRef.current ??
      (positionRef.current > 0 ? positionRef.current : session.resumeAt ?? playbackState?.resumeSeconds ?? 0);
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
      const preferred = applyPreferences(playback.audioTracks, playback.subtitleTracks, (track) =>
        playback.canCarryAudio(track.number)
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

      const onTime = () => {
        positionRef.current = element.currentTime;
        showSubtitleAt(element.currentTime, () => playback.subtitleAt(element.currentTime));
      };
      // A warning about not being able to reach a position is obsolete the instant pictures are
      // moving again. Leaving it up made a recovered hiccup look like a lasting fault.
      const onPlay = () => {
        setPlaying(true);
        setEnded(false);
        showWarning(null);
      };
      const onPause = () => setPlaying(false);
      const onEnded = () => {
        setPlaying(false);
        setEnded(true);
      };
      // Le saut demandé est atteint : la position lue redevient la vérité.
      const onSeeked = () => {
        if (requestedSeekRef.current !== null && Math.abs(element.currentTime - requestedSeekRef.current) < 1.5) {
          requestedSeekRef.current = null;
        }
        const timing = seekTimingRef.current;
        if (timing && Math.abs(element.currentTime - timing.to) < 1.5) {
          seekTimingRef.current = null;
          reportPlayback("seek", {
            ...describeFileRef.current(),
            path: "remux",
            from: Math.round(timing.from),
            to: Math.round(timing.to),
            buffered: timing.buffered,
            tookMs: Date.now() - timing.startedAt,
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
      unsubscribes.push(() => {
        element.removeEventListener("timeupdate", onTime);
        element.removeEventListener("play", onPlay);
        element.removeEventListener("pause", onPause);
        element.removeEventListener("ended", onEnded);
        element.removeEventListener("seeked", onSeeked);
      });

      // Reconstruit pour un changement de piste pendant une pause : il reste en pause.
      if (keepPausedRef.current) {
        keepPausedRef.current = false;
        return;
      }
      await element.play().catch(() => {});
    };

    /**
     * Whether this engine ever got as far as playing.
     *
     * The line between a file this device cannot decode — which fails on the way up, and for
     * which retrying is three spinners and the same answer — and a decoder the platform took
     * away mid-film, which is worth rebuilding for.
     */
    let engineStarted = false;

    const startEngine = async (reason: string | null) => {
      // Un changement de piste qui attendait une reconstruction native n'a plus d'objet ici : ce
      // chemin choisit sa piste lui-même, et n'hérite pas du compte rendu. La pause, elle, est
      // gardée — un film à l'arrêt ne repart pas parce qu'il a changé de chemin —, et l'image
      // figée s'efface : ce chemin ne dessine pas sur l'élément qu'elle attendait.
      pendingSwitchRef.current = null;
      const stayPaused = keepPausedRef.current;
      keepPausedRef.current = false;
      setFrozen(false);
      setPathReason(reason);
      // Only now is this refusal real. The native path would have shown this file's HDR without
      // converting anything; it is landing on the canvas that makes tone mapping — and therefore
      // the viewer's consent to it — necessary.
      if (info.canvasHdrRefusal) {
        pathRef.current = "webcodecs";
        setPath("webcodecs");
        fallToStable(info.canvasHdrRefusal);
        return;
      }

      const engine = new PlaybackEngine(canvasRef.current!);
      engineRef.current = engine;
      pathRef.current = "webcodecs";
      setPath("webcodecs");
      announceStart("webcodecs", reason);

      unsubscribes = [
        // The engine distinguishes the two itself, rather than the host guessing from the
        // wording: a warning is degraded playback that continues, an error stops it.
        engine.on("error", (payload) => {
          const message = typeof payload === "string" ? payload : "Lecture interrompue.";
          // Rebuilt rather than given up on, exactly as a lost source is on the other path —
          // the machinery is the same and was simply never wired to this one. But only for a
          // failure that happened *after* the picture was running: a file this device cannot
          // decode fails before it ever starts, and retrying that is three spinners and the same
          // answer. What is worth retrying is a decoder the platform took away mid-film, or a
          // GPU context it reclaimed — neither of which says anything about the file.
          if (engineStarted && spendRebuild()) {
            reportPlayback("rebuild", { ...describeFileRef.current(), reason: message, at: positionRef.current });
            showWarning(tRef.current("player.experimental.resumedAfterInterruption"));
            restart(positionRef.current, `le moteur s'est arrêté (${message})`);
            return;
          }
          fallToStable(message);
        }),
        engine.on("warning", showPipelineWarning),
        // Une image HDR sans conversion tonale est délavée et fausse sur un écran standard, et
        // aucun bandeau ne rattrape ça. Le lecteur du serveur, lui, sait convertir : on lui rend
        // la main plutôt que de laisser regarder un film aux mauvaises couleurs.
        engine.on("hdr-abandoned", (payload) => {
          const reason = typeof payload === "string" ? payload : "conversion HDR indisponible";
          fallToStable(`la conversion HDR est impossible ici (${reason})`);
        }),
        engine.on("timeupdate", () => {
          positionRef.current = engine.currentTime;
          // Ce chemin n'a pas de `seeked` : le saut demandé est atteint quand la lecture y est.
          if (requestedSeekRef.current !== null && Math.abs(engine.currentTime - requestedSeekRef.current) < 1.5) {
            requestedSeekRef.current = null;
          }
          if (externalSubtitleRef.current) showSubtitleAt(engine.currentTime, () => null);
        }),
        engine.on("playing", () => {
          engineStarted = true;
          setPlaying(true);
        }),
        engine.on("pause", () => setPlaying(false)),
        engine.on("ended", () => {
          setPlaying(false);
          setEnded(true);
        }),
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

      await engine.load(info.streamUrl, {
        hdr: info.video?.isHdr ?? false,
        startSeconds,
        // La même question que `applyPreferences` pose juste après, posée avant d'ouvrir : si
        // les deux répondent pareil — et elles lisent les mêmes pistes, par la même règle — il
        // n'y a plus de bascule. Rien quand le spectateur a déjà choisi : c'est son choix qui compte.
        chooseAudioTrack: (tracks) => {
          // Le choix du spectateur d'abord : une reconstruction (moteur arrêté par la plateforme,
          // coupure) rouvrait sur la piste du compte, menu resté sur la sienne. Le chemin
          // remultiplexé le faisait déjà par `audioTrackNumber` (relu le 22/09/2026).
          const wanted = wantedAudioRef.current;
          if (wanted !== null) return tracks.some((track) => track.number === wanted) ? wanted : null;
          const preferences = playbackState?.preferences ?? null;
          if (!preferences) return null;
          return chooseAudioTrack(tracks, preferences)?.number ?? null;
        },
      });
      if (cancelled) return;
      // Les sous-titres du conteneur choisis avant la reconstruction, redonnés au nouveau moteur
      // comme `startRemux` le fait : sans cela le menu les disait choisis et l'écran n'en montrait
      // aucun. Un fichier à côté du film n'a pas besoin de lui — il est affiché ici.
      const keptSubtitle = wantedSubtitleRef.current;
      if (keptSubtitle !== null && !isExternalTrack(keptSubtitle)) engine.setSubtitleTrack(keptSubtitle);

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
      if (!stayPaused) await engine.play().catch(() => {});
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
        // Le chemin retenu, nommé ici plutôt que dans chaque branche.
        //
        // Deux branches sur trois le faisaient, et pas celle du remultiplexage — c'est-à-dire pas
        // le chemin normal. Le rapport technique affichait donc « non encore décidé » quand tout
        // allait bien, et ne se remplissait que lorsque la lecture se dégradait : exactement
        // l'inverse de ce qu'on attend d'un rapport, et de quoi faire croire à une panne du
        // lecteur natif alors qu'il jouait le film. Posé au point de branchement, il ne peut plus
        // manquer à une branche qu'on ajouterait plus tard.
        // Reconstruit pour une piste que le lecteur natif n'a finalement pas pu ouvrir — module
        // TrueHD injoignable, encodeur qui refuse : le canevas ou le lecteur serveur coûteraient
        // un film qui jouait très bien, pour un choix de langue. On revient à la piste d'avant.
        if (probe.path !== "remux" && revertFailedSwitch(`chemin ${probe.path}`)) {
          probe.discard();
          return;
        }
        if (probe.path === "remux") {
          setPathReason(describePath(probe.chosen));
          return startRemux(element, probe.start);
        }
        // Le moteur nomme déjà le sien : il reçoit le motif en argument. (Il y avait un troisième
        // chemin, la lecture directe d'un MP4 ; tout fichier passe désormais par le traitement —
        // voir remuxPlayback.ts.)
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
        if (revertFailedSwitch(message)) return;
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
  // `reportAudioSwitch` est un `useCallback` à dépendances vides : son identité ne change jamais,
  // donc l'ajouter ici ne peut pas relancer la construction du pipeline. C'est la seule raison
  // pour laquelle il peut y figurer — voir la note sur les rappels lus à travers une `ref`. Même
  // chose pour `showPipelineWarning`, qui ne dépend que de `showWarning`, stable lui aussi.
  }, [info, infoError, playbackState, fallToStable, restart, session.resumeAt, rebuildCount, showSubtitleAt, showWarning, showPipelineWarning, chooseSubtitle, spendRebuild, reportAudioSwitch]);

  // Watches for the platform having taken the source away while the page was not on screen. The
  // check runs on returning to the foreground, and once more a moment later: on iOS the closure
  // is not always visible in the same task as the visibility change.
  useEffect(() => {
    if (path !== "remux") return;
    const check = () => {
      const playback = remuxRef.current;
      if (!playback?.lost || rebuildAtRef.current !== null) return;
      if (!spendRebuild()) return;
      restart(playback.position || positionRef.current, "la plateforme a fermé la source");
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      check();
      setTimeout(check, 400);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [path, restart, spendRebuild]);

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
        transition: resizing
          ? "opacity 220ms ease-out, transform 220ms cubic-bezier(0.32, 0.72, 0, 1)"
          : `${TRANSITION}, opacity 220ms ease-out, transform 220ms cubic-bezier(0.32, 0.72, 0, 1)`,
        opacity: revealed && !closing ? 1 : 0,
        // Une échelle très légère : assez pour que l'œil suive le passage d'un écran à l'autre,
        // pas assez pour que ça ressemble à un effet.
        transform: revealed && !closing ? "scale(1)" : "scale(0.985)",
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
      {/* Fondu depuis le noir sur la première image. La toute première frame d'une MediaSource
          arrive rarement seule et proprement — il y a un battement entre l'élément qui se
          déclare prêt et l'image qui s'installe. Trois cents millisecondes de fondu couvrent
          ce battement et, surtout, donnent une intention à ce qui ressemblait à un à-coup. */}
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
      <canvas
        ref={canvasRef}
        hidden={onElement}
        className={`${isMini ? "h-full w-full object-cover" : "h-full w-full object-contain"} transition-opacity duration-300 ease-out ${
          ready ? "opacity-100" : "opacity-0"
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
            // Le moteur canevas quand c'est lui qui joue : l'élément vidéo n'y est qu'une coquille
            // sans source, et « Revoir » ne faisait qu'effacer l'écran de fin (relu le 22/09/2026).
            const media = facadeRef.current ?? videoElRef.current;
            if (media) {
              media.currentTime = 0;
              void media.play().catch(() => {});
            }
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
        // Gardées pendant une reconstruction pour changement de piste (`frozen`), le temps de
        // s'estomper puis de revenir : elles disparaissaient d'un coup et réapparaissaient d'un
        // coup, ce qui ajoutait à l'effet « sec » du changement (22/09/2026).
        (ready || frozen) &&
        (facade || onElement) &&
        !error && (
          <div
            className={`absolute inset-0 z-10 transition-opacity duration-200 ease-out ${
              ready ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
            // Hors d'atteinte tant qu'elles s'effacent : ni toucher, ni focus.
            inert={!ready}
          >
          <PlayerControls
            // On the remux path this is a real media element, so seeking, volume and rate are the
            // browser's own; the facade exists only to give the canvas pipeline the same shape.
            videoRef={onElement ? videoElRef : facadeRefObject}
            onSeekRequest={(seconds) => {
              requestedSeekRef.current = seconds;
              // Mesuré jusqu'à l'arrivée (`seeked`). Un saut qui en remplace un autre en cours
              // remplace aussi sa mesure : c'est le dernier geste qui compte.
              const element = videoElRef.current;
              let buffered = false;
              for (let i = 0; element && i < element.buffered.length; i++) {
                if (element.buffered.start(i) <= seconds && seconds < element.buffered.end(i)) buffered = true;
              }
              reportUnarrivedSeek(element?.currentTime ?? positionRef.current);
              seekTimingRef.current = { from: positionRef.current, to: seconds, startedAt: Date.now(), buffered };
              // Une reconstruction pas encore ouverte rouvre directement là.
              if (rebuildAtRef.current !== null) rebuildAtRef.current = seconds;
            }}
            containerRef={containerRef}
            itemId={itemId}
            title={title}
            onClose={handleClose}
            onMinimize={() => playback.minimize()}
            // Straight from the container the engine is reading, not from Jellyfin's view of the
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
            onChangeAudio={(id) => {
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
              setCurrentAudio(id);
              // Retenu comme sur l'autre chemin, pour qu'une reconstruction rouvre sur elle.
              wantedAudioRef.current = id;
              void engineRef.current?.setAudioTrack(id).catch(() => {});
            }}
            subtitleTracks={subtitleChoices.map((track) => ({
              id: track.number,
              label: subtitleLabels.get(track.number) ?? String(track.number),
            }))}
            currentSubtitleId={currentSubtitle}
            onChangeSubtitle={(id) => chooseSubtitle(id, info?.externalSubtitles ?? [])}
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
            suspended={!ready}
            hdrCap={
              path === "remux" && info?.video?.rangeType && info.video.rangeType !== "SDR"
                ? {
                    current: hdrCapChoice,
                    onPick: (nits) => {
                      writeHdrCapChoice(nits);
                      setHdrCapChoice(nits);
                      // Le plafond est écrit dans l'en-tête du flux : il faut le reconstruire,
                      // à la même position, comme pour un changement de piste.
                      restart(intendedPosition(), `plafond HDR ${nits ?? "natif"}`);
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
