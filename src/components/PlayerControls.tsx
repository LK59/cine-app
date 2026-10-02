"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject, type SyntheticEvent } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, X, Captions, AudioLines, Cast, MonitorSmartphone, Loader2, PictureInPicture2, Info, RotateCcw, RotateCw, Gauge, ListVideo, EllipsisVertical, ArrowLeft, Sun, Scan, Moon, Timer, ChevronRight } from "lucide-react";
import { HDR_CAP_CHOICES, type HdrCapChoice } from "@/lib/webcodecs/hdrDisplay";
import { useT } from "@/components/TranslationProvider";
import { noteAutoAdvance, noteViewerPresent, autoAdvanceStore, STILL_THERE_AFTER } from "@/lib/autoAdvance";
import {
  subtitleStyleStore,
  cueCss,
  SUBTITLE_SIZES,
  SUBTITLE_COLORS,
  SUBTITLE_BACKGROUNDS,
} from "@/lib/subtitleStyle";
import { useMediaSession } from "@/lib/useMediaSession";
import { VOLUME_STORAGE_KEY } from "@/lib/rememberedVolume";
import {
  SLEEP_DURATIONS,
  sleepBlocksAdvanceSnapshot,
  sleepFading,
  sleepFalseServerSnapshot,
  sleepMinutesSnapshot,
  sleepModeSnapshot,
  sleepNullServerSnapshot,
  sleepServerSnapshot,
  sleepTimerStore,
  sleepWarningSnapshot,
  type SleepMode,
} from "@/lib/sleepTimer";

export interface Track {
  id: number;
  label: string;
}

// AirPlay (Safari, webkit-prefixed) isn't in lib.dom's HTMLVideoElement typings — unlike the
// standard Remote Playback API (Chrome/Edge's actual Chromecast entry point for a plain
// <video>), which `video.remote` already covers natively.
interface CastVideoElement extends HTMLVideoElement {
  webkitShowPlaybackTargetPicker?: () => void;
}

interface PlayerControlsProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  itemId: string;
  title: string;
  onClose: () => void;
  onMinimize: () => void;
  onTogglePlaybackInfo: () => void;
  /**
   * Ce que « Diffuser » veut dire ici, quand le sélecteur ne peut pas s'ouvrir directement.
   *
   * Le lecteur natif alimente son élément vidéo par MediaSource, et **rien ne diffuse un
   * MediaSource** : ni AirPlay ni l'API Remote Playback n'acceptent autre chose qu'une adresse
   * que le récepteur ira chercher lui-même. Le sélecteur s'ouvrirait donc pour aboutir à un écran
   * noir sur le téléviseur.
   *
   * Quand cette fonction est fournie, le bouton la prend au lieu d'ouvrir le sélecteur : c'est au
   * lecteur de se faire remplacer par celui qui, lui, joue une adresse. Absente — le cas du
   * lecteur serveur — le sélecteur s'ouvre comme avant, à l'identique.
   */
  onCastRequest?: () => void;
  /**
   * La sortie, quand cette séance n'existe que pour diffuser.
   *
   * Sans elle, un spectateur qui ouvre le sélecteur puis choisit « iPhone » — donc n'a rien
   * diffusé du tout — reste sur le lecteur serveur jusqu'à la fin du film. La bascule a bien eu
   * lieu, elle était nécessaire pour ouvrir le sélecteur, mais rien ne l'a jamais annulée : l'état
   * sans-fil n'est jamais passé à vrai, donc il ne repasse jamais à faux, donc rien ne se
   * déclenche. C'est un retour qui ne dépend d'aucun événement, et c'est pour ça qu'il existe.
   */
  onCastReturn?: () => void;
  /** Quelque chose diffuse-t-il vraiment ? Ne change que le mot, jamais le geste. */
  castActive?: boolean;
  audioTracks: Track[];
  currentAudioId: number | null;
  onChangeAudio: (id: number) => void;
  subtitleTracks: Track[];
  currentSubtitleId: number | null;
  onChangeSubtitle: (id: number | null) => void;
  /**
   * Le décalage des sous-titres, quand c'est l'hôte qui les dessine.
   *
   * Sans lui, le réglage déplace les lignes du `<video>` — ce que le lecteur serveur affiche. Le
   * lecteur natif dessine les siennes lui-même, sous l'image : les boutons ±0,5 s y déplaçaient
   * des lignes que personne n'affichait, et le chiffre bougeait sans que rien d'autre ne bouge
   * (relevé le 23/09/2026).
   */
  subtitleOffset?: { seconds: number; onShift: (deltaSeconds: number) => void };
  hidden: boolean;
  loading: boolean;
  introSkip: { start: number; end: number } | null;
  creditsStart: number | null;
  nextEpisode: { itemId: string; title: string } | null;
  onAdvance: () => void;
  /**
   * Chaque saut demandé par le spectateur, à la position visée — avant que l'élément ne l'ait
   * atteinte. Un lecteur qui se reconstruit (changement de piste) part de là plutôt que de la
   * dernière position lue : sinon un saut encore en chargement suivi d'un changement de piste
   * ramenait le film là où il était avant le saut (22/09/2026).
   */
  onSeekRequest?: (seconds: number) => void;
  /**
   * Visibles mais en train de s'effacer, pendant qu'un lecteur se reconstruit : elles ne répondent
   * plus au clavier, dont l'écouteur est posé sur la fenêtre. Une barre d'espace à ce moment-là
   * relançait un film que la reconstruction devait garder en pause.
   */
  suspended?: boolean;
  /**
   * Le plafond de lumière HDR de cet appareil (`null` : natif), proposé seulement pour un film HDR.
   * Un choix pour comparer à l'œil sur un écran qui n'affiche pas le HDR — voir `hdrDisplay.ts`.
   * Il s'applique en reconstruisant le lecteur, comme un changement de piste.
   */
  hdrCap?: { current: HdrCapChoice; autoNits: number | null; onPick: (choice: HdrCapChoice) => void };
  /**
   * L'ajustement de l'image aux bandes noires du fichier (`frameFit.ts`), quand il y en a un à
   * défaire sur cet écran. Absent, rien n'est proposé : un film sans bandes n'a pas d'interrupteur.
   */
  frameFit?: { on: boolean; onChange: (on: boolean) => void };
}

const NEXT_UP_COUNTDOWN_S = 10;
/** Combien de temps la confirmation de diffusion reste dépliée sans qu'on y touche. */
const CAST_CONFIRM_MS = 4000;
/**
 * Où se posent les invites flottantes (« Passer l'intro », l'épisode suivant, la minuterie) : au-dessus
 * du bas des commandes — titre, pilule et barre —, pour ne jamais les couvrir quand elles sont là.
 */
const PROMPT_BOTTOM = "calc(max(1rem, env(safe-area-inset-bottom)) + 8.5rem)";
const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** Masqués, les contrôles ne suivent la position qu'à ce rythme — voir `visibleRef`. */
const HIDDEN_UPDATE_MS = 1000;

/** How long a seek may take before it is worth showing as a wait rather than as a still button. */
const SEEK_SPINNER_MS = 150;
/**
 * La fenêtre, après un doigt levé, pendant laquelle un événement souris n'en est que l'écho.
 * Les navigateurs rejouent la souris dans la foulée du touchend ; 800 ms laissent la marge d'un
 * téléphone chargé sans jamais avaler un vrai clic, qu'une souris ne donne pas une demi-seconde
 * après un doigt.
 */
const TOUCH_ECHO_MS = 800;
/** En dessous, un déplacement du doigt est son tremblement, pas un geste — voir `lastTouchXRef`. */
const TOUCH_JITTER_PX = 1;

/**
 * La flèche de ±10 s, avec son « 10 » dedans — dessinée en vecteurs, nette à toute taille : sans le
 * chiffre, rien ne disait de combien la flèche déplaçait le film.
 */
