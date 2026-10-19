"use client";

import { trickplayTileAt as sharedTrickplayTileAt, trickplayTileIndex, trickplayTileOrder } from "@/lib/trickplayTile";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, X, Captions, AudioLines, Cast, MonitorSmartphone, Loader2, PictureInPicture2, Info, RotateCcw, RotateCw, Gauge, ListVideo, EllipsisVertical, ArrowLeft, Sun, Scan, Moon, Timer, ChevronRight, SkipForward, Speech, Languages, Check, Layers } from "lucide-react";
import type { DialogueMode } from "@/lib/webcodecs/dialogueEnhance";
import { HDR_CAP_CHOICES, type HdrCapChoice } from "@/lib/webcodecs/hdrDisplay";
import { useT } from "@/components/TranslationProvider";
import { formatTime } from "@/lib/playerClock";
import { createLiquidPress, prefersReducedMotion } from "@/lib/liquidGlass/liquid";
import { LiquidMenu } from "@/components/player/LiquidMenu";
import { PlayerEpisodesMenu } from "@/components/player/PlayerEpisodesMenu";
import { usePlayerItem } from "@/lib/usePlayerItem";
import { PlayerDownloadRow } from "@/components/player/PlayerDownloadRow";
import { noteAutoAdvance, noteViewerPresent, autoAdvanceStore, STILL_THERE_AFTER } from "@/lib/autoAdvance";
import {
  subtitleStyleStore,
  cueCss,
  type ChromeEdges,
  SUBTITLE_SIZES,
  SUBTITLE_COLORS,
  SUBTITLE_BACKGROUNDS,
} from "@/lib/subtitleStyle";
import { useMediaSession } from "@/lib/useMediaSession";
import { VOLUME_STORAGE_KEY } from "@/lib/rememberedVolume";
import { usePlaybackQuality, writePlaybackQuality } from "@/lib/playbackQuality";
import { normalizeKey } from "@/lib/remoteKeys";
import { activeSkip, isEmptySurface, keyboardFocusWithin, surfaceAction } from "@/lib/playerSkip";
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
  /**
   * Un complément discret, en petit à côté de l'étiquette : l'avancement d'une génération de
   * sous-titres (« 42 % », « finalisation… »). Hors de l'étiquette pour qu'elle reste la forme
   * unique de `trackLabel.ts`, et qu'un chiffre qui bouge toutes les deux secondes ne la décale pas.
   */
  detail?: string;
}

/**
 * « Générer des sous-titres » dans le menu des sous-titres (lecteur natif, DECISIONS.md §70).
 * Absent : rien à proposer — fonction coupée, ou toutes les langues déjà là.
 */
export interface SubtitleGenerationMenu {
  /** Les langues qu'on peut encore demander, celle du compte en premier, déjà nommées. */
  targets: { code: string; label: string }[];
  /** Une demande est en vol : ne pas la proposer deux fois. */
  busy: boolean;
  onGenerate: (code: string) => void;
  /** Les générations en pause, à reprendre d'un geste. */
  resumable: { code: string; label: string }[];
  onResume: (code: string) => void;
}

/**
 * « Deux sous-titres » (DECISIONS.md §87) : un second sous-titre, dessiné au-dessus du principal.
 * Fourni par l'hôte qui sait le dessiner — le lecteur natif et le lecteur serveur. Absent (Chromecast,
 * mini-lecteur), l'entrée n'existe pas.
 */
export interface SecondSubtitleMenu {
  /** Le second choisi, `null` : un seul sous-titre. */
  currentId: number | null;
  onChange: (id: number | null) => void;
  /**
   * Les pistes proposées comme second, quand l'hôte doit en retirer (une génération en cours ailleurs
   * que celle du principal : une seule génération s'affiche à la fois). Absent : toutes celles du
   * menu, moins le principal.
   */
  tracks?: Track[];
  /**
   * Son décalage, quand c'est l'hôte qui dessine (lecteur natif) — comme `subtitleOffset`. Absent, les
   * commandes déplacent les lignes de sa piste `<track>`, comme pour le principal du lecteur serveur.
   */
  offset?: { seconds: number; onShift: (deltaSeconds: number) => void };
  /** « Générer — <langue> » comme second (lecteur natif, §70) : absent, rien à générer. */
  generation?: { targets: { code: string; label: string }[]; busy: boolean; onGenerate: (code: string) => void };
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
  /**
   * Le logo du titre (celui de la série pour un épisode), montré à la place du titre écrit quand
   * il existe et qu'il est chargé — voir `PlayerTitle`. Absent : le titre écrit, comme avant.
   */
  logoUrl?: string | null;
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
   * Le bouton Chromecast (DECISIONS.md §64), quand l'hôte peut le proposer : un navigateur qui sait
   * émettre, un compte qui y a droit, au moins un récepteur sur le réseau. `onRequest` est appelé
   * **dans le geste** : Chrome n'ouvre sa liste des récepteurs que pendant un appui. Absent, rien de
   * ce qui suit ne change.
   */
  chromecast?: { active: boolean; onRequest: () => void };
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
  /** Voir `SecondSubtitleMenu`. */
  secondSubtitle?: SecondSubtitleMenu;
  hidden: boolean;
  loading: boolean;
  /**
   * La lecture reprend après une pause et la première image n'est pas encore là (lecteur natif).
   * Ce n'est pas un chargement : les commandes restent, lecture/pause passe aussitôt sur pause et
   * reste touchable — remettre en pause tout de suite marche —, un anneau tourne autour du
   * bouton, et le fil du haut court en paysage (04/10/2026). Avant, la reprise empruntait le
   * chargement : les boutons du centre disparaissaient sous une roue.
   */
  resuming?: boolean;
  /**
   * L'ouverture de la lecture couvre encore l'écran, ou le premier départ n'a pas dépassé sa grâce
   * (DECISIONS.md §60) : ni roue ni fil. Ils montaient sur l'événement `waiting` de l'élément, sans
   * délai, et un départ de quelques centaines de millisecondes en faisait clignoter un (10/10/2026).
   * Décidé par l'hôte, qui connaît l'ouverture ; les vraies attentes en cours de film les gardent.
   */
  openingQuiet?: boolean;
  introSkip: { start: number; end: number } | null;
  /** Le « précédemment dans… » : même bouton que l'intro, autre libellé (DECISIONS.md §65). */
  recapSkip?: { start: number; end: number } | null;
  creditsStart: number | null;
  nextEpisode: { itemId: string; title: string } | null;
  onAdvance: () => void;
  /**
   * Lancer un autre épisode de la série depuis le menu « Épisodes » (19/10/2026) — le même passage
   * que l'épisode suivant, chez le lecteur. Absent (scène, banc d'essai) : pas de bouton.
   */
  onPlayEpisode?: (episode: { itemId: string; title: string; resumeAt: number }) => void;
  /**
   * Chaque saut demandé par le spectateur, à la position visée — avant que l'élément ne l'ait
   * atteinte. Un lecteur qui se reconstruit (changement de piste) part de là plutôt que de la
   * dernière position lue : sinon un saut encore en chargement suivi d'un changement de piste
   * ramenait le film là où il était avant le saut (22/09/2026).
   */
  onSeekRequest?: (seconds: number) => void;
  /**
   * Où en est le film selon le lecteur — la cible d'un saut pas encore atteint, la position d'un
   * lecteur qui se reconstruit. Les sauts relatifs (±10 s, flèches) partent de là : juste après un
   * changement de piste ou de « Améliorer les dialogues », l'élément neuf est encore à 0 le temps
   * d'atterrir, et −10 s ramenait Tenet au début (iPhone, 11/10/2026). Absent : l'élément.
   */
  positionNow?: () => number;
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
  /**
   * « Améliorer les dialogues » (bêta, `dialogueEnhance.ts`), proposé à tous les comptes sur le
   * lecteur natif. Absent dans le lecteur serveur, où le son ne passe pas par nous. `applies` faux : la piste qui
   * joue est de celles que le traitement ne prend pas (un AAC 5.1 copié, un MP3), et le menu le dit.
   */
  dialogue?: { mode: DialogueMode; applies: boolean; onChange: (mode: DialogueMode) => void };
  /** Voir `SubtitleGenerationMenu`. Lecteur natif seulement. */
  subtitleGeneration?: SubtitleGenerationMenu;
  /**
   * Les bords des commandes affichées (px depuis le haut de l'écran pour la rangée du haut, depuis
   * le bas pour celle du bas), `null` quand elles sont cachées : le lecteur natif y pose ses
   * sous-titres juste au-dessus, au lieu d'une hauteur fixe qui couvrait l'image même commandes
   * parties (`subtitleRowStyle`). Les pistes `<track>` du lecteur serveur sont placées par le
   * navigateur et n'en ont pas l'usage.
   */
  onChromeEdges?: (edges: ChromeEdges | null) => void;
}

const NEXT_UP_COUNTDOWN_S = 10;
/** Après un passage à l'épisode suivant, le temps pendant lequel une nouvelle demande est un doublon. */
const ADVANCE_GUARD_MS = 2000;
/** « Améliorer les dialogues » : les trois choix du sous-menu, avec les mots et dans l'ordre de
 *  l'Apple TV (Désactivé / Améliorer / Améliorer davantage — demande de Louis, 11/10/2026). */
const DIALOGUE_CHOICES: { mode: DialogueMode; label: string }[] = [
  { mode: "off", label: "player.dialogue.off" },
  { mode: "on", label: "player.dialogue.enhance" },
  { mode: "strong", label: "player.dialogue.further" },
];
/** Combien de temps la confirmation de diffusion reste dépliée sans qu'on y touche. */
const CAST_CONFIRM_MS = 4000;
/**
 * Où se posent les invites flottantes (« Passer l'intro », l'épisode suivant, la minuterie) : au-dessus
 * du bas des commandes — titre, pilule et barre —, pour ne jamais les couvrir quand elles sont là.
 */
/**
 * ±10 s : la flèche fait un tour autour du « 10 », qui reste immobile — un tour un peu trop loin,
 * puis posé. Joué au clic, après le geste liquide du bouton, sur la flèche seule.
 */
function spinSkip(button: HTMLElement, turn: -1 | 1) {
  const arrow = button.querySelector<HTMLElement>(".player-skip-arrow");
  if (!arrow || typeof arrow.animate !== "function" || prefersReducedMotion()) return;
  for (const a of arrow.getAnimations()) a.cancel();
  arrow.animate(
    [{ transform: "rotate(0deg)" }, { transform: `rotate(${turn * 380}deg)`, offset: 0.7 }, { transform: `rotate(${turn * 360}deg)` }],
    { duration: 520, easing: "cubic-bezier(0.3, 0.7, 0.4, 1)" },
  );
}

// Le bord bas des commandes : 8 px au-dessus de la barre d'accueil d'iOS (ou 1,5 rem sans elle).
// Collée au bord sûr, la barre de progression se trouvait sous le pouce qui allait chercher le
// geste du système, et l'un prenait l'autre (02/10/2026). Partagé par tout ce qui se place au-dessus
// de la rangée du bas, pour que l'écart reste le même partout.
const BOTTOM_EDGE = "max(1.5rem, calc(env(safe-area-inset-bottom) + 0.5rem))";
const PROMPT_BOTTOM = `calc(${BOTTOM_EDGE} + 8.5rem)`;
const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** Masqués, les contrôles ne suivent la position qu'à ce rythme — voir `visibleRef`. */
const HIDDEN_UPDATE_MS = 1000;
/** En lecture, le plus long qu'un `progress` attende le tic de la position — voir `readBufferedEnd`. */
const BUFFERED_LATE_MS = 1500;

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
/** Le titre de chaque vue des menus, et son icône — celle du bouton qui l'ouvre. */
const MENU_TITLES: Record<string, string> = {
  speed: "player.speed",
  audio: "player.audio",
  subtitles: "player.subtitles",
  subtitleStyle: "player.subtitleStyle.title",
  subtitleGen: "player.subtitleGen.generate",
  subtitleGenOther: "player.subtitleGen.generate",
  dual: "player.dualSubtitles.title",
  dualPrimary: "player.dualSubtitles.primary",
  dualSecond: "player.dualSubtitles.second",
  more: "player.moreOptions",
  episodes: "player.episodes.title",
  chapters: "player.chapters",
  sleep: "player.sleep.title",
  hdrCap: "player.hdrCap.title",
};
const MENU_ICONS: Record<string, React.ReactNode> = {
  speed: <Gauge size={20} />,
  audio: <AudioLines size={20} />,
  subtitles: <Captions size={20} />,
  subtitleStyle: <Captions size={20} />,
  subtitleGen: <Languages size={20} />,
  subtitleGenOther: <Languages size={20} />,
  dual: <Captions size={20} />,
  dualPrimary: <Captions size={20} />,
  dualSecond: <Captions size={20} />,
  more: <EllipsisVertical size={20} />,
  episodes: <Layers size={20} />,
  chapters: <ListVideo size={20} />,
  sleep: <Timer size={20} />,
  hdrCap: <Sun size={20} />,
};

function SkipGlyph({ direction }: { direction: "back" | "forward" }) {
  const Arrow = direction === "back" ? RotateCcw : RotateCw;
  // À la taille du bouton : 26 px dans un bouton de 48, 30 dans un de 56 — le chiffre suit, ≈ 10 puis
  // 12 px. Fixé à 22 px, il ne faisait que 8 px au bureau, à peine lisible (02/10/2026).
  return (
    <span className="relative block h-[26px] w-[26px] sm:h-[30px] sm:w-[30px]">
      <Arrow size="100%" aria-hidden className="player-skip-arrow absolute inset-0" />
      {/* Centré sur le cercle de la flèche (12, 12 sur 24) ; la ligne de base un tiers de corps plus bas. */}
      <svg viewBox="0 0 24 24" aria-hidden className="absolute inset-0 h-full w-full">
        <text x="12" y="15.3" textAnchor="middle" fontSize="9.6" fontWeight="700" fill="currentColor" fontFamily="inherit" letterSpacing="-0.3">
          10
        </text>
      </svg>
    </span>
  );
}