function SkipGlyph({ direction }: { direction: "back" | "forward" }) {
  const Arrow = direction === "back" ? RotateCcw : RotateCw;
  // À la taille du bouton : 26 px dans un bouton de 48, 30 dans un de 56 — le chiffre suit, ≈ 10 puis
  // 12 px. Fixé à 22 px, il ne faisait que 8 px au bureau, à peine lisible (02/10/2026).
  return (
    <span className="relative block h-[26px] w-[26px] sm:h-[30px] sm:w-[30px]">
      <Arrow size="100%" aria-hidden className="absolute inset-0" />
      {/* Centré sur le cercle de la flèche (12, 12 sur 24) ; la ligne de base un tiers de corps plus bas. */}
      <svg viewBox="0 0 24 24" aria-hidden className="absolute inset-0 h-full w-full">
        <text x="12" y="15.3" textAnchor="middle" fontSize="9.6" fontWeight="700" fill="currentColor" fontFamily="inherit" letterSpacing="-0.3">
          10
        </text>
      </svg>
    </span>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function PlayerControls({
  videoRef,
  containerRef,
  itemId,
  title,
  onClose,
  onMinimize,
  onTogglePlaybackInfo,
  audioTracks,
  currentAudioId,
  onChangeAudio,
  subtitleTracks,
  currentSubtitleId,
  onChangeSubtitle,
  subtitleOffset: hostSubtitleOffset,
  hidden,
  loading,
  introSkip,
  creditsStart,
  nextEpisode,
  onAdvance,
  onCastRequest,
  onCastReturn,
  castActive,
  onSeekRequest,
  suspended = false,
  hdrCap,
  frameFit,
}: PlayerControlsProps) {
  const t = useT();
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  /** Pending "this seek is taking long enough to say so". */
  const seekSpinner = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The element whose volume has already been probed, so it is probed once and not per render. */
  const probedVolumeOn = useRef<HTMLVideoElement | null>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  /**
   * Whether this platform lets a page set the volume at all.
   *
   * iOS does not: `volume` on a media element is read-only there, silently, and the hardware
   * buttons are the only control. So the slider did nothing except through the one line that
   * *did* work — muting at zero — which is exactly what it looked like from the outside: a bar
   * that turned the sound off and on and had no middle.
   */
  const [volumeSettable, setVolumeSettable] = useState(true);

  /**
   * Whether this platform will let a page set the volume of a media element.
   *
   * Asked of the platform's name, which is not how anything else here is decided — and the
   * exception is earned. Trying it and reading it back, which is what this did, cannot work:
   * iOS *stores* the value written to `video.volume` and hands it back unchanged, while the
   * output ignores it entirely. The probe therefore answered "yes" every time, the control
   * stayed on screen, and it behaved as a mute switch with nothing in between — which is what
   * was reported, twice. A measurement whose subject lies is not a measurement.
   *
   * Narrow on purpose: only Apple's mobile systems, where the write is ignored — the control stays
   * where it works and goes where it does not.
   */
  const probeVolume = useCallback((video: HTMLVideoElement) => {
    if (probedVolumeOn.current === video) return;
    probedVolumeOn.current = video;

    const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const iPadPretendingToBeAMac =
      typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    const readOnlyThere = /iPad|iPhone|iPod/.test(agent) || iPadPretendingToBeAMac;
    if (readOnlyThere && video instanceof HTMLMediaElement) {
      setVolumeSettable(false);
      return;
    }

    // Everywhere else the question can still be answered by asking, and is: a platform nobody
    // thought of that ignores the write takes the control off the screen too.
    const before = video.volume;
    try {
      video.volume = before > 0.5 ? before - 0.1 : before + 0.1;
      const took = video.volume !== before;
      video.volume = before;
      setVolumeSettable(took);
    } catch {
      setVolumeSettable(false);
    }
  }, []);
  const [muted, setMuted] = useState(false);
  const [visible, setVisible] = useState(true);
  /**
   * Masqués, les contrôles ne prennent la position qu'une fois par seconde (28/09/2026). Chaque
   * `timeupdate` (~4 par seconde) faisait recalculer tout ce composant, même invisible — du travail
   * pour rien, et de quoi réveiller l'affichage. Une seconde suffit à ce qui en dépend quand rien
   * n'est affiché (« Passer l'intro », le compte à rebours de l'épisode suivant) ; affichés, le
   * `timeupdate` suivant les remet à la seconde près.
   */
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);
  const [menu, setMenu] = useState<null | "audio" | "subtitles" | "speed" | "chapters" | "subtitleStyle" | "hdrCap" | "sleep" | "more">(null);
  /** « Auto · 203 nits », « Natif », « 400 nits » — le réglage de luminosité HDR, en mots. */
  const hdrCapLabel = (choice: HdrCapChoice): string =>
    choice === "auto"
      ? `${t("player.hdrCap.auto")}${hdrCap?.autoNits ? ` · ${hdrCap.autoNits} nits` : ` · ${t("player.hdrCap.native")}`}`
      : choice === "native"
        ? t("player.hdrCap.native")
        : `${choice} nits`;
  const menuRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [castSupported, setCastSupported] = useState(false);
  /** AirPlay (WebKit) ou Remote Playback : ne change que le mot de la confirmation. */
  const [castKind, setCastKind] = useState<"airplay" | "remote">("remote");
  /**
   * La pilule de diffusion dépliée en « Passer sur AirPlay · Confirmer » — lecteur natif seulement.
   *
   * Passer sur AirPlay quitte le lecteur natif pour le lecteur serveur : un geste qui coûte une
   * nouvelle ouverture, et le bouton est voisin de celui du mini-lecteur, sous le même pouce. Le
   * premier appui demande, le second fait. Le lecteur serveur, lui, ouvre le sélecteur du système
   * au premier appui : il n'y a rien à quitter.
   */
  const [castConfirm, setCastConfirm] = useState(false);
  const castPillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!castConfirm) return;
    // Repliée d'elle-même au bout de quatre secondes, ou par un appui ailleurs.
    const timer = setTimeout(() => setCastConfirm(false), CAST_CONFIRM_MS);
    const onPointerDown = (e: PointerEvent) => {
      if (!castPillRef.current?.contains(e.target as Node)) setCastConfirm(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [castConfirm]);
  const [speed, setSpeed] = useState(1);
  const [chapters, setChapters] = useState<{ start: number; name: string | null }[]>([]);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  // Préférence générale, gardée d'une session à l'autre comme le volume : une taille de
  // sous-titres dont on a besoin ne dépend pas du film. Elle vit dans un magasin partagé, parce
  // que l'autre lecteur dessine ses lignes lui-même et doit obéir aux mêmes réglages — voir
  // `subtitleStyle`.
  const subtitleStyle = useSyncExternalStore(
    subtitleStyleStore.subscribe,
    subtitleStyleStore.snapshot,
    subtitleStyleStore.serverSnapshot
  );
  // Deliberately NOT persisted, and reset per item (below) rather than per session: a
  // desync is a property of one specific file's subtitle track, meaningless carried over to a
  // different file that likely isn't desynced at all.
  //
  // Un décalage par piste : il est appliqué aux lignes de cette piste-là, et changer de piste
  // affichait encore celui de la précédente sur des lignes qui n'avaient pas bougé.
  const [cueOffsets, setCueOffsets] = useState<Record<number, number>>({});
  const [resetOffsetForItemId, setResetOffsetForItemId] = useState(itemId);
  if (itemId !== resetOffsetForItemId) {
    setResetOffsetForItemId(itemId);
    setCueOffsets({});
  }
  const subtitleOffset =
    hostSubtitleOffset?.seconds ?? (currentSubtitleId === null ? 0 : (cueOffsets[currentSubtitleId] ?? 0));
  const [nextUpDismissed, setNextUpDismissed] = useState(false);
  const [nextUpCountdown, setNextUpCountdown] = useState(NEXT_UP_COUNTDOWN_S);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while a pointer/touch is actively down on the seek bar. Read (not state — nothing
  // needs to re-render off it directly) by the 'timeupdate' handler to stop the real playback
  // position from fighting the dragged one, and by the two hide-suppression handlers below.
  const seekingRef = useRef(false);
  /**
   * Un glisser à la souris est en cours : la position vient du curseur, jamais de l'input.
   *
   * L'input natif ramène le pixel à une valeur en retirant la demi-pastille à chaque bout ; la
   * vignette, elle, compte sur toute la largeur. Les deux disaient deux temps différents pour
   * le même pixel, et c'est celui de l'input qu'on validait : « je vise 6:54, il me met à
   * 6:48 », systématiquement, sur Chrome et Firefox.
   */
  const mouseDragRef = useRef(false);
  /**
   * Un doigt glisse sur la barre : même règle que la souris, la position vient du doigt.
   *
   * Sur iOS, un doigt posé sur la pastille (invisible, mais toujours là) fait aussi glisser
   * l'input natif — en relatif, depuis la pastille et non depuis le doigt. Les deux écrivaient
   * tour à tour une position différente, et chaque rendu remettait la valeur de l'input, ce qui
   * relançait son propre glisser : la barre et la vignette sautaient, saccadaient et tremblaient
   * sous un doigt immobile (signalé sur iPhone le 23/09/2026).
   */
  const touchDragRef = useRef(false);
  /** Le dernier point du doigt pris en compte — voir `TOUCH_JITTER_PX`. */
  const lastTouchXRef = useRef<number | null>(null);
  /**
   * L'instant du dernier doigt levé de la barre — pour reconnaître la souris que le navigateur
   * rejoue ensuite.
   *
   * Après un touchend sans preventDefault, le navigateur envoie au même point mousemove,
   * mousedown puis mouseup « de compatibilité ». Le conteneur avait déjà validé le saut au
   * touchend, et l'onMouseUp de l'input le validait une seconde fois : deux demandes de saut,
   * currentTime écrit deux fois — le premier saut recommencé — et une ligne « superseded »
   * fantôme dans le journal. Pas de preventDefault au touchend : il supprimerait aussi le clic
   * que le reste de la barre du bas écoute (voir son onClickCapture).
   */
  const lastTouchEndRef = useRef(-Infinity);
  /** Les événements souris qui suivent un toucher de près ne sont que son écho. */
  const isTouchEcho = () => performance.now() - lastTouchEndRef.current < TOUCH_ECHO_MS;

  // Reset the dismiss/countdown state whenever a genuinely new "next episode" context arrives
  // (i.e. we've actually advanced), not on every render. Applied during render (not in an
  // effect) per React's guidance for adjusting state from a prop change.
  const nextUpKey = `${creditsStart ?? ""}:${nextEpisode?.itemId ?? ""}`;
  const [resetForNextUpKey, setResetForNextUpKey] = useState(nextUpKey);
  if (nextUpKey !== resetForNextUpKey) {
    setResetForNextUpKey(nextUpKey);
    setNextUpDismissed(false);
    setNextUpCountdown(NEXT_UP_COUNTDOWN_S);
  }

  /**
   * Quand proposer l'épisode suivant : au générique de fin, ou à la toute fin faute de générique.
   *
   * Sans repère de générique, la carte ne venait jamais — et l'écran de fin, réservé aux films, non
   * plus : l'épisode s'arrêtait sur sa dernière image sans rien proposer (23/09/2026, quand les
   * repères ont manqué à tous les épisodes). La dernière seconde tient lieu de générique.
   */
  const atEnd = duration > 0 && currentTime >= duration - 1;
  const nextUpFrom = creditsStart ?? (duration > 0 ? duration - 1 : null);
  /**
   * La minuterie de veille — voir `sleepTimer.ts`. Lue ici pour trois choses : son entrée du menu,
   * la ligne des trente dernières secondes, et « Fin de l'épisode », qui retire la carte de
   * l'épisode suivant et donc son décompte : l'épisode finit, et rien ne s'enchaîne. Le décompte
   * lui-même et la pause appartiennent à l'hôte (`useSleepTimer`), qui tourne aussi en mini-lecteur.
   */
  const sleepMode = useSyncExternalStore(sleepTimerStore.subscribe, sleepModeSnapshot, sleepServerSnapshot);
  const sleepMinutes = useSyncExternalStore(sleepTimerStore.subscribe, sleepMinutesSnapshot, sleepNullServerSnapshot);
  const sleepWarning = useSyncExternalStore(sleepTimerStore.subscribe, sleepWarningSnapshot, sleepNullServerSnapshot);
  const sleepBlocksAdvance = useSyncExternalStore(sleepTimerStore.subscribe, sleepBlocksAdvanceSnapshot, sleepFalseServerSnapshot);
  const sleepLabel = (mode: SleepMode): string =>
    mode === "off" ? t("player.sleep.off") : mode === "episode" ? t("player.sleep.episode") : t("player.sleep.minutes", { n: Number(mode) });
  const showNextUp =
    nextUpFrom != null && currentTime >= nextUpFrom && !!nextEpisode && !nextUpDismissed && !sleepBlocksAdvance;

  // Le décompte repart de zéro quand la carte s'en va — un retour en arrière avant le générique —,
  // sans quoi il reprenait là où il en était, à trois secondes au lieu de dix.
  const [nextUpWasShown, setNextUpWasShown] = useState(showNextUp);
  if (showNextUp !== nextUpWasShown) {
    setNextUpWasShown(showNextUp);
    if (!showNextUp) setNextUpCountdown(NEXT_UP_COUNTDOWN_S);
  }

  // Le décompte ne court que pendant la lecture — ou une fois l'épisode fini, où l'élément est
  // arrêté. Mettre en pause pendant le générique passait sinon à l'épisode suivant dix secondes
  // plus tard.
  const nextUpRunning = showNextUp && (playing || atEnd);
  useEffect(() => {
    if (!nextUpRunning) return;
    const id = setInterval(() => setNextUpCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [nextUpRunning]);

  /**
   * L'écran « vous êtes toujours là ? ».
   *
   * Au bout de trois épisodes enchaînés sans un geste, le décompte arrive à zéro et on ne passe
   * pas à la suite : on demande. Le compteur vit hors du composant — voir `autoAdvance` — parce
   * que celui-ci est remonté à chaque épisode.
   */
  const autoAdvances = useSyncExternalStore(
    autoAdvanceStore.subscribe,
    autoAdvanceStore.snapshot,
    autoAdvanceStore.serverSnapshot
  );
  // Déduit du rendu et non posé dans un effet : l'écran à afficher est une conséquence du
  // décompte et du compteur, pas un état de plus à tenir à jour à côté d'eux.
  const askStillThere = showNextUp && nextUpCountdown === 0 && autoAdvances >= STILL_THERE_AFTER;
  useEffect(() => {
    if (!showNextUp || nextUpCountdown !== 0 || askStillThere) return;
    noteAutoAdvance();
    onAdvance();
  }, [showNextUp, nextUpCountdown, askStillThere, onAdvance]);

  const showSkipIntro = !!introSkip && currentTime >= introSkip.start && currentTime < introSkip.end;

  // `document` is unavailable during SSR — feature detection must run post-mount. State starts
  // at the fixed `false`, matching SSR output, so this doesn't cause a hydration mismatch.
  useEffect(() => {
    // iPhone Safari doesn't support the standard Fullscreen API on arbitrary
    // elements (only iPad/desktop do) — feature-detect rather than show a
    // button that silently does nothing there. The player already fills the
    // whole viewport as a fixed overlay, and in an installed PWA (no browser
    // chrome to hide) that's effectively fullscreen already.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFullscreenSupported(typeof document !== "undefined" && document.fullscreenEnabled);
  }, []);

  // This component remounts every time the player switches between full and mini (only
  // rendered while !isMini in PlayerHost), but the underlying <video> never does — so on
  // remount it can already be mid-playback. Syncing from its actual state here, before paint,
  // avoids a stale "paused" (or 0:00 / 1x volume) flash until the next play/timeupdate/etc.
  // event happens to fire on its own.
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setPlaying(!video.paused);
    setCurrentTime(video.currentTime);
    setDuration(video.duration || 0);
    setVolume(video.volume);
    setMuted(video.muted);
    setSpeed(video.playbackRate || 1);

    probeVolume(video);
  }, [videoRef, probeVolume]);

  // Chapters — fetched once per item, same shape/lifecycle as the trickplay metadata below.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jellyfin/chapters?itemId=${itemId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!cancelled) setChapters(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setChapters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      // La position exacte à l'arrêt, que le rythme des contrôles masqués ait laissé passer la
      // dernière ou non — voir `onTime`. Pas pendant qu'on tire la barre : c'est elle qui dit l'instant.
      if (!seekingRef.current) setCurrentTime(video.currentTime);
      // And anything already on its way is called off: the pause may well arrive first.
      if (seekSpinner.current) clearTimeout(seekSpinner.current);
      seekSpinner.current = null;
      setBuffering(false);
    };
    // Suppressed while dragging the seek bar — otherwise the real (not-yet-seeked) playback
    // position keeps overwriting the dragged thumb position on every tick, fighting the user's
    // own drag mid-gesture.
    let timeAt = 0;
    const onTime = () => {
      if (seekingRef.current) return;
      const now = performance.now();
      // Jamais la dernière : à l'arrêt ou à la fin, aucune autre ne viendra. La fin de fichier
      // tombait à moins d'une seconde de la précédente, était sautée, et l'écran de fin (« Revoir »,
      // l'épisode suivant — `atEnd`) n'apparaissait pas contrôles masqués (chasse aux défauts du 28/09).
      if (!visibleRef.current && now - timeAt < HIDDEN_UPDATE_MS && !video.paused && !video.ended) return;
      timeAt = now;
      setCurrentTime(video.currentTime);
    };
    const onDuration = () => {
      setDuration(video.duration || 0);
      probeVolume(video);
    };
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
      // Gardé d'une séance à l'autre, et rendu à l'élément par les deux lecteurs à son montage
      // (`restoreRememberedVolume`). Seul le lecteur serveur le relisait : dans le lecteur natif,
      // chaque film repartait à plein volume. DECISIONS.md §35.
      // Pas pendant la descente du son de la minuterie de veille : retenu, ce volume presque nul
      // aurait ouvert le film du lendemain en silence.
      if (sleepFading()) return;
      try {
        localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ volume: video.volume, muted: video.muted }));
      } catch {
        // Storage unavailable — just doesn't persist this time.
      }
    };
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => {
      if (seekSpinner.current) clearTimeout(seekSpinner.current);
      seekSpinner.current = null;
      setBuffering(false);
    };

    /**
     * A seek is a wait like any other, and it did not look like one.
     *
     * The pause button stayed where it was while the player went and fetched the position, which
     * reads as a freeze rather than as work in progress — and on a dense file that fetch is
     * seconds long. `waiting` is not reliable here: the element can report itself able to play
     * the instant the seek is issued and only stall afterwards.
     *
     * Delayed, because most seeks land in media the player already holds and finish within a
     * frame. A spinner that appears and goes before it can be seen is noise.
     */
    const onSeeking = () => {
      if (seekSpinner.current) clearTimeout(seekSpinner.current);
      // Never while paused. Pausing *is* a seek here — the position is re-stated at the button
      // to flush the sound iOS still holds queued (see PlaybackGuard.paused) — so pressing pause
      // announced itself as work: the three centre buttons vanished and the loading thread ran,
      // as though stopping the film needed fetching. A paused player is not working, whatever
      // the element is doing about its own clock.
      if (video.paused) return;
      seekSpinner.current = setTimeout(() => {
        seekSpinner.current = null;
        if (video.seeking && !video.paused) setBuffering(true);
      }, SEEK_SPINNER_MS);
    };
    const onSeeked = () => {
      onPlaying();
      if (!seekingRef.current) setCurrentTime(video.currentTime);
    };
    const onEnded = () => setCurrentTime(video.currentTime);
    const onRateChange = () => setSpeed(video.playbackRate || 1);
    // The range containing currentTime (not just the last one) — a rewind past hls.js's
    // in-memory buffer can leave an earlier, already-downloaded range that's no longer the
    // last entry in video.buffered once new data has since loaded ahead of the original spot.
    let progressAt = 0;
    const onProgress = () => {
      // La jauge de ce qui est chargé ne se voit pas non plus quand les contrôles sont masqués.
      const now = performance.now();
      if (!visibleRef.current && now - progressAt < HIDDEN_UPDATE_MS) return;
      progressAt = now;
      const ranges = video.buffered;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= video.currentTime && video.currentTime <= ranges.end(i)) {
          setBufferedEnd(ranges.end(i));
          return;
        }
      }
      setBufferedEnd(ranges.length > 0 ? ranges.end(ranges.length - 1) : 0);
    };
    // 'canplay' also clears buffering: when autoplay is blocked (iOS after the reload-based
    // track switch — no user activation on the fresh page), 'playing' never fires without a
    // tap, and a spinner that only 'playing' can dismiss would sit over a ready, paused video
    // forever. canplay is the "enough data to play" signal, which is exactly what buffering
    // is meant to track.
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onDuration);
    video.addEventListener("durationchange", onDuration);
    video.addEventListener("volumechange", onVolume);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("canplay", onPlaying);
    video.addEventListener("ratechange", onRateChange);
    video.addEventListener("progress", onProgress);
    video.addEventListener("ended", onEnded);
    onProgress(); // seed immediately — otherwise the bar stays empty until the next chunk lands

    // Cast — AirPlay (Safari, webkit-prefixed) where available, else the standard Remote
    // Playback API (Chrome/Edge's real Chromecast entry point for a <video>). Never both: a
    // browser that has AirPlay is Safari, which doesn't meaningfully implement Remote Playback,
    // so checking AirPlay first and only falling back avoids ever probing the one that doesn't
    // apply.
    const castVideo = video as CastVideoElement;
    let remoteWatchId: number | undefined;
    // La promesse d'abonnement peut se résoudre après le démontage : l'identifiant arrivait alors
    // trop tard pour être annulé, et l'abonnement survivait au lecteur (23/09/2026).
    let unmounted = false;
    if (typeof castVideo.webkitShowPlaybackTargetPicker === "function") {
      setCastSupported(true);
      setCastKind("airplay");
    } else if (castVideo.remote) {
      const remote = castVideo.remote;
      remote
        .watchAvailability((available) => {
          if (!unmounted) setCastSupported(available);
        })
        .then((id) => {
          if (unmounted) remote.cancelWatchAvailability(id).catch(() => {});
          else remoteWatchId = id;
        })
        .catch(() => {
          if (!unmounted) setCastSupported(false); // NotSupportedError — no cast receivers reachable at all
        });
    }

    return () => {
      unmounted = true;
      if (remoteWatchId !== undefined) castVideo.remote?.cancelWatchAvailability(remoteWatchId).catch(() => {});
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      if (seekSpinner.current) clearTimeout(seekSpinner.current);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("canplay", onPlaying);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onDuration);
      video.removeEventListener("durationchange", onDuration);
      video.removeEventListener("volumechange", onVolume);
      video.removeEventListener("ratechange", onRateChange);
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("ended", onEnded);
    };
  }, [videoRef, probeVolume]);

  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [containerRef]);

  /**
   * Le passage en incrustation quitte le plein écran qu'il laissait derrière lui.
   *
   * L'incrustation est offerte par le navigateur lui-même, pas par cette app : elle sort la
   * vidéo de la page sans rien dire à ce qui l'entoure. Le conteneur, lui, restait en plein
   * écran — un écran entier vide, avec pour seules commandes celles de la vignette, et il
   * fallait Échap pour en sortir. Un plein écran dont l'image est partie n'a plus d'objet.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    function onEnterPip() {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    }
    video.addEventListener("enterpictureinpicture", onEnterPip);
    return () => video.removeEventListener("enterpictureinpicture", onEnterPip);
  }, [videoRef]);

  // Shows the controls and (re)starts the auto-hide — called directly from
  // interaction handlers rather than left to a visible-state-diffing effect,
  // since repeated taps while already visible wouldn't otherwise change
  // `visible` and so wouldn't reset the hide timer. Two tiers of delay: a
  // plain tap/hover on the video keeps the default 3s, while interacting with
  // any actual control (top-bar buttons, the audio/subtitle menus, the bottom
  // bar) passes 10s — reading through a track list takes longer than glancing
  // at the seek bar, and the old single 3s timer kept vanishing mid-read
  // (button handlers stopPropagation, so nothing was resetting it at all).
  // Only auto-hides while actually playing; paused stays visible indefinitely.
  // The hide also closes any open menu, so an expired timer can't leave an
  // invisible-but-clickable menu floating over the video.
  // Lu par une référence : le raccourci clavier ne se réabonne pas à chaque lecture/pause, et sa
  // fermeture gardait le `playing` du montage — en pause, puisque les contrôles arrivent avant
  // la lecture. Une touche pendant le film montrait donc les contrôles pour de bon, sans jamais
  // relancer leur disparition (relu le 22/09/2026).
  const suspendedRef = useRef(suspended);
  useEffect(() => {
    suspendedRef.current = suspended;
  }, [suspended]);
  const playingRef = useRef(playing);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  /**
   * Un menu ouvert suspend la disparition.
   *
   * Le pointeur qui bougeait dans une liste de pistes relançait le minuteur ordinaire de trois
   * secondes, qui refermait le menu en pleine lecture de la liste ; au clavier, les flèches ne le
   * relançaient pas du tout, et le menu partait au bout de dix secondes (relevé le 23/09/2026).
   * Tant qu'un menu est ouvert, rien ne se cache ; sa fermeture relance le décompte normal.
   */
  const menuOpenRef = useRef(false);
  const showControls = useCallback(
    (delayMs: number = 3000) => {
      // Un geste vaut présence, et c'est ici qu'ils passent tous — un clic, une touche, un
      // pointeur qui bouge. Quelqu'un qui vient de bouger n'a pas à répondre trois épisodes plus
      // tard à une question qui demande s'il est là.
      noteViewerPresent();
      setVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (playingRef.current && !menuOpenRef.current) {
        hideTimer.current = setTimeout(() => {
          setVisible(false);
          setMenu(null);
        }, delayMs);
      }
    },
    []
  );

  // Voir `menuOpenRef` : ouvert, le minuteur est suspendu ; refermé, le décompte normal reprend.
  useEffect(() => {
    const wasOpen = menuOpenRef.current;
    menuOpenRef.current = menu !== null;
    if (menu !== null) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    } else if (wasOpen) {
      showControls();
    }
  }, [menu, showControls]);

  function hideControls() {
    setVisible(false);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }

  // For as long as a pointer is actually on the seek bar (hovering or dragging), controls must
  // never auto-hide at all — not even on a longer timer. Cancels any pending hide with nothing
  // to replace it; the hover/drag handlers below call showControls() again once the pointer
  // actually leaves or is released, restarting the normal countdown from a clean slate.
  function holdControls() {
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }

  // Tap toggles explicitly (show <-> hide) again, without reintroducing the
  // Android bug: that bug was touch firing a synthetic mousemove right before
  // click, which forced visible=true a split second before the toggle read
  // it — so every tap net-cancelled itself. Fix is to stop treating touch
  // pointer movement as "show" at all (see onPointerMove below); once that
  // synthetic move no longer touches `visible`, click can safely toggle from
  // whatever the real current state is, for both mouse and touch.
  function toggleControls() {
    if (menu !== null) {
      setMenu(null);
      // The menu just closed from a tap outside it — controls stay up on the
      // normal short timer instead of the previous "no timer at all" (which
      // left them visible forever until another tap).
      showControls();
      return;
    }
    if (visible) hideControls();
    else showControls();
  }

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  // showControls() does real effect work beyond setState (manages the auto-hide timeout ref),
  // so it can't move to a render-time adjustment. Called unconditionally on every playing
  // change — showControls() itself already only starts the hide timer when playing===true, so
  // this correctly both (a) kicks off the very first auto-hide once playback actually starts
  // (previously gated behind `if (!playing)`, which never re-fires showControls() for the
  // false->true transition — controls stayed visible forever until a manual tap) and
  // (b) forces controls back on with no timer when paused.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    showControls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  // Plain buttons only — deliberately not a double-tap-the-edge-of-the-screen gesture (easy to
  // trigger by accident, and conflicts with the tap-to-toggle-controls handler on the same area).
  function skip(deltaSeconds: number) {
    const video = videoRef.current;
    if (!video) return;
    // La durée est lue sur l'élément, pas dans l'état.
    //
    // L'écouteur clavier est posé une fois et ne dépend pas de la durée : sa fermeture gardait
    // donc celle du premier rendu — zéro, puisque la durée n'arrive qu'ensuite. Le saut se
    // bornait alors à la position courante, c'est-à-dire ne bougeait pas. Les boutons, eux,
    // fonctionnaient : ils sont recréés à chaque rendu. C'est pourquoi les flèches semblaient
    // sans effet là où les boutons marchaient.
    const limit = video.duration || duration || video.currentTime;
    const target = Math.min(Math.max(0, video.currentTime + deltaSeconds), limit);
    onSeekRequest?.(target);
    video.currentTime = target;
  }

  // Split in two: dragging the seek bar only moves the thumb/displayed time locally (no real
  // seek, no buffering triggered) until the pointer is released, which is when the actual seek
  // fires. Committing on every drag tick used to fire a real HTMLMediaElement seek on every
  // pixel of movement, each one triggering its own buffering/rebuffer cycle — which both felt
  // like the interface was fighting the drag and meant a quick "seek there, no wait, back" was
  // never actually free (every intermediate position had already been committed and buffered).
  function previewSeek(value: number) {
    setCurrentTime(value);
  }

  function commitSeek(value: number) {
    const video = videoRef.current;
    if (!video) return;
    onSeekRequest?.(value);
    video.currentTime = value;
    setCurrentTime(value);
  }

  // Trickplay scrubbing preview — fetched once per item, not per hover: it's item-wide static
  // metadata (grid layout + a handful of sprite-sheet tiles covering the whole runtime), so
  // there's nothing to re-fetch as the seek bar is dragged, only tiles to look up locally.
  const [trickplay, setTrickplay] = useState<{
    width: number; height: number; tileWidth: number; tileHeight: number; thumbnailCount: number; intervalMs: number;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jellyfin/trickplay/info?itemId=${itemId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setTrickplay(data);
      })
      .catch(() => {
        if (!cancelled) setTrickplay(null);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  // Pre-warms the browser's own HTTP cache with every trickplay sprite tile as soon as the
  // metadata is known, instead of only fetching a tile the first time the seek bar is actually
  // hovered — trades a bit of upfront bandwidth (a handful of small JPEGs — Jellyfin packs
  // hundreds of thumbnails per tile) for the preview never showing a blank/loading frame on
  // the first scrub. Fire-and-forget: nothing reads the Image objects, only their side effect
  // of populating the cache under the same URL updatePreview will request later.
  useEffect(() => {
    if (!trickplay) return;
    const perTile = trickplay.tileWidth * trickplay.tileHeight;
    const tileCount = Math.ceil(trickplay.thumbnailCount / perTile);
    for (let i = 0; i < tileCount; i++) {
      const img = new Image();
      img.src = `/api/jellyfin/trickplay/tile?itemId=${itemId}&width=${trickplay.width}&index=${i}`;
    }
  }, [trickplay, itemId]);

  const seekBarRef = useRef<HTMLDivElement>(null);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  /** The bar is under a finger or a pointer — the one state that thickens it. */
  const scrubbing = previewTime !== null;

  /**
   * What the lock screen, the Dynamic Island and a pair of headphones are told.
   *
   * Nothing was, and a media element playing sound claims the system's Now Playing slot whether
   * or not anybody describes what is in it — so iOS was showing a live activity for this film
   * carrying whatever the last web app to set one had left behind, which is why tapping it
   * opened a different application. Claiming the session puts our own name on it, and the
   * buttons on it reach this player rather than nothing.
   */
  useMediaSession(
    hidden
      ? null
      : {
          title,
          artworkUrl: `/api/jellyfin/image?itemId=${itemId}`,
          duration,
          position: currentTime,
          playing,
          onPlay: () => void videoRef.current?.play(),
          onPause: () => videoRef.current?.pause(),
          onSeek: (seconds) => commitSeek(seconds),
          onSkip: (delta) => skip(delta),
          onNext: nextEpisode ? onAdvance : null,
        }
  );
  const [previewFraction, setPreviewFraction] = useState(0);

  // Shared by mouse hover (desktop) and touch drag (mobile — there's no true hover there, so
  // this only actually renders while a touch is down, via the range input's own touch handling
  // reaching pointer move too) — both just need "where along the bar is the pointer". Plain
  // function, not useCallback: nothing needs its referential identity to stay stable, and the
  // extra state/hooks added alongside chapters/PiP/speed tripped the React Compiler's own
  // memoization-preservation check on the manually memoized version for reasons unrelated to
  // this function's own logic.
  /** Le temps sous ce pixel, sur toute la largeur de la barre — ce que la vignette annonce. */
  function fractionAt(clientX: number): number | null {
    const bar = seekBarRef.current;
    if (!bar || !duration) return null;
    const rect = bar.getBoundingClientRect();
    return rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : null;
  }

  function updatePreview(clientX: number) {
    const fraction = fractionAt(clientX);
    if (fraction === null) return;
    setPreviewFraction(fraction);
    setPreviewTime(fraction * duration);
    // And the bar follows the finger, which it did not: a touch drag never reaches the input's
    // own onChange — an input[type=range] on iOS only tracks its thumb — so the filled portion,
    // the thumb and the timecode all stayed where playback was while the thumbnail moved. One
    // navigated blind. This is the same call the input makes on a desktop drag, from the one
    // place that knows where the finger is.
    //
    // Only while actually dragging. A pointer merely passing over the bar previews what is
    // there; moving the playhead under it would be the bar chasing the mouse.
    if (seekingRef.current) previewSeek(fraction * duration);
  }

  // Jellyfin's own trickplay resolution (already the smallest one it generates — see
  // trickplay/info's own comment) is still a fixed size that doesn't know about the viewport —
  // on a small phone (iPhone mini reported live) it could cover close to the whole screen width.
  // Scaled down to fit a fraction of the actual screen instead, capped at 1x so it's never
  // upscaled past its native resolution (would just look blurry).
  const previewScale = trickplay && typeof window !== "undefined" ? Math.min(1, (window.innerWidth * 0.35) / trickplay.width) : 1;
  const previewDisplayWidth = trickplay ? Math.round(trickplay.width * previewScale) : 160;
  const previewDisplayHeight = trickplay ? Math.round(trickplay.height * previewScale) : 90;

  // Shared by the seek-bar hover preview and the chapters menu thumbnails below — same sprite
  // lookup math, just called at a different `time`. Plain function, not useCallback: same
  // reasoning as updatePreview above (nothing needs referential stability, and the React
  // Compiler's memoization check gets confused by unrelated nearby state).
  function trickplayTileAt(time: number): { url: string; bgX: number; bgY: number } | null {
    if (!trickplay) return null;
    const thumbIndex = Math.min(
      trickplay.thumbnailCount - 1,
      Math.max(0, Math.floor((time * 1000) / trickplay.intervalMs))
    );
    const perTile = trickplay.tileWidth * trickplay.tileHeight;
    const tileIndex = Math.floor(thumbIndex / perTile);
    const posInTile = thumbIndex % perTile;
    const row = Math.floor(posInTile / trickplay.tileWidth);
    const col = posInTile % trickplay.tileWidth;
    return {
      url: `/api/jellyfin/trickplay/tile?itemId=${itemId}&width=${trickplay.width}&index=${tileIndex}`,
      bgX: -(col * trickplay.width),
      bgY: -(row * trickplay.height),
    };
  }
  const previewTile = previewTime !== null ? trickplayTileAt(previewTime) : null;

  // Which chapter (if any) `time` currently falls inside — the last chapter whose start is
  // <= time. Shared by the scrub preview's discreet chapter label and could also back the
  // menu's "current chapter" highlight, but that one's own inline check is left untouched to
  // keep this change scoped to what was asked.
  function chapterIndexAt(time: number): number {
    let idx = -1;
    for (let i = 0; i < chapters.length; i++) {
      if (time >= chapters[i].start) idx = i;
      else break;
    }
    return idx;
  }

  // Fixed small thumbnail size for the chapters menu — cropped to a consistent 16:9-ish box
  // regardless of Jellyfin's actual trickplay tile resolution, so the list stays tidy even if
  // that resolution ever changes.
  const chapterThumbWidth = 64;
  const chapterThumbScale = trickplay ? chapterThumbWidth / trickplay.width : 1;
  const chapterThumbHeight = trickplay ? Math.round(trickplay.height * chapterThumbScale) : 36;

  function toggleMute() {
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  }

  function changeVolume(value: number) {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
    // The last word belongs to what actually happened. If the platform ignored the write, the
    // control has just proved itself useless and takes itself off the screen — rather than
    // staying there as a bar with nothing between its two ends.
    if (value > 0 && value < 1 && video.volume !== value) setVolumeSettable(false);
  }

  async function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    } else {
      await el.requestFullscreen().catch(() => {});
    }
  }

  async function showCastPicker() {
    const video = videoRef.current as CastVideoElement | null;
    if (!video) return;
    if (typeof video.webkitShowPlaybackTargetPicker === "function") {
      video.webkitShowPlaybackTargetPicker();
      return;
    }
    try {
      await video.remote?.prompt();
    } catch {
      // No devices found or the user dismissed the picker — same silent behavior as AirPlay.
    }
  }

  function handleMinimizeClick() {
    onMinimize();
  }

  function handleCloseClick() {
    onClose();
  }

  function changeSpeed(rate: number) {
    const video = videoRef.current;
    if (video) video.playbackRate = rate;
    setMenu(null);
  }

  function jumpToChapter(startSeconds: number) {
    commitSeek(startSeconds);
    setMenu(null);
  }

  // Shifts every cue of the CURRENTLY SHOWING subtitle track by `deltaSeconds` — applied
  // directly to the live TextTrackCue objects (their startTime/endTime are writable), not
  // re-derived from an "original" copy, so repeated small nudges (−0.5s, −0.5s, +0.5s…)
  // accumulate correctly without needing to track original timings separately.
  //
  // `subtitleTracks` (this component's own prop) and PlayerHost's externalSubtitleTracks are
  // built from the exact same source array in the same order — video.textTracks is indexed by
  // that same DOM/source order — so position can be found here without PlayerHost needing to
  // expose that mapping directly.
  function shiftSubtitles(deltaSeconds: number) {
    if (hostSubtitleOffset) {
      hostSubtitleOffset.onShift(deltaSeconds);
      return;
    }
    const video = videoRef.current;
    if (!video || currentSubtitleId === null) return;
    const position = subtitleTracks.findIndex((t) => t.id === currentSubtitleId);
    const cues = video.textTracks[position]?.cues;
    if (!cues) return;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      // Intentional native DOM mutation (a browser TextTrackCue, not React state) — the React
      // Compiler's static analysis traces this back through videoRef and flags it as an
      // immutability violation, but there's no React-managed data here to keep immutable.
      // eslint-disable-next-line react-hooks/immutability
      cue.startTime += deltaSeconds;
      cue.endTime += deltaSeconds;
    }
    const id = currentSubtitleId;
    setCueOffsets((all) => ({ ...all, [id]: Math.round(((all[id] ?? 0) + deltaSeconds) * 10) / 10 }));
  }

  // Directional control nav — a fixed adjacency map, not a generic geometric grid solver, since
  // the actual layout is fixed: topbar (captions/audio/more/minimize/close) above center
  // (skip-back/playpause/skip-fwd) above seek above volume above fullscreen. Left/Right cycle
  // within whichever row currently has focus (clamped, no wraparound); Up/Down cross rows, always
  // landing on a specific, predictable control rather than "whatever was last focused there" —
  // e.g. Up from seek always lands on playpause specifically, matching a TV remote's own
  // predictability. Falls back to the old global skip(±10) behavior when nothing in here has
  // focus at all (e.g. right after a menu closes and returns focus to <body>), so arrow keys
  // still do something sane even outside the nav chain.
  // Haut (fermer, diffusion, mini-lecteur, son) → centre (−10, lecture, +10) → pilule du bas
  // (vitesse, audio, sous-titres, ⋮, plein écran) → barre. ←/→ parcourent chaque rangée.
  const NAV_DOWN: Record<string, string> = {
    close: "playpause", cast: "playpause", "cast-confirm": "playpause", minimize: "playpause", mute: "playpause", volume: "playpause",
    "skip-back": "more", playpause: "more", "skip-fwd": "more",
    speed: "seek", audio: "seek", captions: "seek", more: "seek", fullscreen: "seek",
  };
  const NAV_UP: Record<string, string> = {
    "skip-back": "close", playpause: "close", "skip-fwd": "close",
    speed: "playpause", audio: "playpause", captions: "playpause", more: "playpause", fullscreen: "playpause",
    seek: "more",
  };

  // Which topbar control reopens each menu on Escape, to land focus back where it came from.
  const MENU_TRIGGER: Record<string, string> = { subtitles: "captions", audio: "audio", more: "more", chapters: "more", speed: "speed", subtitleStyle: "captions", hdrCap: "more", sleep: "more" };

  // Lands focus on the menu's first item the instant it opens — clicking captions/audio/more
  // only focuses THAT button (native click behavior), never moves focus into the popup that
  // then renders beside it, so without this, Up/Down here had no menu items to cycle through at
  // all: the trigger button's own nav target (playpause) is what Down actually reached.
  useEffect(() => {
    if (!menu) return;
    const id = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [menu]);

  // Fallback for however else the menu can close besides Escape (which already refocuses its
  // own trigger explicitly): picking a subtitle/audio track, or any other item whose own onClick
  // just does setMenu(null) with no focus handling, removes the FOCUSED button from the DOM —
  // the browser's default is to drop focus to <body> when that happens, with nothing to catch
  // it, which silently locked the keyboard out of the whole nav chain (Up/Down/Left/Right all
  // read "nothing recognized" from there). If focus landed somewhere outside the player
  // entirely once the menu is gone, bring it back to play/pause rather than leaving it stranded.
  const prevMenuRef = useRef(menu);
  useEffect(() => {
    if (prevMenuRef.current && !menu && !containerRef.current?.contains(document.activeElement)) {
      containerRef.current?.querySelector<HTMLButtonElement>('[data-player-nav="playpause"]')?.focus();
    }
    prevMenuRef.current = menu;
  }, [menu, containerRef]);

  useEffect(() => {
    function focusNav(name: string) {
      containerRef.current?.querySelector<HTMLElement>(`[data-player-nav="${name}"]`)?.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (suspendedRef.current) return;
      // Ctrl+F cherche dans la page, Cmd+← revient en arrière, Alt+↑ appartient au système : aucun
      // n'est un raccourci du lecteur. Ils sautaient de dix secondes ou agrandissaient l'écran en
      // plus de faire ce qu'on leur demandait (23/09/2026).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement;
      // Un champ où l'on écrit garde ses touches — la recherche de sous-titres en a un, et une
      // espace y mettait le film en pause au lieu d'écrire.
      if (
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable) ||
        (active instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(active.type))
      ) {
        return;
      }
      const navName = active instanceof HTMLElement ? active.getAttribute("data-player-nav") : null;
      const navGroup = active instanceof HTMLElement ? active.closest<HTMLElement>("[data-player-navgroup]") : null;

      /**
       * Les raccourcis qui n'attendent aucun focus.
       *
       * Le clavier de ce lecteur supposait qu'on soit d'abord entré dedans : les flèches
       * circulaient entre les commandes, la barre d'espace se retirait dès qu'un bouton avait le
       * focus. Le lecteur stable amenait ce focus lui-même à l'ouverture ; le lecteur natif,
       * devenu celui de tout le monde, ne l'a jamais fait — d'où l'impression, juste, qu'il
       * n'avait plus de clavier du tout. Pire, un bouton resté focalisé *derrière* le lecteur
       * suffisait à faire avaler la barre d'espace par la garde prévue pour les boutons du
       * lecteur lui-même.
       *
       * Quand le focus est hors du lecteur, les touches valent donc pour ce qu'elles disent :
       * espace lit ou met en pause, les flèches sautent et règlent le son, M coupe, F agrandit.
       * La circulation entre commandes reste ce qu'elle était dès qu'on est entré dedans.
       */
      const outside = !(active instanceof Node) || !containerRef.current?.contains(active);
      if (outside && !menu) {
        if (e.code === "Space") {
          e.preventDefault();
          togglePlay();
          showControls();
          return;
        }
        if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
          e.preventDefault();
          skip(e.code === "ArrowRight" ? 10 : -10);
          showControls();
          return;
        }
        if (e.code === "ArrowUp" || e.code === "ArrowDown") {
          const video = videoRef.current;
          // Le volume ne se règle pas partout — iOS l'ignore en silence, ce que la barre elle-même
          // a appris à ses dépens. Là où il est ignoré, la touche ne fait rien plutôt que de
          // mentir.
          if (!video || !volumeSettable) return;
          e.preventDefault();
          changeVolume(Math.min(1, Math.max(0, video.volume + (e.code === "ArrowUp" ? 0.1 : -0.1))));
          showControls();
          return;
        }
      }

      // A menu (captions/audio/···/chapters/speed) is open — Up/Down/Escape belong entirely to
      // it while it's up, not to the control-bar nav map below (its own targets, like Down from
      // "captions" going to playpause, would otherwise fight this every press). No data-player-
      // nav tagging needed on each item: every button rendered inside the popup is a valid stop,
      // in the order they appear.
      if (menu) {
        if (e.code === "Escape") {
          e.preventDefault();
          setMenu(null);
          focusNav(MENU_TRIGGER[menu] ?? "more");
          return;
        }
        if (e.code === "ArrowUp" || e.code === "ArrowDown") {
          e.preventDefault();
          const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
          if (items.length === 0) return;
          const idx = items.indexOf(active as HTMLButtonElement);
          const next = e.code === "ArrowDown" ? items[Math.min(idx + 1, items.length - 1)] : items[Math.max(idx - 1, 0)];
          next?.focus();
          return;
        }
        if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
          // Not seekable controls — swallow rather than falling through to the global skip(±10)
          // below, which would otherwise fire while browsing a plain list of menu items.
          e.preventDefault();
          return;
        }
        // Space/Enter fall through to native button activation as usual; everything else
        // (M/F/etc.) is deliberately ignored while a menu has focus.
        if (e.code !== "Space") return;
      }

      if (e.code === "Space") {
        // A keyboard-focused control button (Tab'd to, or landed on via this nav) needs Space to
        // actually activate IT — preventDefault() here suppresses the browser's own
        // keyup-triggered click on that button (per spec, button activation via Space fires on
        // keyup only if keydown's default wasn't prevented), which otherwise made every control
        // except play/pause itself unreachable by keyboard.
        if (active instanceof HTMLButtonElement) return;
        e.preventDefault(); // default: page scroll
        togglePlay();
        showControls();
        return;
      }
      if (e.code === "KeyM") {
        toggleMute();
        return;
      }
      if (e.code === "KeyF") {
        if (fullscreenSupported) toggleFullscreen();
        return;
      }

      if (e.code === "ArrowUp" || e.code === "ArrowDown") {
        const target = (e.code === "ArrowUp" ? NAV_UP : NAV_DOWN)[navName ?? ""];
        if (!target) return;
        e.preventDefault(); // otherwise a focused range input's own Up/Down would also nudge its value
        focusNav(target);
        showControls();
        return;
      }

      if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        // Range inputs (seek/volume) already handle their own Left/Right natively (adjust the
        // value) — never hijack that.
        if (active instanceof HTMLInputElement) return;

        if (navGroup) {
          const siblings = Array.from(navGroup.querySelectorAll<HTMLElement>("[data-player-nav]"));
          const idx = siblings.indexOf(active as HTMLElement);
          const next = e.code === "ArrowRight" ? siblings[idx + 1] : siblings[idx - 1];
          if (next) {
            e.preventDefault();
            next.focus();
            showControls();
          }
          return;
        }

        // Nothing player-related focused — same global shortcut this always was.
        e.preventDefault();
        skip(e.code === "ArrowRight" ? 10 : -10);
        showControls();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // menu is a real dependency (not just omitted-by-habit like the others here) — this branches
    // on it directly, and without it in the array the closure would keep whatever `menu` was set
    // to the last time fullscreenSupported changed, silently going stale every time a menu
    // actually opens or closes.
    // `volumeSettable` en dépend aussi : les flèches haut/bas se retirent là où la plateforme
    // ignore le volume, et une fermeture capturant l'ancienne valeur ferait mentir la touche.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreenSupported, menu, volumeSettable]);

  // Le rebond d'un bouton du lecteur, joué jusqu'au bout plutôt que tenu par `:active` : un tap
  // franc dure quarante millisecondes, l'enfoncement n'avait pas atteint son creux que le retour
  // commençait, et l'interface paraissait inerte — « fragile », dit le 02/10/2026. Même principe
  // que les onglets du bas (`player-tab[data-pressed]`). Posé au contact, sur le bouton lui-même ;
  // retiré puis reposé si l'on appuie de nouveau avant la fin, pour que chaque appui rebondisse.
  function playPressSpring(e: SyntheticEvent) {
    const button = (e.target as Element | null)?.closest?.(".player-pill-btn, .player-center-btn");
    if (!(button instanceof HTMLElement)) return;
    button.removeAttribute("data-pressed");
    void button.offsetWidth;
    button.setAttribute("data-pressed", "");
    button.addEventListener("animationend", () => button.removeAttribute("data-pressed"), { once: true });
  }

  if (hidden) return null;

  return (
    <div
      className="absolute inset-0 z-10"
      onClick={toggleControls}
      onPointerDownCapture={playPressSpring}
      onKeyDownCapture={(e) => {
        if (e.key === "Enter" || e.key === " ") playPressSpring(e);
      }}
      onPointerMove={(e) => {
        // Only real mouse hover implies "show" — a touch pointer fires a
        // synthetic move right before its click, which would otherwise force
        // visible=true a split second before the click's toggle reads it.
        if (e.pointerType === "mouse") showControls();
      }}
    >
      {/* Native <track> cues render in the browser's own shadow DOM — the only way to reach
          them is the ::cue pseudo-element, which can't be scoped by a React inline style since
          it isn't a real element. Targets every <video> globally rather than this one
          specifically: harmless since the whole app only ever has one active <video> at a time. */}
      <style>{cueCss(subtitleStyle)}</style>
      {/* Always visible regardless of the auto-hide controls fade below —
          otherwise a rebuffer that happens while controls are hidden looks
          like a silent freeze instead of a loading state. */}
      {/* Un fil qui court en haut plutôt qu'une roue au centre : une roue au milieu de l'écran
          dit « bloqué », un fil dit « ça travaille » — ce qui est la vérité, et ce qui n'occupe
          pas le centre de l'image pendant qu'on regarde un film. Au-dessus de tout, y compris
          des contrôles cachés, pour la même raison qu'avant : une remise en tampon pendant que
          les contrôles ont disparu ne doit pas ressembler à un gel silencieux. */}
      {(loading || buffering) && (
        <>
          <div className="player-wait-thread pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-white/10">
            <div className="player-loading-line h-full w-full bg-accent-500" />
          </div>
          <div className="player-wait-wheel pointer-events-none absolute inset-0 z-20 items-center justify-center">
            <Loader2 size={40} className="animate-spin text-white/80" />
          </div>
        </>
      )}

      {/* Skip-intro and next-up prompts stay visible even when the rest of the
          controls have auto-hidden — they're time-sensitive, not navigation. */}
      {showSkipIntro && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (videoRef.current) {
              onSeekRequest?.(introSkip!.end);
              videoRef.current.currentTime = introSkip!.end;
            }
          }}
          className="player-pill pointer-events-auto absolute px-4 py-2.5 text-sm font-medium text-white"
          style={{
            bottom: PROMPT_BOTTOM,
            right: "max(1rem, env(safe-area-inset-right))",
          }}
        >
          {t('player.skipIntro')}
        </button>
      )}

      {/* Les trente dernières secondes de la minuterie de veille : une ligne, à la place de rien.
          Visible commandes masquées — c'est précisément quand personne ne les regarde qu'elle sert. */}
      {sleepWarning !== null && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="player-pill pointer-events-auto absolute flex items-center gap-2 py-1.5 pl-3.5 pr-1.5 text-xs text-white/80"
          style={{
            bottom: PROMPT_BOTTOM,
            left: "max(1rem, env(safe-area-inset-left))",
          }}
        >
          <Moon size={12} aria-hidden />
          <span className="tabular-nums">{t("player.sleep.warning", { n: sleepWarning })}</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => {
              noteViewerPresent();
              sleepTimerStore.continue();
            }}
            className="rounded-full px-2 py-0.5 font-medium text-white hover:bg-white/10"
          >
            {t("player.sleep.continue")}
          </button>
        </div>
      )}

      {/* La question, à la place de l'épisode suivant. Elle occupe tout l'écran plutôt qu'un coin :
          si personne n'est là, autant que la pièce cesse d'être éclairée par un film qui joue. */}
      {askStillThere && nextEpisode && (
        <div className="pointer-events-auto absolute inset-0 z-20 flex flex-col items-center justify-center gap-5 bg-black/80 px-6 text-center">
          <p className="text-lg font-medium text-white">{t("player.stillThere")}</p>
          <p className="max-w-sm text-sm text-slate-400">{t("player.stillThereHint")}</p>
          <button
            type="button"
            onClick={() => {
              noteViewerPresent();
              onAdvance();
            }}
            className="btn-primary px-6"
          >
            {t("player.stillThereContinue")}
          </button>
        </div>
      )}

      {showNextUp && !askStillThere && nextEpisode && (
        <div
          // Ses boutons ne doivent pas atteindre le fond, dont l'appui montre ou cache les commandes.
          onClick={(e) => e.stopPropagation()}
          className="player-panel pointer-events-auto absolute w-72 max-w-[calc(100vw-2rem)] animate-fade-in-scale rounded-2xl p-4"
          style={{
            bottom: PROMPT_BOTTOM,
            right: "max(1rem, env(safe-area-inset-right))",
          }}
        >
          <p className="mb-1 text-xs text-slate-400">{t('player.nextEpisodeIn', { n: nextUpCountdown })}</p>
          <p className="mb-3 truncate text-sm font-medium text-white">{nextEpisode.title}</p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                noteViewerPresent();
                onAdvance();
              }}
              className="btn-primary flex-1 justify-center py-1.5 text-xs"
            >
              {t('player.playNow')}
            </button>
            <button
              onClick={() => setNextUpDismissed(true)}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Cachées, les commandes ne prennent plus les appuis : l'opacité ne change rien à ce qu'on
          touche, et un appui au milieu de l'écran pour les faire revenir mettait le film en pause —
          en haut à droite, il le fermait (relevé le 23/09/2026). Leurs trois groupes passent en
          `pointer-events-none` avec elles, et l'appui retombe sur le fond, qui les rappelle. */}
      <div
        className={`pointer-events-none absolute inset-0 flex flex-col justify-between transition-opacity duration-300 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      >
        {/* Deux bandes plutôt qu'un dégradé plein écran. Le milieu était transparent mais était
            composité quand même : le compositeur mélange toute la surface du calque, image par
            image, par-dessus une vidéo qui peut être en 4K. Ces deux-là couvrent ce qu'il y a à
            couvrir — le titre en haut, les contrôles en bas — et laissent les quarante pour cent
            du milieu tranquilles. */}
        {/* Plus hauts au bureau, où l'écran l'est aussi. Le bas porte le titre : un palier à mi-hauteur
            le garde lisible sur une image claire, sans voile sur le reste de l'image. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[140px] bg-gradient-to-b from-black/55 to-transparent lg:h-[180px]" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[180px] bg-gradient-to-t from-black/60 via-black/25 to-transparent lg:h-[240px]" />
        {/* En haut : fermer, puis — à distance, pour que le pouce ne prenne pas l'un pour l'autre — la
            pilule de la diffusion et du mini-lecteur ; à droite, le son seul. Le reste est en bas,
            près de la barre, comme sur l'Apple TV. Marges : 16, 24 puis 32 px, plus les bords sûrs
            (encoche en paysage, Dynamic Island en portrait). */}
        <div
          data-player-navgroup="topbar"
          className={`player-chrome-x ${visible ? "pointer-events-auto translate-y-0" : "pointer-events-none -translate-y-1"} player-spring flex items-center justify-between gap-3 pb-4 motion-reduce:translate-y-0`}
          // Capture phase: children stopPropagation() in the bubble phase, which is exactly why
          // the old timer never got reset by button use — capture fires on the way DOWN, before
          // any child handler, so every top-bar interaction reliably re-arms the long timer.
          onClickCapture={() => showControls(10000)}
          style={{ paddingTop: "max(1rem, calc(env(safe-area-inset-top) + 1rem))" }}
        >
          <div className="flex min-w-0 items-center gap-4 max-[379px]:gap-3">
            <button
              data-player-nav="close"
              onClick={(e) => {
                e.stopPropagation();
                handleCloseClick();
              }}
              aria-label={t("common.close")}
              className="player-pill player-pill-btn shrink-0"
            >
              <X size={22} />
            </button>
            <div ref={castPillRef} data-cast-pill className="player-pill flex min-w-0 items-center p-1">
              {/* Les deux boutons au repos, et la confirmation qui prend leur place : deux segments
                  toujours là, l'un se resserrant pendant que l'autre s'ouvre — la pilule grandit
                  d'un geste au lieu de sauter d'une largeur à l'autre. */}
              <div
                className={`player-pill-seg flex items-center gap-1 ${castConfirm ? "player-pill-seg-closed" : ""}`}
                inert={castConfirm}
                aria-hidden={castConfirm || undefined}
              >
                {castSupported && (
                  <button
                    data-player-nav="cast"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Le lecteur serveur joue une adresse : le sélecteur s'ouvre tout de suite, dans
                      // ce geste même — `showCastPicker` l'appelle avant tout `await`, ce qu'iOS exige.
                      // Le lecteur natif doit d'abord céder la place (`onCastRequest`) : on demande.
                      if (onCastRequest) setCastConfirm(true);
                      else void showCastPicker();
                    }}
                    aria-label={t("player.cast")}
                    data-active={castActive ? "" : undefined}
                    className="player-pill-btn"
                  >
                    <Cast size={20} />
                  </button>
                )}
                <button
                  data-player-nav="minimize"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleMinimizeClick();
                  }}
                  title={t('player.minimize')}
                  aria-label={t('player.minimize')}
                  className="player-pill-btn"
                >
                  <PictureInPicture2 size={20} />
                </button>
              </div>
              <div
                data-cast-confirm={castConfirm ? "open" : "closed"}
                className={`player-pill-seg flex min-w-0 items-center gap-2 ${castConfirm ? "" : "player-pill-seg-closed"}`}
                inert={!castConfirm}
                aria-hidden={!castConfirm || undefined}
              >
                <span className="min-w-0 truncate pl-3 text-sm text-white/90 max-[379px]:text-[13px]">
                  {t(castKind === "airplay" ? "player.castConfirm.airplay" : "player.castConfirm.remote")}
                </span>
                <button
                  data-player-nav="cast-confirm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCastConfirm(false);
                    // Exactement le chemin d'avant : le lecteur natif cède la place au lecteur
                    // serveur, qui ouvre le sélecteur quand son élément est prêt.
                    onCastRequest?.();
                  }}
                  className="player-capsule shrink-0"
                >
                  {t("player.castConfirm.confirm")}
                </button>
              </div>
            </div>
          </div>
          {/* Le son, seul à droite. Au bureau, le curseur se replie et se déplie sous le pointeur ou
              au clavier (`.player-volume`, globals.css) ; partout ailleurs — doigt, tablette, écran
              tactile — il reste déplié, et sur iPhone il n'y a que le bouton, iOS ignorant le
              volume d'une page. Jamais une fonction réservée au survol. Le temps d'une confirmation
              de diffusion, sur un écran étroit, il cède sa place à la pilule qui s'ouvre. */}
          <div className={`player-volume player-pill flex shrink-0 items-center p-0.5 ${castConfirm ? "max-sm:hidden" : ""}`}>
            <button
              data-player-nav="mute"
              onClick={(e) => {
                e.stopPropagation();
                toggleMute();
              }}
              aria-label={t("player.mute")}
              className="player-pill-btn"
            >
              {muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
            {/* Four pixels tall is a target a finger cannot land on, let alone drag along: every
                touch became a tap, and a tap on a range input jumps straight to the end it
                landed nearest. Twenty is the same bar with room to hold on to. */}
            {volumeSettable && (
              <span className="player-volume-slider flex items-center">
                <input
                  data-player-nav="volume"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(e) => changeVolume(Number(e.target.value))}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={t("player.volume")}
                  className="mr-3 h-5 w-20 cursor-pointer accent-white"
                  style={{ WebkitTouchCallout: "none", touchAction: "none" }}
                />
              </span>
            )}
          </div>
        </div>

        {menu && (
          <div
            ref={menuRef}
            /* w-72 rather than w-56: the subtitle offset row asks for a label and three controls
               side by side, which came to about two hundred and sixty pixels — so it overflowed,
               and a box that scrolls in one direction scrolls in both, which is where the
               horizontal bar came from. Wide enough that the row fits and "Taille sous-titres"
               stops wrapping onto two lines with it. */
            className="player-panel player-menu player-chrome-right pointer-events-auto absolute z-30 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overflow-x-hidden overscroll-contain rounded-2xl"
            style={{
              // `bottom` deliberately not set here: an absolutely-positioned element with both
              // `top` and `bottom` stretches to fill the space between them regardless of
              // content — which made this menu always ~half the screen tall even with only 2-3
              // items. `max-h-[60vh]` alone already caps growth for a long track list; the menu
              // otherwise just sizes to its content.
              // Juste au-dessus de la pilule du bas, d'où il s'ouvre ; et jamais plus haut que ce
              // que l'écran laisse sous la rangée du haut — un téléphone en paysage n'a pas 60 %.
              bottom: "calc(max(1rem, env(safe-area-inset-bottom)) + 5.75rem)",
              maxHeight: "min(60vh, calc(100dvh - max(1rem, env(safe-area-inset-bottom)) - 10.5rem))",
            }}
            onClick={(e) => e.stopPropagation()}
            onClickCapture={() => showControls(10000)}
          >
            {/* ⋮ : ce qu'on règle en regardant — chapitres, vitesse, minuterie —, puis, sous un trait
                et en plus discret, ce qu'on ne touche que pour comprendre ou ajuster l'appareil.
                Les réglages des sous-titres vivent dans le menu des sous-titres : ils avaient ici
                la même icône que lui, et deux lignes de plus pour une question qui n'est pas d'ici. */}
            {menu === "more" && (
              <>
                {chapters.length > 0 && (
                  <button
                    onClick={() => setMenu("chapters")}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                  >
                    <ListVideo size={16} /> {t('player.chapters')}
                  </button>
                )}
                {/* Active, la lune à la place du chronomètre, et ce qui reste. Rien d'autre à l'écran
                    ne dit qu'une minuterie court. */}
                <button
                  onClick={() => setMenu("sleep")}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                >
                  {sleepMode === "off" ? <Timer size={16} /> : <Moon size={16} fill="currentColor" data-sleep-active="" />}
                  {t("player.sleep.title")}
                  {sleepMode === "episode"
                    ? ` · ${t("player.sleep.episode")}`
                    : sleepMinutes !== null
                      ? ` · ${t("player.sleep.minutes", { n: sleepMinutes })}`
                      : ""}
                </button>
                {/* Le retour, tant que cette séance existe pour diffuser. Il ne dépend d'aucun
                    événement — voir `onCastReturn` — et c'est précisément ce qui le rend sûr :
                    la seule partie de la diffusion qu'on ne puisse pas éprouver depuis ici est
                    la détection, et celle-ci s'en passe. La diffusion elle-même est en haut. */}
                {onCastReturn && (
                  <button
                    onClick={() => {
                      onCastReturn();
                      setMenu(null);
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                  >
                    <MonitorSmartphone size={16} />
                    {castActive ? t("player.castStop") : t("player.castReturn")}
                  </button>
                )}
                {frameFit && (
                  // Le menu reste ouvert : l'image glisse derrière, et c'est ce qu'on veut voir.
                  <button
                    type="button"
                    role="switch"
                    aria-checked={frameFit.on}
                    onClick={() => frameFit.onChange(!frameFit.on)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                  >
                    <span className="flex items-center gap-3">
                      <Scan size={16} /> {t("player.frameFit")}
                    </span>
                    <span
                      aria-hidden
                      className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors ${frameFit.on ? "bg-white/80" : "bg-white/20"}`}
                    >
                      <span
                        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full transition-transform ${frameFit.on ? "translate-x-4 bg-black" : "bg-white"}`}
                      />
                    </span>
                  </button>
                )}
                <div data-menu-secondary className="border-t border-white/[0.08]">
                  <button
                    onClick={() => {
                      onTogglePlaybackInfo();
                      setMenu(null);
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs text-white/60 hover:bg-white/10"
                  >
                    <Info size={14} /> {t('player.playbackInfo')}
                  </button>
                  {hdrCap && (
                    <button
                      onClick={() => setMenu("hdrCap")}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs text-white/60 hover:bg-white/10"
                    >
                      <Sun size={14} /> {t("player.hdrCap.title")} · {hdrCapLabel(hdrCap.current)}
                    </button>
                  )}
                </div>
              </>
            )}
            {(menu === "chapters" || menu === "subtitleStyle" || menu === "hdrCap" || menu === "sleep") && (
              <button
                onClick={() => setMenu(menu === "subtitleStyle" ? "subtitles" : "more")}
                className="flex w-full items-center gap-2 border-b border-white/10 px-3 py-2 text-left text-sm text-white/70 hover:bg-white/10"
              >
                <ArrowLeft size={14} /> {t('common.back')}
              </button>
            )}
            {(menu === "audio" || menu === "subtitles") &&
              (menu === "audio" ? audioTracks : subtitleTracks).map((tr) => (
                <button
                  key={tr.id}
                  onClick={() => {
                    if (menu === "audio") onChangeAudio(tr.id);
                    else onChangeSubtitle(tr.id);
                    setMenu(null);
                  }}
                  /**
                   * Deux lignes plutôt qu'une coupure.
                   *
                   * Les étiquettes de pistes sont courtes par construction — langue, format
                   * remarquable, canaux — sauf lorsqu'une parenthèse doit distinguer deux pistes
                   * que rien d'autre ne sépare : « Anglais — 5.1 (Mix 6-Tracks Original du
                   * LaserDisc) ». C'est précisément le cas où couper efface ce qu'on avait mis là
                   * pour choisir. Deux lignes suffisent à tout ce que la bibliothèque contient.
                   */
                  className={`block w-full px-3 py-2 text-left text-sm line-clamp-2 hover:bg-white/10 ${
                    (menu === "audio" ? currentAudioId : currentSubtitleId) === tr.id ? "text-accent-400" : "text-white"
                  }`}
                >
                  {tr.label}
                </button>
              ))}
            {menu === "subtitles" && (
              <button
                onClick={() => {
                  onChangeSubtitle(null);
                  setMenu(null);
                }}
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-white/10 ${
                  currentSubtitleId === null ? "text-accent-400" : "text-white"
                }`}
              >
                {t('player.none')}
              </button>
            )}
            {/* Sous les pistes, ce qui règle leur affichage : l'apparence (une porte, la taille, la
                couleur et le fond se réglant ensemble) et, une piste choisie, son décalage. */}
            {menu === "subtitles" && (
              <div className="border-t border-white/10">
                <button
                  onClick={() => setMenu("subtitleStyle")}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                >
                  {t("player.subtitleStyle.title")}
                  <ChevronRight size={14} className="shrink-0 text-white/50" />
                </button>
                {currentSubtitleId !== null && (
                  <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-white">
                    <span className="min-w-0">{t('player.subtitleOffset')}</span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => shiftSubtitles(-0.5)}
                        className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                      >
                        −0.5s
                      </button>
                      <span className="w-12 text-center tabular-nums text-xs text-white/70">
                        {subtitleOffset > 0 ? "+" : ""}
                        {subtitleOffset}s
                      </span>
                      <button
                        onClick={() => shiftSubtitles(0.5)}
                        className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                      >
                        +0.5s
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {menu === "subtitleStyle" && (
              <>
                <SubtitleStyleGroup
                  label={t("player.subtitleSize")}
                  options={SUBTITLE_SIZES.map((s) => ({ value: s.value, label: t(`player.${s.labelKey}`) }))}
                  current={subtitleStyle.size}
                  onPick={(size) => subtitleStyleStore.set({ size })}
                />
                <SubtitleStyleGroup
                  label={t("player.subtitleStyle.colour")}
                  options={SUBTITLE_COLORS.map((c) => ({ value: c, label: t(`player.subtitleStyle.colours.${c}`) }))}
                  current={subtitleStyle.color}
                  onPick={(color) => subtitleStyleStore.set({ color })}
                />
                <SubtitleStyleGroup
                  label={t("player.subtitleStyle.background")}
                  options={SUBTITLE_BACKGROUNDS.map((b) => ({
                    value: b,
                    label: t(`player.subtitleStyle.backgrounds.${b}`),
                  }))}
                  current={subtitleStyle.background}
                  onPick={(background) => subtitleStyleStore.set({ background })}
                />
              </>
            )}
            {menu === "hdrCap" && hdrCap && (
              <p className="max-w-64 px-3 pb-1 pt-2 text-xs text-white/60">{t("player.hdrCap.hint")}</p>
            )}
            {menu === "hdrCap" &&
              hdrCap &&
              HDR_CAP_CHOICES.map((choice) => (
                <button
                  key={String(choice)}
                  onClick={() => {
                    setMenu(null);
                    if (choice !== hdrCap.current) hdrCap.onPick(choice);
                  }}
                  className={`block w-full px-3 py-2 text-left text-sm hover:bg-white/10 ${
                    hdrCap.current === choice ? "text-accent-400" : "text-white"
                  }`}
                >
                  {hdrCapLabel(choice)}
                </button>
              ))}
            {menu === "sleep" &&
              // « Fin de l'épisode » seulement quand il y a un épisode après : sans lui, l'épisode
              // s'arrête déjà à sa fin, et l'option ne changerait rien.
              (["off", ...SLEEP_DURATIONS, ...(nextEpisode ? (["episode"] as const) : [])] as SleepMode[]).map((choice) => (
                <button
                  key={choice}
                  onClick={() => {
                    setMenu(null);
                    // Rechoisir la durée en cours la relance en entier, comme « Continuer ».
                    sleepTimerStore.choose(choice);
                  }}
                  className={`block w-full px-3 py-2 text-left text-sm hover:bg-white/10 ${
                    sleepMode === choice ? "text-accent-400" : "text-white"
                  }`}
                >
                  {sleepLabel(choice)}
                </button>
              ))}
            {menu === "speed" &&
              PLAYBACK_SPEEDS.map((rate) => (
                <button
                  key={rate}
                  onClick={() => changeSpeed(rate)}
                  className={`block w-full px-3 py-2 text-left text-sm hover:bg-white/10 ${
                    speed === rate ? "text-accent-400" : "text-white"
                  }`}
                >
                  {rate === 1 ? t('player.speedNormal') : `${rate}x`}
                </button>
              ))}
            {menu === "chapters" &&
              chapters.map((ch, i) => {
                const tile = trickplayTileAt(ch.start);
                return (
                  <button
                    key={i}
                    onClick={() => jumpToChapter(ch.start)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/10 ${
                      currentTime >= ch.start && (chapters[i + 1] ? currentTime < chapters[i + 1].start : true)
                        ? "text-accent-400"
                        : "text-white"
                    }`}
                  >
                    {trickplay && (
                      <div
                        className="shrink-0 overflow-hidden rounded bg-black/40"
                        style={{ width: chapterThumbWidth, height: chapterThumbHeight }}
                      >
                        {tile && (
                          <div
                            style={{
                              width: trickplay.width,
                              height: trickplay.height,
                              transform: `scale(${chapterThumbScale})`,
                              transformOrigin: "top left",
                              backgroundImage: `url(${tile.url})`,
                              backgroundPosition: `${tile.bgX}px ${tile.bgY}px`,
                              backgroundSize: `${trickplay.width * trickplay.tileWidth}px ${trickplay.height * trickplay.tileHeight}px`,
                            }}
                          />
                        )}
                      </div>
                    )}
                    <span className="min-w-0 flex-1 truncate">{ch.name ?? t("player.chapterN", { n: i + 1 })}</span>
                    <span className="shrink-0 tabular-nums text-white/50">{formatTime(ch.start)}</span>
                  </button>
                );
              })}
          </div>
        )}

        {/* Center play/pause, flanked by ±10s skip buttons — plain buttons only, not a
            double-tap-the-screen-edge gesture (too easy to trigger by accident, and would
            conflict with the tap-to-toggle-controls handler covering the same area). Hidden
            while a spinner is already showing. */}
        {!loading && !buffering && (
          <div data-player-navgroup="center" className={`${visible ? "pointer-events-auto" : "pointer-events-none"} absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-9 sm:gap-12 max-[379px]:gap-6`}>
            <button
              data-player-nav="skip-back"
              onClick={(e) => {
                e.stopPropagation();
                skip(-10);
              }}
              className="player-pill player-pill-light player-center-btn player-glass-back"
              title={t('player.rewind10')}
            >
              <SkipGlyph direction="back" />
            </button>
            <button
              data-player-nav="playpause"
              onClick={(e) => {
                e.stopPropagation();
                togglePlay();
              }}
              aria-label={playing ? t("player.pause") : t("player.play")}
              data-size="main"
              className="player-pill player-pill-light player-center-btn"
            >
              {playing ? <Pause size={30} fill="currentColor" strokeWidth={0} /> : <Play size={30} fill="currentColor" strokeWidth={0} className="translate-x-[2px]" />}
            </button>
            <button
              data-player-nav="skip-fwd"
              onClick={(e) => {
                e.stopPropagation();
                skip(10);
              }}
              className="player-pill player-pill-light player-center-btn player-glass-fwd"
              title={t('player.forward10')}
            >
              <SkipGlyph direction="forward" />
            </button>
          </div>
        )}

        {/* En bas : le titre et la pilule des réglages sur une rangée, la barre et ses deux temps
            dessous. */}
        <div
          className={`player-chrome-x ${visible ? "pointer-events-auto translate-y-0" : "pointer-events-none translate-y-1"} player-spring flex flex-col gap-3 pt-4 motion-reduce:translate-y-0`}
          onClick={(e) => e.stopPropagation()}
          onClickCapture={() => showControls(10000)}
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <div className="flex items-end gap-3">
            {/* La série en grand, l'épisode en petit dessous ; un film, son titre seul. Une ombre
                douce sous le texte et le palier du voile du bas : lisible sur une image claire, sans
                flou. "Série — S02E05 · Le pilote" arrive d'une seule pièce du serveur. */}
            <div className="player-title min-w-0 flex-1 pb-0.5">
              {(() => {
                const cut = title.indexOf(" — ");
                const main = cut === -1 ? title : title.slice(0, cut);
                return (
                  <>
                    <p data-player-title className="player-title-main truncate text-white">{main}</p>
                    {cut !== -1 && (
                      <p className="truncate text-[13px] font-medium text-white/70 sm:text-sm">{title.slice(cut + 3)}</p>
                    )}
                  </>
                );
              })()}
            </div>
            {/* Vitesse · audio · sous-titres · ⋮ — et le plein écran au bout, là où il existe : à
                côté du temps restant, il aurait cassé la symétrie de la ligne du temps. Les menus
                s'ouvrent vers le haut depuis cette pilule. */}
            <div data-player-navgroup="bottombar" data-settings-pill className="player-pill flex shrink-0 items-center gap-1 p-1 max-[379px]:gap-0.5">
              <button
                data-player-nav="speed"
                onClick={() => setMenu(menu === "speed" ? null : "speed")}
                aria-label={t("player.speed")}
                data-on={menu === "speed" ? "" : undefined}
                className="player-pill-btn"
              >
                {speed !== 1 ? <span className="text-[13px] font-semibold tabular-nums">{speed}×</span> : <Gauge size={20} />}
              </button>
              {audioTracks.length > 1 && (
                <button
                  data-player-nav="audio"
                  onClick={() => setMenu(menu === "audio" ? null : "audio")}
                  aria-label={t("player.audio")}
                  data-on={menu === "audio" ? "" : undefined}
                  className="player-pill-btn"
                >
                  <AudioLines size={20} />
                </button>
              )}
              {subtitleTracks.length > 0 && (
                <button
                  data-player-nav="captions"
                  onClick={() => setMenu(menu === "subtitles" ? null : "subtitles")}
                  aria-label={t("player.subtitles")}
                  data-on={menu === "subtitles" ? "" : undefined}
                  data-active={currentSubtitleId !== null ? "" : undefined}
                  className="player-pill-btn"
                >
                  <Captions size={20} />
                </button>
              )}
              <button
                data-player-nav="more"
                onClick={() => setMenu(menu === "more" ? null : "more")}
                title={t('player.moreOptions')}
                aria-label={t('player.moreOptions')}
                data-on={menu === "more" ? "" : undefined}
                className="player-pill-btn"
              >
                <EllipsisVertical size={20} />
              </button>
              {fullscreenSupported && (
                <button
                  data-player-nav="fullscreen"
                  onClick={toggleFullscreen}
                  aria-label={t("player.fullscreen")}
                  className="player-pill-btn"
                >
                  {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
                </button>
              )}
            </div>
          </div>
          {/* Le temps écoulé à gauche, ce qui reste à droite — sans signe moins, toujours, en pause
              comme en lecture. Il n'y a plus de bascule : les deux sont là. */}
          <div className="flex items-center gap-3">
          <span data-player-elapsed className="player-time shrink-0 text-left">{formatTime(currentTime)}</span>
          <div
            ref={seekBarRef}
            className="relative min-w-0 flex-1 select-none"
            // Posé et retiré par le composant, qui sait exactement quand la barre est sous un
            // doigt ou un curseur — c'est déjà ce qui décide d'afficher la vignette. Laisser
            // faire `:hover` voulait dire la laisser épaissie longtemps après le doigt parti,
            // WebKit gardant l'état de survol jusqu'à ce qu'on touche ailleurs.
            data-scrub={previewTime !== null ? "" : undefined}
            style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
            // Same treatment as the top-bar buttons (see showControls' comment) but stronger:
            // holdControls() suspends auto-hide entirely for as long as the pointer is anywhere
            // on the bar — hovering to preview a thumbnail, or dragging — rather than merely
            // extending the timer, since a 10s cap could still expire mid-read on a long scrub.
            // The normal countdown only resumes once the pointer actually leaves or is released.
            onMouseEnter={() => {
              if (!isTouchEcho()) holdControls();
            }}
            onMouseMove={(e) => {
              // Rejoué au point du doigt, il rallumait la vignette que le touchend venait
              // d'éteindre — et plus aucun mouseup ne l'éteint, voir lastTouchEndRef.
              if (isTouchEcho()) return;
              holdControls();
              updatePreview(e.clientX);
            }}
            onMouseLeave={() => {
              setPreviewTime(null);
              if (!seekingRef.current) showControls(5000);
            }}
            onTouchStart={(e) => {
              touchDragRef.current = true;
              lastTouchXRef.current = e.touches[0].clientX;
              holdControls();
              updatePreview(e.touches[0].clientX);
            }}
            onTouchMove={(e) => {
              holdControls();
              // Un doigt immobile n'est pas immobile au dixième de pixel près, et sur un
              // téléphone un pixel de barre vaut une vingtaine de secondes de film : sans ce
              // seuil, la vignette hésitait entre deux images sous un doigt posé.
              const x = e.touches[0].clientX;
              if (lastTouchXRef.current !== null && Math.abs(x - lastTouchXRef.current) < TOUCH_JITTER_PX) return;
              lastTouchXRef.current = x;
              updatePreview(x);
            }}
            /**
             * Le saut est décidé ici, à partir de l'endroit où le doigt était — et non de la
             * valeur de l'input.
             *
             * Un `input[type=range]` sur iOS ne saute pas là où on le touche : il faut attraper
             * la pastille et la faire glisser. Tant qu'elle était visible en permanence, ça se
             * devinait ; une fois cachée au repos, toucher la barre affichait bien la vignette —
             * le conteneur, lui, suit le doigt — sans que l'input bouge d'un pixel, et le
             * relâchement ne changeait donc rien. Le conteneur sait où le doigt est depuis le
             * début : c'est lui qui conclut.
             */
            onTouchEnd={() => {
              seekingRef.current = false;
              touchDragRef.current = false;
              lastTouchXRef.current = null;
              lastTouchEndRef.current = performance.now();
              if (previewTime !== null) commitSeek(previewTime);
              setPreviewTime(null);
              setTimeout(() => showControls(5000), 0);
            }}
            // A touch the system takes back — a notification, a call, a gesture the browser
            // claims — never reaches touchend, and without this the bar would stay thick with
            // nothing on it. Rien n'est validé : le doigt n'a pas été relâché, il a été repris.
            onTouchCancel={() => {
              seekingRef.current = false;
              touchDragRef.current = false;
              lastTouchXRef.current = null;
              setPreviewTime(null);
              showControls(5000);
            }}
          >
            {/* The rail at rest. Painted here rather than left to the native track, which cannot
                be sized at all without giving up `accent-color` — and giving that up is what
                lets the bar answer to a finger as well as to a pointer. */}
            <div className={`pointer-events-none absolute top-1/2 w-full -translate-y-1/2 rounded-full bg-white/20 transition-[height] duration-[260ms] ease-[cubic-bezier(0.33,1,0.68,1)] ${scrubbing ? "h-2" : "h-1"}`} />
            {/* Buffered range — deliberately subtle (a slightly lighter track, not a bold
                second color): its only job is "can I scrub ahead without waiting", not
                competing for attention with the actual playback position. Sits under the
                native range input's own track, which only leaves it visible in the *unplayed*
                portion — exactly the part worth showing. */}
            {duration > 0 && bufferedEnd > 0 && (
              <div
                className={`pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full bg-white/35 transition-[height] duration-[260ms] ease-[cubic-bezier(0.33,1,0.68,1)] ${scrubbing ? "h-2" : "h-1"}`}
                // Both pointer-events-none (blocks click/drag) AND the two -webkit- properties
                // (blocks the native long-press "Look Up / Copy / Writing Tools" callout menu,
                // which iOS can still trigger on an element even with pointer-events: none —
                // verified live, reported as an overlay that was somehow both unclickable and
                // yet opening iOS's text-selection UI on a long press) are needed together.
                style={{
                  width: `${Math.min(100, (bufferedEnd / duration) * 100)}%`,
                  WebkitTouchCallout: "none",
                  WebkitUserSelect: "none",
                }}
              />
            )}
            {/* Chapter markers — visual only, not independently clickable: the seek bar's own
                drag already covers the whole track, so a second, narrower hit target right on
                top of it would only make small drag corrections more error-prone. Jumping to a
                specific chapter is what the chapters menu button is for. */}
            {duration > 0 &&
              chapters.map((ch, i) => (
                <div
                  key={i}
                  className={`pointer-events-none absolute top-1/2 w-px -translate-y-1/2 bg-black/50 transition-[height] duration-[260ms] ease-[cubic-bezier(0.33,1,0.68,1)] ${scrubbing ? "h-2" : "h-1"}`}
                  style={{ left: `${(ch.start / duration) * 100}%`, WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
                />
              ))}
            {previewTime !== null && (
              <div
                className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 overflow-hidden rounded-md bg-black shadow-xl ring-1 ring-white/20"
                style={{
                  // Bornée aux bords de la barre : au début ou à la fin du film, la moitié de la
                  // vignette sortait de l'écran, heure comprise.
                  left: `clamp(${previewDisplayWidth / 2}px, ${previewFraction * 100}%, calc(100% - ${previewDisplayWidth / 2}px))`,
                  width: previewDisplayWidth,
                  height: previewDisplayHeight,
                  WebkitTouchCallout: "none",
                  WebkitUserSelect: "none",
                }}
              >
                {previewTile && (
                  // Positioned/sized at Jellyfin's native trickplay resolution (unscaled — the
                  // background-position math above is in those native pixel units), then scaled
                  // down as a whole via transform to fit previewDisplayWidth/Height. Simpler and
                  // exactly as sharp as recomputing every offset in scaled units would be, since
                  // CSS transform scaling of a background-image is lossless the same way.
                  <div
                    style={{
                      width: trickplay!.width,
                      height: trickplay!.height,
                      transform: `scale(${previewScale})`,
                      transformOrigin: "top left",
                      backgroundImage: `url(${previewTile.url})`,
                      backgroundPosition: `${previewTile.bgX}px ${previewTile.bgY}px`,
                      // Sized to the FULL sprite sheet, not one tile slot — a plain background
                      // shorthand size here would stretch the whole sheet into one thumbnail's
                      // box instead of just positioning the correct slot within it.
                      backgroundSize: `${(trickplay!.width * trickplay!.tileWidth)}px ${(trickplay!.height * trickplay!.tileHeight)}px`,
                    }}
                  />
                )}
                <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1 py-0.5 text-center text-white">
                  {/* Discreet — a smaller, dimmer line above the time, not competing with it.
                      Only shown once the item actually has chapters. */}
                  {chapters.length > 0 && chapterIndexAt(previewTime) >= 0 && (
                    <p className="truncate text-[10px] text-white/60">{chapters[chapterIndexAt(previewTime)].name ?? t("player.chapterN", { n: chapterIndexAt(previewTime) + 1 })}</p>
                  )}
                  <p className="text-[11px] tabular-nums">{formatTime(previewTime)}</p>
                </div>
              </div>
            )}
            <input
              data-player-nav="seek"
              type="range"
              min={0}
              max={duration || 0}
              value={currentTime}
              // Every intermediate value while dragging is a preview only (see previewSeek) —
              // native range inputs fire 'input'/onChange continuously during a drag, not just
              // on release, so onChange alone can't distinguish "still dragging" from "done".
              // mousedown/touchstart mark the start of a drag; mouseup/touchend (native pointer
              // capture keeps these firing on the input even if the pointer wanders outside its
              // bounds) commit the FINAL value as one real seek and let auto-hide resume after 5s.
              // Sauf sous la souris, où l'action par défaut de l'input passe après le mousemove
              // du conteneur et remettrait sa propre valeur par-dessus (voir mouseDragRef).
              onChange={(e) => {
                if (!mouseDragRef.current && !touchDragRef.current) previewSeek(Number(e.target.value));
              }}
              onMouseDown={(e) => {
                // L'écho d'un toucher que le conteneur a déjà validé (voir lastTouchEndRef).
                if (isTouchEcho()) return;
                seekingRef.current = true;
                mouseDragRef.current = true;
                holdControls();
                // Un simple clic, sans mouvement : le même calcul que la vignette.
                const fraction = fractionAt(e.clientX);
                if (fraction !== null) previewSeek(fraction * duration);
              }}
              onTouchStart={() => {
                seekingRef.current = true;
                holdControls();
              }}
              // The 5s call is deferred a tick: mouseup/touchend is immediately followed by a
              // synchronous 'click' event, which the bottom bar's own onClickCapture (see its
              // comment) answers with a flat 10s for every other control there — since capture
              // fires on that ancestor before this handler's own effect could otherwise "stick",
              // running after the click's synchronous dispatch has already finished is what
              // makes 5s the one that actually wins, per what was asked for here specifically.
              onMouseUp={(e) => {
                if (isTouchEcho()) return;
                seekingRef.current = false;
                mouseDragRef.current = false;
                const fraction = fractionAt(e.clientX);
                commitSeek(fraction !== null ? fraction * duration : Number((e.target as HTMLInputElement).value));
                // Was missing here (only onTouchEnd cleared it) — a plain click/drag-release
                // with a mouse (or a mouse-like pointer, which iOS itself can synthesize in some
                // interaction patterns) left the trickplay preview frozen on screen indefinitely,
                // since nothing but leaving the bar entirely (onMouseLeave) would ever clear it.
                setPreviewTime(null);
                setTimeout(() => showControls(5000), 0);
              }}
              // Rien ici pour le toucher : c'est le conteneur qui le termine, et il est le seul
              // à savoir où le doigt était. Voir son onTouchEnd.
              onTouchEnd={() => {
                seekingRef.current = false;
              }}
              // Same preview/commit split as the mouse/touch handlers above, for arrow-key
              // seeking — without this, Left/Right looked like it "fought the bar and snapped
              // back to where it already was": onChange only calls previewSeek (updates the
              // displayed time, never the real video.currentTime), and with seekingRef never set
              // for a keyboard press, the very next 'timeupdate' tick (fires ~4x/s during
              // playback) overwrote that optimistic value straight back to the stale actual
              // position. keydown marks the same "don't let timeupdate clobber this" window
              // mouse/touch already get; keyup is this input method's equivalent of
              // mouseup/touchend, committing the real seek.
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                seekingRef.current = true;
                // Un relâchement hors de la fenêtre n'arrive jamais jusqu'ici.
                mouseDragRef.current = false;
                holdControls();
              }}
              onKeyUp={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                seekingRef.current = false;
                commitSeek(Number((e.target as HTMLInputElement).value));
                setTimeout(() => showControls(5000), 0);
              }}
              // h-5 (20px), not h-1: the native range control keeps its visual groove thin and
              // vertically centered regardless of the element's own box height, so a taller box
              // only grows the invisible hit area — reported live as too easy to lose while
              // trying to hold the mouse still on the bar to keep the trickplay preview up
              // during a straight horizontal drag. m-0: native range inputs carry a small
              // default margin in some engines' UA stylesheets that isn't reset by Tailwind's
              // own base styles — left in place, that margin would throw off centering the
              // buffered/chapter overlays on this taller box (see their top-1/2 above).
              className="player-seek relative m-0 block h-6 w-full cursor-pointer text-white"
              style={{
                // La part lue, que la piste native ne peut plus peindre elle-même.
                ["--played" as string]: `${duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0}%`,
                WebkitTouchCallout: "none",
              }}
            />
          </div>
          <span data-player-remaining className="player-time shrink-0 text-right">{formatTime(Math.max(0, duration - currentTime))}</span>
          </div>
        </div>
      </div>
    </div>
  );
}


/**
 * Un groupe de choix du sous-menu des sous-titres.
 *
 * Trois réglages qui se règlent tous de la même façon — un intitulé, quelques valeurs, celle qui
 * est retenue en couleur d'accent — et qui n'ont donc aucune raison d'être écrits trois fois.
 */
function SubtitleStyleGroup<T extends string | number>({
  label,
  options,
  current,
  onPick,
}: {
  label: string;
  options: { value: T; label: string }[];
  current: T;
  onPick: (value: T) => void;
}) {
  return (
    <div className="border-b border-white/10 px-3 py-2 last:border-b-0">
      <p className="mb-1.5 text-[11px] uppercase tracking-wide text-white/40">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onPick(option.value)}
            aria-pressed={current === option.value}
            className={`rounded-full px-2.5 py-1 text-xs ${
              current === option.value ? "bg-accent-600 text-white" : "bg-white/10 text-white/70 hover:bg-white/20"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