export function PlayerControls({
  videoRef,
  containerRef,
  itemId,
  title,
  logoUrl = null,
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
  secondSubtitle,
  hidden,
  loading,
  resuming = false,
  openingQuiet = false,
  introSkip,
  recapSkip = null,
  creditsStart,
  nextEpisode,
  onAdvance,
  onPlayEpisode,
  onCastRequest,
  chromecast,
  onCastReturn,
  castActive,
  onSeekRequest,
  positionNow,
  suspended = false,
  hdrCap,
  frameFit,
  dialogue,
  subtitleGeneration,
  onChromeEdges,
}: PlayerControlsProps) {
  const t = useT();
  // La série d'un épisode et le droit de télécharger (19/10/2026) — voir `usePlayerItem`.
  const playerItem = usePlayerItem(itemId);
  const episodesSeriesId = onPlayEpisode ? (playerItem?.seriesId ?? null) : null;
  // Au bureau seulement — `PlayerDownloadRow` en décide (§107).
  const downloadable = !!playerItem?.download;
  const [playing, setPlaying] = useState(false);
  /**
   * Ce que l'appui vient de demander, montré tout de suite (10/10/2026) : le triangle ne devenait
   * pause qu'à l'évènement `play`/`pause` de l'élément, un battement plus tard — davantage sur
   * WebKit, où `play()` attend la sortie audio. Effacé dès que l'élément confirme, ou au bout d'une
   * seconde et demie s'il ne le fait jamais (lecture refusée) : l'icône revient alors à la vérité.
   */
  const [intended, setIntended] = useState<boolean | null>(null);
  const intendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownPlaying = intended ?? playing;
  useEffect(() => {
    const timers = intendTimer;
    return () => {
      if (timers.current) clearTimeout(timers.current);
    };
  }, []);
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
  const topRowRef = useRef<HTMLDivElement>(null);
  const bottomRowRef = useRef<HTMLDivElement>(null);
  /**
   * Ce que les commandes occupent, mesuré plutôt que supposé : la rangée du bas va de 110 px sur un
   * téléphone à plus de 150 au bureau, selon le titre (logo ou texte, une ou deux lignes) et la zone
   * sûre. Remesurée quand une rangée change de taille (rotation, titre chargé) ; cachées, `null`.
   * Les rangées glissent de 4 px en apparaissant (`translate-y-1`) : la mesure prise pendant ce
   * glissement est fausse d'autant au plus, et la suivante la corrige.
   */
  useEffect(() => {
    if (!onChromeEdges) return;
    if (!visible || hidden) {
      onChromeEdges(null);
      return;
    }
    const root = liquidRootRef.current;
    const top = topRowRef.current;
    const bottom = bottomRowRef.current;
    if (!root || !top || !bottom) return;
    const measure = () => {
      const area = root.getBoundingClientRect();
      onChromeEdges({
        top: top.getBoundingClientRect().bottom - area.top,
        bottom: area.bottom - bottom.getBoundingClientRect().top,
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const el of [root, top, bottom]) observer.observe(el);
    return () => observer.disconnect();
  }, [visible, hidden, onChromeEdges]);
  // Démonté (fermeture, passage au mini-lecteur), il n'y a plus de commandes à éviter.
  useEffect(() => () => onChromeEdges?.(null), [onChromeEdges]);
  const [menu, setMenu] = useState<null | "audio" | "subtitles" | "speed" | "chapters" | "subtitleStyle" | "hdrCap" | "sleep" | "dialogue" | "subtitleGen" | "subtitleGenOther" | "dual" | "dualPrimary" | "dualSecond" | "quality" | "episodes" | "more">(null);
  // Cachées par un écran d'erreur, les commandes restent montées (le lecteur serveur garde l'élément
  // pour « Réessayer ») et gardaient leur menu : le nouvel essai les rendait menu ouvert par-dessus le
  // film qui repart — et un menu ouvert suspend leur disparition, elles ne partaient plus (chasse
  // aux défauts du 13/10/2026). Refermé au moment où elles se cachent, pendant le rendu.
  const [menuHiddenSeen, setMenuHiddenSeen] = useState(hidden);
  if (hidden !== menuHiddenSeen) {
    setMenuHiddenSeen(hidden);
    if (hidden) setMenu(null);
  }
  // « Qualité » (§78) : Automatique ou Originale, par compte et par appareil.
  const quality = usePlaybackQuality();
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
  // Le verre liquide (DECISIONS.md §45) : la pilule des réglages, d'où naissent les menus.
  const settingsPillRef = useRef<HTMLDivElement>(null);
  const liquidRootRef = useRef<HTMLDivElement>(null);
  // Le geste liquide, branché une fois par délégation sur tout ce qui porte `data-liquid` : les
  // pilules, le rond seul, les boutons du centre. Il ne remplace pas le clic natif — voir
  // `createLiquidPress` —, il ne fait qu'y ajouter le gonflement et l'étirement.
  useEffect(() => {
    const root = liquidRootRef.current;
    if (!root) return;
    const press = createLiquidPress({ targets: ".player-pill-btn, .player-center-btn, .player-capsule" });
    // Les menus (`data-liquid-soft`) bougent au doigt comme le reste — gonflement, étirement,
    // rebond —, mais ne touchent à aucun clic : leurs lignes gardent le leur, et la liste défile.
    // Un menu ne gonfle pas : c'est une surface qu'on lit, et tout gonflement y paraissait étrange
    // (04/10/2026, deux réglages essayés). Il ne s'étire que lorsque le doigt sort de ses bords,
    // reste étiré tant que le doigt le tient, et revient sur le ressort au relâchement.
    const soft = createLiquidPress({
      targets: "[data-liquid-target]",
      redirect: false,
      pull: "outside",
      strength: 0.6,
      swell: () => 1,
    });
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      const menu = target?.closest?.<HTMLElement>("[data-liquid-soft]");
      if (menu && root.contains(menu)) return soft.down(e, menu);
      const surface = target?.closest?.<HTMLElement>("[data-liquid]");
      if (surface && root.contains(surface)) press.down(e, surface);
    };
    root.addEventListener("pointerdown", onDown);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      press.dispose();
      soft.dispose();
    };
    // Rebranché quand les commandes réapparaissent : cachées (`hidden`), leur racine n'existe pas.
  }, [hidden]);
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
  // Un menu ouvert se referme dès qu'un doigt se pose ailleurs, et non au clic qui suit le
  // relâchement : le retour part tout de suite, d'où en est l'ouverture (demandé le 07/10/2026).
  // Le clic qui suit est retenu — il ne fait que refermer, comme les menus du système : sans cela,
  // il cachait les commandes (`toggleControls`, le menu étant déjà fermé) ou actionnait le bouton
  // dessous. La pilule des réglages est laissée à ses propres clics, qui basculent d'un menu à
  // l'autre ou referment celui-ci.
  useEffect(() => {
    if (menu === null) return;
    const outside = (target: EventTarget | null) =>
      target instanceof Node && !menuRef.current?.contains(target) && !settingsPillRef.current?.contains(target);
    let swallowTimer: ReturnType<typeof setTimeout> | null = null;
    const swallow = (e: MouseEvent) => {
      document.removeEventListener("click", swallow, true);
      if (swallowTimer) clearTimeout(swallowTimer);
      if (outside(e.target)) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || !outside(e.target)) return;
      document.addEventListener("click", swallow, true);
      swallowTimer = setTimeout(() => document.removeEventListener("click", swallow, true), 600);
      setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      // Le clic retenu doit survivre à la fermeture qu'il suit : on ne le débranche pas ici, sa
      // minuterie s'en charge.
    };
  }, [menu]);
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
  // Le second a son propre décalage (§87) : deux pistes ne sont pas désynchronisées de la même façon.
  const secondId = secondSubtitle?.currentId ?? null;
  const secondOffset = secondSubtitle?.offset?.seconds ?? (secondId === null ? 0 : (cueOffsets[secondId] ?? 0));
  /** Ce qu'on peut prendre comme second : toute piste du menu sauf le principal. */
  const secondChoices = (secondSubtitle?.tracks ?? subtitleTracks).filter((tr) => tr.id !== currentSubtitleId);
  const labelOf = (id: number | null) => (id === null ? t("player.none") : (subtitleTracks.find((tr) => tr.id === id)?.label ?? t("player.none")));
  /**
   * Choisir le principal depuis « Deux sous-titres ». Prendre le second comme principal les échange :
   * l'hôte retire d'abord le second devenu principal, puis reçoit l'ancien principal comme second.
   */
  function pickPrimary(id: number) {
    const previous = currentSubtitleId;
    if (id === previous) return;
    onChangeSubtitle(id);
    if (secondSubtitle && id === secondSubtitle.currentId) secondSubtitle.onChange(previous);
  }
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
  /**
   * Passer à l'épisode suivant — une fois par geste, par tous les chemins : le bouton de la pilule, la
   * carte du générique, son décompte, « Continuer » et la touche « suivant » de l'écran verrouillé.
   *
   * Le lecteur serveur enchaîne les épisodes sans remonter ces commandes : le rendu qui suit le premier
   * appui propose déjà l'épisode d'après sous le même bouton, et un double-tap — ou un appui répété
   * parce que rien ne bougeait encore sur une connexion lente, ou le décompte tombant à zéro sous le
   * doigt qui touchait « Lire maintenant » — enjambait un épisode (chasse aux défauts du 13/10/2026).
   * Une seconde demande dans les `ADVANCE_GUARD_MS` qui suivent la première est ignorée.
   */
  const lastAdvanceAtRef = useRef(Number.NEGATIVE_INFINITY);
  const requestAdvance = useCallback((): boolean => {
    const now = performance.now();
    if (now - lastAdvanceAtRef.current < ADVANCE_GUARD_MS) return false;
    lastAdvanceAtRef.current = now;
    onAdvance();
    return true;
  }, [onAdvance]);
  useEffect(() => {
    if (!showNextUp || nextUpCountdown !== 0 || askStillThere) return;
    // Déjà demandé à la main dans l'instant : ce n'est pas un enchaînement automatique de plus.
    if (performance.now() - lastAdvanceAtRef.current < ADVANCE_GUARD_MS) return;
    noteAutoAdvance();
    requestAdvance();
  }, [showNextUp, nextUpCountdown, askStillThere, requestAdvance]);

  // « Passer l'intro » et « Passer le récap » : un seul bouton, dont la décision vit dans `activeSkip`.
  const skipNow = activeSkip(currentTime, introSkip, recapSkip);

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
    const onPlay = () => {
      setPlaying(true);
      setIntended(null);
    };
    const onPause = () => {
      setPlaying(false);
      setIntended(null);
      // La position exacte à l'arrêt, que le rythme des contrôles masqués ait laissé passer la
      // dernière ou non — voir `onTime`. Pas pendant qu'on tire la barre : c'est elle qui dit l'instant.
      if (!seekingRef.current) setCurrentTime(video.currentTime);
      // And anything already on its way is called off: the pause may well arrive first.
      if (seekSpinner.current) clearTimeout(seekSpinner.current);
      seekSpinner.current = null;
      setBuffering(false);
    };
    // The range containing currentTime (not just the last one) — a rewind past hls.js's
    // in-memory buffer can leave an earlier, already-downloaded range that's no longer the
    // last entry in video.buffered once new data has since loaded ahead of the original spot.
    //
    // Lue au plus une fois par seconde, et en lecture dans le rendu du tic de la position plutôt que
    // dans le sien (`onTime`). Avec une source MediaSource, chaque ajout de données fait tirer
    // `progress` : au banc du 02/10/2026, 4,5 rendus de tout ce composant par seconde commandes
    // affichées au repos, et 2 masquées — pour une jauge qui avance d'un quart de pixel par ajout.
    // Un `progress` que le tic n'a pas repris (une attente : l'horloge ne bouge plus ; une pause :
    // il n'y a plus de tic) est lu par le minuteur, au plus tard `BUFFERED_LATE_MS` après la
    // dernière lecture — la jauge reste ce qui dit, pendant une attente, que ça charge.
    let bufferedAt = -Infinity;
    let bufferedTimer: ReturnType<typeof setTimeout> | null = null;
    const readBufferedEnd = () => {
      if (bufferedTimer) clearTimeout(bufferedTimer);
      bufferedTimer = null;
      bufferedAt = performance.now();
      const ranges = video.buffered;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= video.currentTime && video.currentTime <= ranges.end(i)) {
          setBufferedEnd(ranges.end(i));
          return;
        }
      }
      setBufferedEnd(ranges.length > 0 ? ranges.end(ranges.length - 1) : 0);
    };
    // Suppressed while dragging the seek bar — otherwise the real (not-yet-seeked) playback
    // position keeps overwriting the dragged thumb position on every tick, fighting the user's
    // own drag mid-gesture.
    let timeAt = 0;
    let shownSecond = -1;
    const onTime = () => {
      if (seekingRef.current) return;
      const now = performance.now();
      // Jamais la dernière : à l'arrêt ou à la fin, aucune autre ne viendra. La fin de fichier
      // tombait à moins d'une seconde de la précédente, était sautée, et l'écran de fin (« Revoir »,
      // l'épisode suivant — `atEnd`) n'apparaissait pas contrôles masqués (chasse aux défauts du 28/09).
      if (!visibleRef.current && now - timeAt < HIDDEN_UPDATE_MS && !video.paused && !video.ended) return;
      // Affichés aussi, une fois par seconde affichée et pas à chaque `timeupdate` (~4/s) : les deux
      // temps ne changent qu'à la seconde, et la barre avance d'un quart de pixel entre deux — un
      // rendu de tout ce composant pour rien, trois fois sur quatre, pendant qu'on touche aux boutons
      // (revue des performances du 02/10/2026).
      const second = Math.floor(video.currentTime);
      if (visibleRef.current && second === shownSecond && !video.paused && !video.ended) return;
      shownSecond = second;
      timeAt = now;
      setCurrentTime(video.currentTime);
      // La jauge du chargé prend ce même tic, dans le même rendu — voir `readBufferedEnd`.
      readBufferedEnd();
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
    const onProgress = () => {
      if (bufferedTimer) return;
      // En lecture, le tic suivant arrive dans la seconde (`timeupdate` tire toutes les ~250 ms) et
      // emporte la jauge avec lui : le minuteur n'attend donc pas une seconde mais une et demie, pour
      // ne jamais passer avant lui. À l'arrêt, il n'y a pas de tic : une seconde suffit.
      const wait = bufferedAt + (video.paused ? HIDDEN_UPDATE_MS : BUFFERED_LATE_MS) - performance.now();
      if (wait <= 0) readBufferedEnd();
      else bufferedTimer = setTimeout(readBufferedEnd, wait);
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
      if (bufferedTimer) clearTimeout(bufferedTimer);
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
  // Cachées (`hidden`) comptent comme suspendues : le lecteur serveur cache ses commandes sous son
  // écran d'erreur mais garde l'élément monté pour « Réessayer », et l'écouteur clavier, posé sur la
  // fenêtre, survit au `return null`. Espace relançait l'élément en panne sous l'écran — et, retenu
  // au `keydown`, n'activait plus le bouton « Réessayer » qui avait le focus ; les flèches
  // déplaçaient la position d'où il allait reprendre (chasse aux défauts du 13/10/2026).
  const suspendedRef = useRef(suspended || hidden);
  useEffect(() => {
    suspendedRef.current = suspended || hidden;
  }, [suspended, hidden]);
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
  // Lu par la minuterie de masquage : pendant une reprise, elle attend la première image.
  const resumingRef = useRef(resuming);
  useEffect(() => {
    resumingRef.current = resuming;
  }, [resuming]);
  const showControls = useCallback(
    (delayMs: number = 3000) => {
      // Un geste vaut présence, et c'est ici qu'ils passent tous — un clic, une touche, un
      // pointeur qui bouge. Quelqu'un qui vient de bouger n'a pas à répondre trois épisodes plus
      // tard à une question qui demande s'il est là.
      noteViewerPresent();
      setVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (playingRef.current && !menuOpenRef.current) {
        const hide = () => {
          // Pas pendant une reprise : la minuterie compte depuis la première image, pas depuis
          // l'appui — les commandes ne partent pas pendant que le film n'a pas encore repris.
          if (resumingRef.current) {
            hideTimer.current = setTimeout(hide, delayMs);
            return;
          }
          setVisible(false);
          setMenu(null);
        };
        hideTimer.current = setTimeout(hide, delayMs);
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

  /**
   * Le type du dernier appui posé sur le lecteur — la source de vérité pour `click` et `dblclick` :
   * `dblclick` ne porte jamais de type, et le `click` d'un tap au doigt se dit « mouse » sur WebKit
   * iOS. Le `pointerdown` précède toujours le `click` et dit juste.
   */
  const lastPointerTypeRef = useRef("");
  /**
   * L'appui a-t-il commencé sur l'image vide ? Un bouton appuyé, l'effet liquide suivi du curseur,
   * puis le bouton relâché hors de lui : le `click` part sur l'ancêtre commun — la surface — et
   * mettait en pause (11/10/2026). À la souris, seul un clic appuyé ET relâché sur l'image compte.
   */
  const downOnSurfaceRef = useRef(false);

  /**
   * Un clic sur l'image (11/10/2026, DECISIONS.md §65) : à la souris, lecture/pause — comme YouTube,
   * Netflix ou Jellyfin dans un navigateur ; au doigt et au stylet, afficher/masquer, comme avant et
   * comme partout au doigt (une pause à chaque toucher serait pénible). Voir `surfaceAction`.
   *
   * Basculé aussitôt, sans attendre de savoir si un second clic suit : le simple clic est de loin le
   * geste le plus fréquent, et le retarder de 250 ms se sentirait à chaque pause. Le double-clic
   * paie à la place : son premier clic met en pause, le second relance, et le `dblclick` passe en
   * plein écran — un arrêt de l'ordre du quart de seconde, ce que fait YouTube.
   */
  function onSurfaceClick(e: React.MouseEvent<HTMLDivElement>) {
    // L'appui d'abord, le `click` seulement à défaut : WebKit iOS déclare « mouse » sur le `click`
    // d'un tap au doigt, alors que son `pointerdown` dit bien « touch » — lu sur le `click`, chaque
    // toucher de l'image mettait le film en pause au lieu d'afficher les commandes (11/10/2026).
    const pointerType = lastPointerTypeRef.current || (e.nativeEvent as MouseEvent & { pointerType?: string }).pointerType || "";
    // Relâché sur l'image après un appui ailleurs (un bouton, une pilule) : ni pause ni rien.
    if (pointerType === "mouse" && !downOnSurfaceRef.current) return;
    const action = surfaceAction(pointerType, e.detail, isEmptySurface(e.target, e.currentTarget));
    if (action === "toggle-controls") {
      toggleControls();
      return;
    }
    if (action === "ignore") return;
    if (menu !== null) {
      // Un menu ouvert se referme d'abord ; le clic qui le referme ne touche pas à la lecture.
      setMenu(null);
      showControls();
      return;
    }
    togglePlay();
    showControls();
  }

  function onSurfaceDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (lastPointerTypeRef.current !== "mouse" || !fullscreenSupported) return;
    if (!downOnSurfaceRef.current || !isEmptySurface(e.target, e.currentTarget)) return;
    void toggleFullscreen();
  }

  /**
   * La souris quitte la fenêtre : les commandes partent aussitôt, sans attendre leurs trois secondes
   * (demandé le 11/10/2026) — personne ne les regarde plus. Seulement pendant la lecture, sans menu
   * ouvert ni glisser sur la barre, et jamais quand le clavier a le focus dans les commandes : on
   * les parcourt alors à la télécommande ou au clavier. Un `pointerout` sans destination
   * (`relatedTarget` nul) est la sortie de la page ; un doigt ne le déclenche jamais (`pointerType`).
   */
  /**
   * Si une sortie de la fenêtre doit cacher les commandes maintenant. Lue aussi par le `mouseleave`
   * de la barre de progression, qui suit le `pointerout` quand la souris sort par le bas : il les
   * rappelait pour cinq secondes juste après qu'elles étaient parties (chasse aux défauts, 11/10/2026).
   */
  function windowExitHides(): boolean {
    if (!playingRef.current || menuOpenRef.current || seekingRef.current || suspendedRef.current) return false;
    return !keyboardFocusWithin(liquidRootRef.current);
  }
  const windowExitHidesRef = useRef(windowExitHides);
  useEffect(() => {
    windowExitHidesRef.current = windowExitHides;
  });

  useEffect(() => {
    function onPointerOut(e: PointerEvent) {
      if (e.pointerType !== "mouse" || e.relatedTarget !== null) return;
      if (!windowExitHidesRef.current()) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setVisible(false);
    }
    window.addEventListener("pointerout", onPointerOut);
    return () => window.removeEventListener("pointerout", onPointerOut);
  }, []);

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
    const wantsPlay = video.paused;
    setIntended(wantsPlay);
    if (intendTimer.current) clearTimeout(intendTimer.current);
    intendTimer.current = setTimeout(() => setIntended(null), 1500);
    if (wantsPlay) {
      const started = video.play();
      // Refusée (iOS sans geste récent, source perdue) : l'icône revient aussitôt à l'arrêt.
      if (started && typeof started.catch === "function") started.catch(() => setIntended(null));
    } else video.pause();
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
    const from = positionNow ? positionNow() : video.currentTime;
    const limit = video.duration || duration || from;
    const target = Math.min(Math.max(0, from + deltaSeconds), limit);
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
  //
  // Essayé le 08/10/2026 : chauffer au premier survol seulement (2,4 Mo de moins par ouverture).
  // Rendu le jour même — une à deux secondes sans aperçu au premier contact, exactement ce que
  // ce préchargement existe pour éviter.
  //
  // **Après la première image, la planche de la position d'abord, puis une à une** (15/10/2026,
  // LECTEUR-6). Toutes partaient ensemble au montage, avant le film : sur un lien à 2 Mbit/s, neuf
  // planches (≈ 7 Mo) occupaient le lien de 13 à 39 s, l'init du film n'était demandée qu'à 30 s, la
  // première image arrivait à 42 s — le lien suffisait au film, pas au film plus les vignettes. Le
  // préchargement reste automatique (ce n'est pas le « premier toucher » écarté le 08/10) ; seul son
  // moment change : dès que l'élément joue (`playing`), ou qu'il a de quoi jouer hors d'un saut
  // (`readyState` ≥ 3 — un film mis en pause à l'ouverture, ou un composant remonté sur un film qui
  // joue). Pas sur le `canplay` de la position 0 que le lecteur serveur a avant de sauter à la reprise :
  // `seeking` l'écarte, la planche choisie est celle de l'endroit où l'image arrive. Ensuite la plus
  // proche d'abord, une requête à la fois — sur un bon lien elles sont toutes là en une seconde ou
  // deux, bien avant le premier geste.
  useEffect(() => {
    if (!trickplay) return;
    const perTile = trickplay.tileWidth * trickplay.tileHeight;
    const tileCount = Math.ceil(trickplay.thumbnailCount / perTile);
    if (!(tileCount > 0)) return;
    const video = videoRef.current;
    let cancelled = false;
    let started = false;
    const loadFrom = (order: number[]) => {
      const next = order.shift();
      if (cancelled || next === undefined) return;
      const img = new Image();
      // Échouée ou chargée, la suivante : l'aperçu demandera lui-même une planche manquante.
      img.onload = img.onerror = () => loadFrom(order);
      img.src = `/api/jellyfin/trickplay/tile?itemId=${itemId}&width=${trickplay.width}&index=${next}`;
    };
    const begin = () => {
      if (started || cancelled) return;
      started = true;
      detach();
      const position = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const first = trickplayTileIndex(trickplay, position, tileCount);
      loadFrom(trickplayTileOrder(first, tileCount));
    };
    const ifReady = () => {
      if (video && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !video.seeking) begin();
    };
    const detach = () => {
      video?.removeEventListener("playing", begin);
      video?.removeEventListener("canplay", ifReady);
      video?.removeEventListener("seeked", ifReady);
    };
    if (!video) {
      begin();
    } else {
      video.addEventListener("playing", begin);
      video.addEventListener("canplay", ifReady);
      video.addEventListener("seeked", ifReady);
      ifReady();
    }
    return () => {
      cancelled = true;
      detach();
    };
  }, [trickplay, itemId, videoRef]);

  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
          onNext: nextEpisode ? () => void requestAdvance() : null,
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
  //
  // La largeur de l'écran est tenue à jour au redimensionnement, jamais lue pendant le rendu : lire
  // `window.innerWidth` force une mise en page synchrone quand la page a changé depuis la dernière
  // image — à chaque rendu, donc à chaque seconde affichée et à chaque appui. Au banc du 02/10/2026,
  // en paysage iPhone émulé : 14 mises en page forcées pour 16 appuis, toutes venues d'ici.
  const previewScale = trickplay && viewportWidth > 0 ? Math.min(1, (viewportWidth * 0.35) / trickplay.width) : 1;
  const previewDisplayWidth = trickplay ? Math.round(trickplay.width * previewScale) : 160;
  const previewDisplayHeight = trickplay ? Math.round(trickplay.height * previewScale) : 90;

  // Shared by the seek-bar hover preview and the chapters menu thumbnails below — same sprite
  // lookup math, just called at a different `time`. Plain function, not useCallback: same
  // reasoning as updatePreview above (nothing needs referential stability, and the React
  // Compiler's memoization check gets confused by unrelated nearby state).
  function trickplayTileAt(time: number): { url: string; bgX: number; bgY: number } | null {
    // Le calcul est partagé avec les répliques de la recherche (`trickplayTile.ts`, §88).
    return trickplay ? sharedTrickplayTileAt(trickplay, itemId, time) : null;
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
    if (currentSubtitleId !== null) shiftCues(currentSubtitleId, deltaSeconds);
  }

  /** Le décalage du second (§87) : par l'hôte qui le dessine, sinon sur les lignes de sa piste. */
  function shiftSecond(deltaSeconds: number) {
    if (secondSubtitle?.offset) {
      secondSubtitle.offset.onShift(deltaSeconds);
      return;
    }
    if (secondId !== null) shiftCues(secondId, deltaSeconds);
  }

  function shiftCues(id: number, deltaSeconds: number) {
    const video = videoRef.current;
    if (!video) return;
    const position = subtitleTracks.findIndex((t) => t.id === id);
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
    setCueOffsets((all) => ({ ...all, [id]: Math.round(((all[id] ?? 0) + deltaSeconds) * 10) / 10 }));
  }

  /**
   * Le clavier du lecteur : un jeu fixe, et rien d'autre (demandé le 04/10/2026).
   *
   * Espace et K lisent ou mettent en pause, ← et → reculent ou avancent de dix secondes — où que
   * soit le focus. Le reste se fait à la souris ou au doigt. Le clavier circulait avant entre les
   * commandes (flèches de rangée en rangée, Échap, M, F, ↑/↓ pour le son), et la barre d'espace
   * cédait la place au bouton qui avait le focus : or un clic de souris *donne* le focus au bouton
   * cliqué, si bien qu'après avoir ouvert les sous-titres à la souris, Espace les rouvrait au lieu
   * de mettre en pause. Les boutons du lecteur ne prennent plus le focus à la souris (voir
   * `onMouseDown` sur la racine), et Espace n'active plus jamais un bouton.
   */
  // Les gestes du clavier lus au moment de la touche : `skip` dépend de `onSeekRequest`, qui peut
  // changer d'un rendu à l'autre, et l'écouteur, lui, n'est posé qu'une fois.
  const keyActionsRef = useRef({ togglePlay, skip });
  useEffect(() => {
    keyActionsRef.current = { togglePlay, skip };
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (suspendedRef.current) return;
      // Ctrl+F cherche dans la page, Cmd+← revient en arrière, Alt+↑ appartient au système : aucun
      // n'est un raccourci du lecteur (23/09/2026).
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
      if (e.code === "Space" || e.code === "KeyK") {
        // Empêché au `keydown` : c'est ce qui retient aussi l'activation d'un bouton qui aurait le
        // focus (une espace l'active au relâchement, sauf si l'appui a été empêché).
        e.preventDefault();
        if (e.repeat) return;
        keyActionsRef.current.togglePlay();
        showControls();
        return;
      }
      // Une télécommande (Fire TV, 10/10/2026) ne remplit pas toujours `code` : le nom de la touche,
      // ramené à sa forme moderne (`remoteKeys.ts`), fait foi à côté.
      const key = normalizeKey(e);
      if (key === "MediaPlayPause") {
        e.preventDefault();
        keyActionsRef.current.togglePlay();
        showControls();
        return;
      }
      // Le centre du pavé, quand aucun bouton n'a le focus : lecture / pause, comme l'espace. Sur un
      // bouton focalisé, il garde son rôle — l'activer.
      if (key === "Enter" && (!active || active === document.body || active === document.documentElement)) {
        e.preventDefault();
        if (e.repeat) return;
        keyActionsRef.current.togglePlay();
        showControls();
        return;
      }
      const left = e.code === "ArrowLeft" || key === "ArrowLeft" || key === "MediaRewind";
      const right = e.code === "ArrowRight" || key === "ArrowRight" || key === "MediaFastForward";
      if (left || right) {
        // Y compris sur la barre de progression focalisée : sa propre flèche la décalait d'un pas
        // d'input, sans passer par le saut du lecteur.
        e.preventDefault();
        keyActionsRef.current.skip(right ? 10 : -10);
        showControls();
        return;
      }
      // ↑ ↓ d'une télécommande : faire paraître les commandes, sans rien déplacer d'autre.
      if (key === "ArrowUp" || key === "ArrowDown") showControls();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showControls]);

  if (hidden) return null;

  return (
    <div
      // Commandes cachées pendant la lecture, le curseur s'en va avec elles : il restait planté au
      // milieu de l'image sous Windows (02/10/2026). Le moindre mouvement de souris rappelle les
      // commandes (`onPointerMove`), et le curseur avec. En pause, il reste : on s'attend à agir.
      // Rien à sélectionner dans le lecteur (11/10/2026) : un double-clic pour le plein écran
      // surlignait le titre de l'épisode et le logo. `select-none` s'hérite ; les champs de saisie
      // gardent leur sélection (globals.css, `.player-liquid` et ses champs).
      className={`player-liquid absolute inset-0 z-10 select-none ${!visible && playing ? "cursor-none" : ""}`}
      ref={liquidRootRef}
      onClick={onSurfaceClick}
      onDoubleClick={onSurfaceDoubleClick}
      onPointerDown={(e) => {
        lastPointerTypeRef.current = e.pointerType;
        downOnSurfaceRef.current = isEmptySurface(e.target, e.currentTarget);
      }}
      // Un bouton cliqué à la souris ne garde pas le focus : sinon Espace, qui doit mettre en
      // pause, le réactivait (voir le clavier plus haut). Les curseurs (son, progression) gardent
      // le leur — on les fait glisser.
      onMouseDown={(e) => {
        if ((e.target as Element).closest("button")) e.preventDefault();
        // Le second appui d'un double-clic sur l'image : pas de sélection de mot — la ceinture
        // de `select-none`, pour un moteur qui sélectionnerait quand même.
        else if (e.detail > 1 && isEmptySurface(e.target, e.currentTarget)) e.preventDefault();
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
      {/* Une reprise n'a que le fil (en paysage, voir globals.css) et l'anneau du bouton lecture :
          ni roue au centre, ni boutons retirés. Le fil d'une reprise n'apparaît qu'après un
          instant (`player-wait-late`), pour qu'une reprise immédiate ne fasse rien clignoter. */}
      {(loading || buffering || resuming) && !openingQuiet && (
        <>
          <div
            className={`player-wait-thread pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-white/10 ${
              resuming && !loading && !buffering ? "player-wait-late" : ""
            }`}
          >
            <div className="player-loading-line h-full w-full bg-accent-500" />
          </div>
          {(loading || buffering) && !resuming && (
            <div className="player-wait-wheel pointer-events-none absolute inset-0 z-20 items-center justify-center">
              <Loader2 size={40} className="animate-spin text-white/80" />
            </div>
          )}
        </>
      )}

      {/* Skip-intro and next-up prompts stay visible even when the rest of the
          controls have auto-hidden — they're time-sensitive, not navigation. */}
      {skipNow && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (videoRef.current) {
              onSeekRequest?.(skipNow.end);
              videoRef.current.currentTime = skipNow.end;
            }
          }}
          data-liquid
          className="player-pill pointer-events-auto absolute px-4 py-2.5 text-sm font-medium text-white"
          style={{
            bottom: PROMPT_BOTTOM,
            right: "max(1rem, env(safe-area-inset-right))",
          }}
        >
          {skipNow.kind === "recap" ? t("player.skipRecap") : t("player.skipIntro")}
        </button>
      )}

      {/* Les trente dernières secondes de la minuterie de veille : une ligne, à la place de rien.
          Visible commandes masquées — c'est précisément quand personne ne les regarde qu'elle sert. */}
      {sleepWarning !== null && (
        <div
          data-player-surface-ignore
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
        <div
          // Un clic sur son fond n'est pas un clic sur l'image : il ne met rien en pause derrière.
          data-player-surface-ignore
          className="pointer-events-auto absolute inset-0 z-20 flex flex-col items-center justify-center gap-5 bg-black/80 px-6 text-center">
          <p className="text-lg font-medium text-white">{t("player.stillThere")}</p>
          <p className="max-w-sm text-sm text-slate-400">{t("player.stillThereHint")}</p>
          <button
            type="button"
            onClick={() => {
              noteViewerPresent();
              requestAdvance();
            }}
            className="btn-primary px-6"
          >
            {t("player.stillThereContinue")}
          </button>
        </div>
      )}

      {showNextUp && !askStillThere && nextEpisode && (
        <div
          // Ses boutons ne doivent pas atteindre le fond, dont l'appui montre ou cache les commandes —
          // ni son double-clic le plein écran (`data-player-surface-ignore`, 11/10/2026).
          data-player-surface-ignore
          onClick={(e) => e.stopPropagation()}
          // Le verre des pilules, et une entrée qui rebondit (`glass-pop`) : une carte opaque à part
          // était la dernière surface du lecteur à ne pas en être (04/10/2026).
          className="nav-glass glass-pop pointer-events-auto absolute w-72 max-w-[calc(100vw-2rem)] rounded-[22px] p-4"
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
                requestAdvance();
              }}
              className="btn-primary flex-1 justify-center py-1.5 text-xs"
            >
              {t('player.playNow')}
            </button>
            <button
              onClick={() => setNextUpDismissed(true)}
              // Une icône seule : sans nom, un lecteur d'écran n'annonçait que « bouton » (13/10/2026).
              aria-label={t("common.close")}
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
          `pointer-events-none` avec elles, et l'appui retombe sur le fond, qui les rappelle.
          Le fondu n'est plus porté par ce conteneur mais par chacun de ses éléments (`player-fade`,
          globals.css) : un parent à opacité < 1 isole le fond, et le verre des pilules n'aurait rien
          à flouter pendant le fondu (DECISIONS.md §45). */}
      <div
        className="player-chrome pointer-events-none absolute inset-0 flex flex-col justify-between"
        data-chrome={visible ? "shown" : "hidden"}
      >
        {/* Deux bandes plutôt qu'un dégradé plein écran. Le milieu était transparent mais était
            composité quand même : le compositeur mélange toute la surface du calque, image par
            image, par-dessus une vidéo qui peut être en 4K. Ces deux-là couvrent ce qu'il y a à
            couvrir — le titre en haut, les contrôles en bas — et laissent les quarante pour cent
            du milieu tranquilles. */}
        {/* Plus hauts au bureau, où l'écran l'est aussi. Le bas porte le titre : un palier à mi-hauteur
            le garde lisible sur une image claire, sans voile sur le reste de l'image. */}
        <div className="player-fade pointer-events-none absolute inset-x-0 top-0 h-[140px] bg-gradient-to-b from-black/55 to-transparent lg:h-[180px]" />
        <div className="player-fade pointer-events-none absolute inset-x-0 bottom-0 h-[180px] bg-gradient-to-t from-black/60 via-black/25 to-transparent lg:h-[240px]" />
        {/* En haut : fermer, puis — à distance, pour que le pouce ne prenne pas l'un pour l'autre — la
            pilule de la diffusion et du mini-lecteur ; à droite, le son seul. Le reste est en bas,
            près de la barre, comme sur l'Apple TV. Marges : 16, 24 puis 32 px, plus les bords sûrs
            (encoche en paysage, Dynamic Island en portrait). */}
        <div
          data-player-navgroup="topbar"
          ref={topRowRef}
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
              data-liquid
              className="player-fade player-pill player-pill-btn player-pill-solo shrink-0"
            >
              <X size={24} />
            </button>
            <div ref={castPillRef} data-cast-pill data-liquid className="player-fade player-pill flex min-w-0 items-center p-1">
              {/* Les deux boutons au repos, et la confirmation qui prend leur place : deux segments
                  toujours là, l'un se resserrant pendant que l'autre s'ouvre — la pilule grandit
                  d'un geste au lieu de sauter d'une largeur à l'autre. */}
              <div
                className={`player-pill-seg flex items-center gap-1 ${castConfirm ? "player-pill-seg-closed" : ""}`}
                inert={castConfirm}
                aria-hidden={castConfirm || undefined}
              >
                {chromecast && (
                  <button
                    data-player-nav="chromecast"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Dans le geste même : la liste des récepteurs de Chrome ne s'ouvre qu'ainsi.
                      chromecast.onRequest();
                    }}
                    aria-label={t("player.chromecast.button")}
                    title={t("player.chromecast.button")}
                    data-active={chromecast.active ? "" : undefined}
                    className="player-pill-btn"
                  >
                    <Cast size={22} />
                  </button>
                )}
                {/* Le bouton de diffusion du navigateur (Remote Playback) se tait quand celui du
                    Chromecast est là : deux icônes identiques pour deux chemins, l'un des deux ne
                    menant nulle part sur un flux MediaSource. AirPlay n'est jamais concerné — il
                    n'existe pas là où le Chromecast se propose. */}
                {castSupported && !(chromecast && castKind === "remote") && (
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
                    <Cast size={22} />
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
                  <PictureInPicture2 size={22} />
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
              au clavier (`.player-volume`, globals.css) — à gauche du bouton, qui reste sous le
              pointeur (LECTEUR-13, 15/10/2026) ; partout ailleurs — doigt, tablette, écran
              tactile — il reste déplié, et sur iPhone il n'y a que le bouton, iOS ignorant le
              volume d'une page. Jamais une fonction réservée au survol. Le temps d'une confirmation
              de diffusion, sur un écran étroit, il cède sa place à la pilule qui s'ouvre. */}
          <div data-liquid className={`player-fade player-volume player-pill flex shrink-0 items-center p-1 ${castConfirm ? "max-sm:hidden" : ""}`}>
            <button
              data-player-nav="mute"
              onClick={(e) => {
                e.stopPropagation();
                toggleMute();
              }}
              aria-label={t("player.mute")}
              className="player-pill-btn"
            >
              {/* Les deux icônes toujours là, l'une qui part pendant que l'autre arrive (`player-swap`). */}
              <span className="player-swap" aria-hidden>
                <span data-off={muted || volume === 0 ? "" : undefined}><Volume2 size={22} /></span>
                <span data-off={muted || volume === 0 ? undefined : ""}><VolumeX size={22} /></span>
              </span>
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
          <LiquidMenu
            menuRef={menuRef}
            anchorRef={settingsPillRef}
            view={menu}
            title={MENU_TITLES[menu] ? t(MENU_TITLES[menu]) : ""}
            icon={MENU_ICONS[menu] ?? null}
            /* w-72 rather than w-56: the subtitle offset row asks for a label and three controls
               side by side, which came to about two hundred and sixty pixels — so it overflowed,
               and a box that scrolls in one direction scrolls in both, which is where the
               horizontal bar came from. Wide enough that the row fits and "Taille sous-titres"
               stops wrapping onto two lines with it. Le verre, l'ancrage sur la pilule et la
               découpe qui en naît : `LiquidMenu`. */
            className="player-menu player-fade player-chrome-right pointer-events-auto absolute z-30 w-72 max-w-[calc(100vw-2rem)] overflow-x-hidden rounded-[22px]"
            style={{
              // `bottom` deliberately not set here: an absolutely-positioned element with both
              // `top` and `bottom` stretches to fill the space between them regardless of
              // content — which made this menu always ~half the screen tall even with only 2-3
              // items. The menu otherwise just sizes to its content.
              // Repli tant que la pilule n'est pas mesurée ; `LiquidMenu` ancre ensuite le menu
              // sur elle, et le borne à 280 px de haut — une liste plus longue défile plutôt que
              // de couvrir le film (04/10/2026).
              bottom: `calc(${BOTTOM_EDGE} + 5.75rem)`,
              maxHeight: `min(280px, calc(100dvh - ${BOTTOM_EDGE} - 10.5rem))`,
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
                {/* La vitesse vit ici depuis le 11/10/2026 : un bouton à elle seule dans la barre pour
                    un réglage qu'on touche rarement. La vitesse courante reste lisible dans la ligne. */}
                <button
                  data-player-nav="speed"
                  onClick={() => setMenu("speed")}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                >
                  <Gauge size={16} /> {t("player.speed")} · {speed === 1 ? t("player.speedNormal") : `${speed}×`}
                </button>
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
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                  >
                    <Info size={16} /> {t('player.playbackInfo')}
                  </button>
                  {/* « Qualité » (§78) : Automatique — la vidéo allégée prend le relais d'elle-même sur une
                      connexion trop lente — ou Originale. Jamais de vidéo allégée à la demande. */}
                  <button
                    data-quality-row=""
                    onClick={() => setMenu("quality")}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                  >
                    <Gauge size={16} /> {t("player.quality.title")} · {quality === "original" ? t("player.quality.original") : t("player.quality.auto")}
                  </button>
                  {hdrCap && (
                    <button
                      onClick={() => setMenu("hdrCap")}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white/85 hover:bg-white/10"
                    >
                      <Sun size={16} /> {t("player.hdrCap.title")} · {hdrCapLabel(hdrCap.current)}
                    </button>
                  )}
                  {/* Le fichier d'origine, au bureau seulement et pour un compte que Jellyfin autorise à
                      télécharger (19/10/2026) — la route le vérifie aussi, cacher la ligne n'est pas
                      interdire. Le navigateur le télécharge lui-même, avec sa reprise. */}
                  {downloadable && (
                    <PlayerDownloadRow itemId={itemId} sizeBytes={playerItem?.download?.sizeBytes ?? null} onStart={() => setMenu(null)} />
                  )}
                </div>
              </>
            )}
            {(menu === "chapters" ||
              menu === "subtitleStyle" ||
              menu === "hdrCap" ||
              menu === "sleep" ||
              menu === "speed" ||
              menu === "dialogue" ||
              menu === "quality" ||
              menu === "subtitleGen" ||
              menu === "subtitleGenOther" ||
              menu === "dual" ||
              menu === "dualPrimary" ||
              menu === "dualSecond") && (
              <button
                onClick={() =>
                  setMenu(
                    menu === "subtitleStyle" || menu === "subtitleGen" || menu === "dual"
                      ? "subtitles"
                      : menu === "subtitleGenOther"
                        ? "subtitleGen"
                        : menu === "dualPrimary" || menu === "dualSecond"
                          ? "dual"
                          : menu === "dialogue"
                            ? "audio"
                            : "more"
                  )
                }
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
                    // Le second pris comme principal : les deux s'échangent (§87).
                    else if (secondSubtitle && tr.id === secondSubtitle.currentId) pickPrimary(tr.id);
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
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${(menu === "audio" ? currentAudioId : currentSubtitleId) === tr.id ? " font-semibold" : ""}`}
                >
                  <OptionCheck on={(menu === "audio" ? currentAudioId : currentSubtitleId) === tr.id} />
                  <span className="min-w-0 line-clamp-2">
                    {tr.label}
                    {tr.detail && (
                      <span data-track-detail className="ml-2 text-xs tabular-nums text-white/50">
                        {tr.detail}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            {/* Sous les pistes, comme sur l'Apple TV : c'est un réglage du son, il vivait dans le
                menu « … » jusqu'au 11/10/2026. Le nom seul et un chevron, comme l'apparence des
                sous-titres : l'état coupé en « … » sur un téléphone ne disait rien. */}
            {menu === "audio" && dialogue && (
              <div className="border-t border-white/10">
                <button
                  data-dialogue-row
                  onClick={() => setMenu("dialogue")}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Speech size={16} className="shrink-0" />
                    <span className="truncate">{t("player.dialogue.title")}</span>
                    <DialogueBeta />
                  </span>
                  <ChevronRight size={14} className="shrink-0 text-white/50" />
                </button>
              </div>
            )}
            {menu === "subtitles" && (
              <button
                onClick={() => {
                  onChangeSubtitle(null);
                  setMenu(null);
                }}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${currentSubtitleId === null ? " font-semibold" : ""}`}
              >
                  <OptionCheck on={currentSubtitleId === null} />
                {t('player.none')}
              </button>
            )}
            {/* « Générer des sous-titres » : sous les pistes, comme « Améliorer les dialogues » sous
                celles du son — le nom et un chevron vers le choix de la langue. La reprise d'une
                génération en pause vit ici aussi : c'est là que le spectateur voit l'entrée en pause. */}
            {menu === "subtitles" && subtitleGeneration && (
              <div className="border-t border-white/10">
                {subtitleGeneration.targets.length > 0 && (
                  <button
                    data-subtitle-gen-row
                    disabled={subtitleGeneration.busy}
                    onClick={() => setMenu("subtitleGen")}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10 disabled:opacity-50"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Languages size={16} className="shrink-0" />
                      <span className="truncate">{t("player.subtitleGen.generate")}</span>
                    </span>
                    <ChevronRight size={14} className="shrink-0 text-white/50" />
                  </button>
                )}
                {subtitleGeneration.resumable.map((entry) => (
                  <button
                    key={entry.code}
                    data-subtitle-gen-resume={entry.code}
                    onClick={() => {
                      subtitleGeneration.onResume(entry.code);
                      setMenu(null);
                    }}
                    className="block w-full px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                  >
                    {t("player.subtitleGen.resume", { language: entry.label })}
                  </button>
                ))}
              </div>
            )}
            {/* La langue du compte d'abord, d'un geste ; les autres derrière « Autre langue… », pour
                que le cas courant ne demande pas de parcourir une liste. */}
            {menu === "subtitleGen" && subtitleGeneration && subtitleGeneration.targets.length > 0 && (
              <>
                <button
                  data-subtitle-gen-target={subtitleGeneration.targets[0].code}
                  disabled={subtitleGeneration.busy}
                  onClick={() => {
                    subtitleGeneration.onGenerate(subtitleGeneration.targets[0].code);
                    setMenu(null);
                  }}
                  className="block w-full px-3 py-2 text-left text-sm text-white hover:bg-white/10 disabled:opacity-50"
                >
                  {subtitleGeneration.targets[0].label}
                </button>
                {subtitleGeneration.targets.length > 1 && (
                  <button
                    data-subtitle-gen-other
                    onClick={() => setMenu("subtitleGenOther")}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                  >
                    {t("player.subtitleGen.otherLanguage")}
                    <ChevronRight size={14} className="shrink-0 text-white/50" />
                  </button>
                )}
              </>
            )}
            {menu === "subtitleGenOther" &&
              subtitleGeneration &&
              subtitleGeneration.targets.slice(1).map((target) => (
                <button
                  key={target.code}
                  data-subtitle-gen-target={target.code}
                  disabled={subtitleGeneration.busy}
                  onClick={() => {
                    subtitleGeneration.onGenerate(target.code);
                    setMenu(null);
                  }}
                  className="block w-full px-3 py-2 text-left text-sm text-white hover:bg-white/10 disabled:opacity-50"
                >
                  {target.label}
                </button>
              ))}
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
                  <OffsetRow label={t("player.subtitleOffset")} seconds={subtitleOffset} onShift={shiftSubtitles} />
                )}
              </div>
            )}
            {/* « Deux sous-titres » (§87) : sous l'apparence, une porte comme elle. Proposée dès qu'il y a
                de quoi faire deux — deux pistes, ou une piste et une langue à générer. La ligne dit le
                second retenu, pour qu'on sache sans ouvrir que le mode est actif. */}
            {menu === "subtitles" &&
              secondSubtitle &&
              (subtitleTracks.length >= 2 || (subtitleTracks.length >= 1 && (secondSubtitle.generation?.targets.length ?? 0) > 0)) && (
                <button
                  data-dual-subtitles-row
                  onClick={() => setMenu("dual")}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                >
                  <span className="truncate">{t("player.dualSubtitles.title")}</span>
                  <span className="flex min-w-0 items-center gap-1">
                    {secondId !== null && <span className="truncate text-xs text-white/50">{labelOf(secondId)}</span>}
                    <ChevronRight size={14} className="shrink-0 text-white/50" />
                  </span>
                </button>
              )}
            {menu === "dual" && secondSubtitle && (
              <>
                <button
                  data-dual-primary-row
                  onClick={() => setMenu("dualPrimary")}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                >
                  <span className="shrink-0">{t("player.dualSubtitles.primary")}</span>
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate text-xs text-white/50">{labelOf(currentSubtitleId)}</span>
                    <ChevronRight size={14} className="shrink-0 text-white/50" />
                  </span>
                </button>
                <button
                  data-dual-second-row
                  disabled={currentSubtitleId === null}
                  onClick={() => setMenu("dualSecond")}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/10 disabled:opacity-50"
                >
                  <span className="shrink-0">{t("player.dualSubtitles.second")}</span>
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate text-xs text-white/50">{labelOf(secondId)}</span>
                    <ChevronRight size={14} className="shrink-0 text-white/50" />
                  </span>
                </button>
                {currentSubtitleId === null && (
                  <p className="px-3 pb-2 text-xs text-white/50">{t("player.dualSubtitles.primaryFirst")}</p>
                )}
                {secondId !== null && (
                  <div className="border-t border-white/10">
                    <OffsetRow label={t("player.dualSubtitles.secondOffset")} seconds={secondOffset} onShift={shiftSecond} />
                    <button
                      data-dual-off
                      onClick={() => {
                        secondSubtitle.onChange(null);
                        setMenu("subtitles");
                      }}
                      className="block w-full px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                    >
                      {t("player.dualSubtitles.off")}
                    </button>
                  </div>
                )}
                {/* Ce que la télévision reçoit, dit simplement : AirPlay et le Chromecast ne prennent
                    que le principal — le second est dessiné par cette page, qui n'est pas à l'écran. */}
                {(castSupported || !!chromecast) && (
                  <p data-dual-tv-note className="border-t border-white/10 px-3 py-2 text-xs text-white/50">
                    {t("player.dualSubtitles.tvNote")}
                  </p>
                )}
              </>
            )}
            {menu === "dualPrimary" &&
              subtitleTracks.map((tr) => (
                <button
                  key={tr.id}
                  data-dual-primary={tr.id}
                  onClick={() => {
                    pickPrimary(tr.id);
                    setMenu("dual");
                  }}
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${currentSubtitleId === tr.id ? " font-semibold" : ""}`}
                >
                  <OptionCheck on={currentSubtitleId === tr.id} />
                  <span className="min-w-0 line-clamp-2">{tr.label}</span>
                </button>
              ))}
            {menu === "dualSecond" && secondSubtitle && (
              <>
                <button
                  data-dual-second="none"
                  onClick={() => {
                    secondSubtitle.onChange(null);
                    setMenu("dual");
                  }}
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${secondId === null ? " font-semibold" : ""}`}
                >
                  <OptionCheck on={secondId === null} />
                  {t("player.none")}
                </button>
                {secondChoices.map((tr) => (
                  <button
                    key={tr.id}
                    data-dual-second={tr.id}
                    onClick={() => {
                      secondSubtitle.onChange(tr.id);
                      setMenu("dual");
                    }}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${secondId === tr.id ? " font-semibold" : ""}`}
                  >
                    <OptionCheck on={secondId === tr.id} />
                    <span className="min-w-0 line-clamp-2">
                      {tr.label}
                      {tr.detail && <span className="ml-2 text-xs tabular-nums text-white/50">{tr.detail}</span>}
                    </span>
                  </button>
                ))}
                {/* Générer le second, à la volée depuis la position — la même demande, les mêmes limites et
                    les mêmes messages que « Générer des sous-titres » (§70). */}
                {secondSubtitle.generation && secondSubtitle.generation.targets.length > 0 && (
                  <div className="border-t border-white/10">
                    {secondSubtitle.generation.targets.map((target) => (
                      <button
                        key={target.code}
                        data-dual-generate={target.code}
                        disabled={secondSubtitle.generation!.busy}
                        onClick={() => {
                          secondSubtitle.generation!.onGenerate(target.code);
                          setMenu(null);
                        }}
                        className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10 disabled:opacity-50"
                      >
                        <Languages size={16} aria-hidden className="mt-0.5 shrink-0" />
                        <span className="min-w-0 line-clamp-2">{t("player.dualSubtitles.generate", { language: target.label })}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
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
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${hdrCap.current === choice ? " font-semibold" : ""}`}
                >
                  <OptionCheck on={hdrCap.current === choice} />
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
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${sleepMode === choice ? " font-semibold" : ""}`}
                >
                  <OptionCheck on={sleepMode === choice} />
                  {sleepLabel(choice)}
                </button>
              ))}
            {/* Comme l'audio et les sous-titres : trois choix dans une liste, le courant en couleur.
                Choisir reconstruit la lecture au même endroit (le traitement vit dans la chaîne audio)
                et referme le menu, comme un changement de piste. */}
            {menu === "quality" && (
              <>
                {(["auto", "original"] as const).map((choice) => (
                  <button
                    key={choice}
                    data-quality-choice={choice}
                    onClick={() => {
                      if (choice !== quality) writePlaybackQuality(choice);
                      setMenu(null);
                    }}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${quality === choice ? " font-semibold" : ""}`}
                  >
                  <OptionCheck on={quality === choice} />
                    {choice === "auto" ? t("player.quality.auto") : t("player.quality.original")}
                  </button>
                ))}
                <p className="border-t border-white/10 px-3 pt-2 pb-2 text-xs text-white/60">{t("player.quality.hint")}</p>
              </>
            )}
            {menu === "dialogue" && dialogue && (
              <>
                {DIALOGUE_CHOICES.map(({ mode, label }) => (
                  <button
                    key={mode}
                    data-dialogue-choice={mode}
                    onClick={() => {
                      if (mode !== dialogue.mode) dialogue.onChange(mode);
                      setMenu(null);
                    }}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${dialogue.mode === mode ? " font-semibold" : ""}`}
                  >
                  <OptionCheck on={dialogue.mode === mode} />
                    {t(label)}
                  </button>
                ))}
                {dialogue.mode !== "off" && !dialogue.applies && (
                  <p data-dialogue-not-applied className="border-t border-white/10 px-3 pt-2 pb-2 text-xs text-white/60">
                    {t("player.dialogue.notThisTrack")}
                  </p>
                )}
              </>
            )}
            {menu === "speed" &&
              PLAYBACK_SPEEDS.map((rate) => (
                <button
                  key={rate}
                  onClick={() => changeSpeed(rate)}
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${speed === rate ? " font-semibold" : ""}`}
                >
                  <OptionCheck on={speed === rate} />
                  {rate === 1 ? t('player.speedNormal') : `${rate}x`}
                </button>
              ))}
            {menu === "episodes" && episodesSeriesId && onPlayEpisode && (
              <PlayerEpisodesMenu
                seriesId={episodesSeriesId}
                currentItemId={itemId}
                onPick={(episode) => {
                  setMenu(null);
                  noteViewerPresent();
                  onPlayEpisode(episode);
                }}
              />
            )}
            {menu === "chapters" &&
              chapters.map((ch, i) => {
                const tile = trickplayTileAt(ch.start);
                return (
                  <button
                    key={i}
                    onClick={() => jumpToChapter(ch.start)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${
                      currentTime >= ch.start && (chapters[i + 1] ? currentTime < chapters[i + 1].start : true) ? " font-semibold" : ""
                    }`}
                  >
                    <OptionCheck on={currentTime >= ch.start && (chapters[i + 1] ? currentTime < chapters[i + 1].start : true)} />
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
          </LiquidMenu>
        )}

        {/* Center play/pause, flanked by ±10s skip buttons — plain buttons only, not a
            double-tap-the-screen-edge gesture (too easy to trigger by accident, and would
            conflict with the tap-to-toggle-controls handler covering the same area). Hidden
            while a spinner is already showing. */}
        {(resuming || (!loading && !buffering)) && (
          <div data-player-navgroup="center" className={`${visible ? "pointer-events-auto" : "pointer-events-none"} absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-9 sm:gap-12 max-[379px]:gap-6`}>
            <button
              data-player-nav="skip-back"
              onClick={(e) => {
                e.stopPropagation();
                skip(-10);
                spinSkip(e.currentTarget, -1);
              }}
              data-liquid
              className="player-fade player-pill player-pill-light player-center-btn player-glass-back"
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
              aria-label={shownPlaying ? t("player.pause") : t("player.play")}
              data-size="main"
              data-liquid
              className="player-fade player-pill player-pill-light player-center-btn"
            >
              {shownPlaying ? <Pause size={30} fill="currentColor" strokeWidth={0} /> : <Play size={30} fill="currentColor" strokeWidth={0} className="translate-x-[2px]" />}
              {/* La reprise en cours : un anneau qui tourne autour du bouton, qui reste touchable. */}
              {resuming && <span className="player-resume-ring" aria-hidden data-player-resuming="" />}
            </button>
            <button
              data-player-nav="skip-fwd"
              onClick={(e) => {
                e.stopPropagation();
                skip(10);
                spinSkip(e.currentTarget, 1);
              }}
              data-liquid
              className="player-fade player-pill player-pill-light player-center-btn player-glass-fwd"
              title={t('player.forward10')}
            >
              <SkipGlyph direction="forward" />
            </button>
          </div>
        )}

        {/* En bas : le titre et la pilule des réglages sur une rangée, la barre et ses deux temps
            dessous. */}
        <div
          ref={bottomRowRef}
          className={`player-chrome-x ${visible ? "pointer-events-auto translate-y-0" : "pointer-events-none translate-y-1"} player-spring flex flex-col gap-3 pt-4 motion-reduce:translate-y-0`}
          // Son `click` est arrêté ; son `dblclick`, qui remonte quand même, ne doit pas passer en
          // plein écran depuis le titre (chasse aux défauts, 11/10/2026).
          data-player-surface-ignore
          onClick={(e) => e.stopPropagation()}
          onClickCapture={() => showControls(10000)}
          style={{ paddingBottom: BOTTOM_EDGE }}
        >
          <div className="flex items-end gap-3">
            {/* La série en grand, l'épisode en petit dessous ; un film, son titre seul. Une ombre
                douce sous le texte et le palier du voile du bas : lisible sur une image claire, sans
                flou. "Série — S02E05 · Le pilote" arrive d'une seule pièce du serveur. */}
            <div className="player-fade player-title min-w-0 flex-1 pb-0.5">
              <PlayerTitle title={title} logoUrl={logoUrl} />
            </div>
            {/* Audio · sous-titres · ⋮ — et le plein écran au bout, là où il existe : à
                côté du temps restant, il aurait cassé la symétrie de la ligne du temps. Les menus
                s'ouvrent vers le haut depuis cette pilule. */}
            <div ref={settingsPillRef} data-player-navgroup="bottombar" data-settings-pill data-liquid className="player-fade player-pill flex shrink-0 items-center gap-1 p-1 max-[379px]:gap-0.5">
              {/* Une seule piste n'a rien à choisir — sauf le réglage des dialogues, qui vit là. */}
              {(audioTracks.length > 1 || dialogue) && (
                <button
                  data-player-nav="audio"
                  onClick={() => setMenu(menu === "audio" ? null : "audio")}
                  aria-label={t("player.audio")}
                  data-on={menu === "audio" ? "" : undefined}
                  className="player-pill-btn"
                >
                  <AudioLines size={22} />
                </button>
              )}
              {/* Sans piste, le bouton reste s'il y a une génération à proposer : un film sans aucun
                  sous-titre est justement celui pour lequel on en génère. */}
              {(subtitleTracks.length > 0 || subtitleGeneration) && (
                <button
                  data-player-nav="captions"
                  onClick={() => setMenu(menu === "subtitles" ? null : "subtitles")}
                  aria-label={t("player.subtitles")}
                  data-on={menu === "subtitles" ? "" : undefined}
                  data-active={currentSubtitleId !== null ? "" : undefined}
                  className="player-pill-btn"
                >
                  <Captions size={22} />
                </button>
              )}
              {/* L'épisode suivant à tout moment (11/10/2026), comme sur Netflix ou Prime Video : par
                  le même `onAdvance` que la carte du générique, jamais un second chemin. Absent
                  quand la minuterie de veille arrête la série à la fin de cet épisode : elle a dit
                  « rien ne s'enchaîne ». */}
              {/* Les épisodes de la saison (19/10/2026), comme sur Netflix : revenir à celui qu'un bouton
                  du casque vient de quitter, ou en choisir un autre. Seulement pour un épisode. */}
              {episodesSeriesId && (
                <button
                  data-player-nav="episodes"
                  onClick={() => setMenu(menu === "episodes" ? null : "episodes")}
                  title={t("player.episodes.title")}
                  aria-label={t("player.episodes.title")}
                  data-on={menu === "episodes" ? "" : undefined}
                  className="player-pill-btn"
                >
                  <Layers size={22} />
                </button>
              )}
              {nextEpisode && !sleepBlocksAdvance && (
                <button
                  data-player-nav="next-episode"
                  onClick={() => {
                    noteViewerPresent();
                    requestAdvance();
                  }}
                  title={t("player.nextEpisode")}
                  aria-label={t("player.nextEpisode")}
                  className="player-pill-btn"
                >
                  <SkipForward size={22} />
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
                <EllipsisVertical size={22} />
              </button>
              {fullscreenSupported && (
                <button
                  data-player-nav="fullscreen"
                  onClick={toggleFullscreen}
                  aria-label={t("player.fullscreen")}
                  className="player-pill-btn"
                >
                  {isFullscreen ? <Minimize size={22} /> : <Maximize size={22} />}
                </button>
              )}
            </div>
          </div>
          {/* Le temps écoulé à gauche, ce qui reste à droite — sans signe moins, toujours, en pause
              comme en lecture. Il n'y a plus de bascule : les deux sont là. */}
          <div className="player-fade flex items-center gap-3">
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
            onMouseLeave={(e) => {
              setPreviewTime(null);
              // Sortie de la fenêtre par la barre : le `pointerout` vient de les cacher, rien à rappeler.
              // Hors de la page, React donne la fenêtre — ou rien — pour destination, jamais un nœud.
              if (!(e.relatedTarget instanceof Node) && windowExitHides()) return;
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
            <div className={`pointer-events-none absolute top-1/2 w-full -translate-y-1/2 rounded-full bg-white/20 transition-[height] duration-[260ms] ease-[cubic-bezier(0.33,1,0.68,1)] ${scrubbing ? "h-3" : "h-2"}`} />
            {/* Buffered range — deliberately subtle (a slightly lighter track, not a bold
                second color): its only job is "can I scrub ahead without waiting", not
                competing for attention with the actual playback position. Sits under the
                native range input's own track, which only leaves it visible in the *unplayed*
                portion — exactly the part worth showing. */}
            {duration > 0 && bufferedEnd > 0 && (
              <div
                className={`pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full bg-white/35 transition-[height] duration-[260ms] ease-[cubic-bezier(0.33,1,0.68,1)] ${scrubbing ? "h-3" : "h-2"}`}
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
                specific chapter is what the chapters menu button is for.
                Pendant le glissement seulement (19/10/2026) : au repos, une vingtaine de chapitres
                génériques (« Chapter 5 », Interstellar) hachaient la barre en pointillés. C'est en
                cherchant un passage qu'ils servent. */}
            {duration > 0 &&
              scrubbing &&
              chapters.map((ch, i) => (
                <div
                  key={i}
                  data-chapter-mark=""
                  className="pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2 bg-black/50"
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
              // Un nom et une valeur lisible (15/10/2026, passe de nuit, ROBUSTESSE-11) : sans eux,
              // un lecteur d'écran annonçait « curseur, 437 » — des secondes brutes, sans dire de quoi.
              aria-label={t("player.seekLabel")}
              aria-valuetext={t("player.seekValue", { at: formatTime(currentTime), total: formatTime(duration || 0) })}
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
              // ← et → appartiennent au clavier du lecteur (±10 s, l'écouteur de la fenêtre), barre
              // focalisée comprise : jamais le pas natif de l'input. La barre avait gardé de l'époque
              // d'avant le jeu fixe un aperçu au `keydown` et une validation au `keyup` — qui, la
              // fenêtre ayant déjà sauté de dix secondes entre-temps, validait l'ancienne valeur de
              // l'input (le tic de la position était suspendu par `seekingRef`) : après un clic sur la
              // barre, qui garde le focus, une flèche ne faisait rien, ou ramenait le film d'où il
              // venait (chasse aux défauts du 13/10/2026). Retenue ici aussi pour qu'un lecteur
              // suspendu, dont la fenêtre ignore les touches, ne laisse pas l'input bouger seul.
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.preventDefault();
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
          {/* Le temps restant porte son signe, comme sur l'Apple TV (19/10/2026) : « 2:13:36 » seul se
              lisait comme la durée du film. Pas de signe à zéro. */}
          <span data-player-remaining className="player-time shrink-0 text-right">{remainingLabel(duration, currentTime)}</span>
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
              current === option.value ? "bg-accent-600 text-ink" : "bg-white/10 text-white/70 hover:bg-white/20"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Le titre du lecteur : le logo du film ou de la série quand il existe, le titre écrit sinon
 * (09/10/2026). La ligne de l'épisode (« S02E05 · Le pilote ») reste écrite dessous.
 *
 * Le logo ne remplace le texte qu'une fois l'image chargée : jusque-là, et si elle échoue, c'est le
 * titre écrit — jamais une case vide qui se remplit sous les yeux. Le titre reste lisible par un
 * lecteur d'écran (`data-player-title`, masqué à l'œil quand le logo est là).
 */
function PlayerTitle({ title, logoUrl }: { title: string; logoUrl: string | null }) {
  const cut = title.indexOf(" — ");
  const main = cut === -1 ? title : title.slice(0, cut);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!logoUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setLoaded(logoUrl);
    };
    img.onerror = () => {
      if (!cancelled) setFailed(logoUrl);
    };
    img.src = logoUrl;
    return () => {
      cancelled = true;
    };
  }, [logoUrl]);
  const showLogo = !!logoUrl && loaded === logoUrl && failed !== logoUrl;
  return (
    <>
      {showLogo ? (
        <>
          <p data-player-title className="sr-only">{main}</p>
          <CinemaLogo src={logoUrl} alt="" surface="player" className="mb-1" onError={() => setFailed(logoUrl)} />
        </>
      ) : (
        <p data-player-title className="player-title-main truncate text-white">{main}</p>
      )}
      {cut !== -1 && <p className="truncate text-[13px] font-medium text-white/70 sm:text-sm">{title.slice(cut + 3)}</p>}
    </>
  );
}

/** « Bêta », le même badge que la diffusion Chromecast — à retirer quand le réglage aura fait ses preuves. */
function DialogueBeta() {
  const t = useT();
  return (
    <span className="shrink-0 rounded-full border border-white/20 px-1.5 py-px text-[11px] font-semibold uppercase leading-4 tracking-wider text-white/70">
      {t("player.chromecast.beta")}
    </span>
  );
}

/**
 * Un décalage de sous-titres : l'intitulé, −0,5 s, la valeur, +0,5 s. Le même pour le principal et
 * pour le second (§87) — même pas, même place.
 */
function OffsetRow({ label, seconds, onShift }: { label: string; seconds: number; onShift: (deltaSeconds: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-white">
      <span className="min-w-0">{label}</span>
      <div className="flex shrink-0 items-center gap-1">
        <button onClick={() => onShift(-0.5)} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
          −0.5s
        </button>
        <span className="w-12 text-center tabular-nums text-xs text-white/70">
          {seconds > 0 ? "+" : ""}
          {seconds}s
        </span>
        <button onClick={() => onShift(0.5)} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
          +0.5s
        </button>
      </div>
    </div>
  );
}

/**
 * L'option retenue d'un menu du lecteur : une coche, comme les menus d'iOS et de l'Apple TV
 * (13/10/2026). Elle était dite par la couleur d'accent sur un texte blanc ; l'accent devenu blanc
 * (§83), la piste choisie ne se distinguait plus des autres. La place est gardée sur chaque ligne
 * pour que les libellés restent alignés. `data-option-on` la désigne au menu, qui la fait
 * défiler dans son cadre à l'ouverture (`LiquidMenu`, LECTEUR-15).
 */
/** Le temps restant, signé « − » (U+2212) tant qu'il en reste. */
function remainingLabel(duration: number, currentTime: number): string {
  const left = Math.max(0, duration - currentTime);
  // Moins d'une seconde s'écrit « 0:00 » : sans signe, pas « −0:00 ».
  return left >= 1 ? `\u2212${formatTime(left)}` : formatTime(0);
}

function OptionCheck({ on }: { on: boolean }) {
  return <Check size={16} strokeWidth={2.5} aria-hidden data-option-on={on ? "" : undefined} className={`mt-0.5 shrink-0 ${on ? "" : "invisible"}`} />;
}
