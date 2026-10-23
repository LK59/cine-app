"use client";

import type { TrickplayInfo } from "@/lib/trickplayTile";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Play, Pause, Maximize, Minimize, Captions, AudioLines, Loader2, RotateCcw, RotateCw, EllipsisVertical, SkipForward, Layers } from "lucide-react";
import type { DialogueMode } from "@/lib/webcodecs/dialogueEnhance";
import type { HdrCapChoice } from "@/lib/webcodecs/hdrDisplay";
import { useT } from "@/components/TranslationProvider";
import { formatTime } from "@/lib/playerClock";
import { createLiquidPress, prefersReducedMotion } from "@/lib/liquidGlass/liquid";
import { usePrewarmEpisodes } from "@/components/player/PlayerEpisodesMenu";
import { usePlayerItem } from "@/lib/usePlayerItem";
import { useCastAvailability, type CastVideoElement } from "@/components/playerControls/useCastAvailability";
import { useChapters, useTrickplay } from "@/components/playerControls/useTrickplay";
import { PlayerTopBar } from "@/components/playerControls/PlayerTopBar";
import { PlayerPrompts } from "@/components/playerControls/PlayerPrompts";
import { PlayerSettingsMenu, type MenuView } from "@/components/playerControls/PlayerSettingsMenu";
import { BOTTOM_EDGE } from "@/components/playerControls/layout";
import { usePlayerKeyboard } from "@/components/playerControls/usePlayerKeyboard";
import { usePlaybackMirror, useElementMirror } from "@/components/playerControls/usePlaybackMirror";
import { useAutoHide } from "@/components/playerControls/useAutoHide";
import { noteAutoAdvance, noteViewerPresent, autoAdvanceStore, STILL_THERE_AFTER } from "@/lib/autoAdvance";
import {
  subtitleStyleStore,
  cueCss,
  type ChromeEdges,
} from "@/lib/subtitleStyle";
import { useMediaSession } from "@/lib/useMediaSession";
import { usePlaybackQuality } from "@/lib/playbackQuality";
import { activeSkip, isEmptySurface, surfaceAction } from "@/lib/playerSkip";
import {
  sleepBlocksAdvanceSnapshot,
  sleepFalseServerSnapshot,
  sleepMinutesSnapshot,
  sleepModeSnapshot,
  sleepNullServerSnapshot,
  sleepServerSnapshot,
  sleepTimerStore,
  sleepWarningSnapshot,
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

interface PlayerControlsProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  itemId: string;
  title: string;
  /**
   * Un extrait du test de qualité hors ligne (`labSamples.ts`) : ni chapitres, ni aperçus de la
   * barre — ceux du film entier ne tombent pas aux mêmes instants —, ni téléchargement du fichier.
   */
  lab?: boolean;
  /**
   * La part du film déjà téléchargée sur l'appareil (0 à 1), pour le lecteur des téléchargements
   * hors ligne : la barre la montre en gris clair entre la partie lue (blanche) et le reste (Louis,
   * 19/10/2026). Absente partout ailleurs.
   */
  downloadedFraction?: number;
  /**
   * Les aperçus de la barre gardés sur l'appareil avec un téléchargement hors ligne : la description
   * et une adresse `blob:` par planche. Présents, rien n'est demandé au serveur (Louis, 19/10/2026 :
   * chercher un passage sans réseau). Absents, ceux du serveur, comme partout ailleurs.
   */
  offlineTrickplay?: { info: TrickplayInfo; urls: string[] } | null;
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
 * Ce qu'un doigt peut bouger en touchant la barre sans la faire glisser. En deçà, c'est un toucher,
 * et un toucher ne déplace rien (19/10/2026, voir `touchStartRef`) ; au-delà, tout le déplacement
 * compte, ces premiers pixels compris.
 */
const TOUCH_SLOP_PX = 6;

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
  lab = false,
  downloadedFraction,
  offlineTrickplay = null,
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
  // Le menu « Épisodes » prêt d'avance, après la première image — voir `usePrewarmEpisodes`.
  usePrewarmEpisodes(episodesSeriesId, itemId, videoRef);
  // Au bureau seulement — `PlayerDownloadRow` en décide (§107).
  const downloadable = !lab && !!playerItem?.download;
  const {
    playing,
    shownPlaying,
    intendTimer: intendTimerRef,
    setIntended,
    buffering,
    seekSpinner,
    currentTime,
    setCurrentTime,
    duration,
    volume,
    muted,
    speed,
    bufferedEnd,
    setters: mirrorSetters,
  } = usePlaybackMirror();
  /** The element whose volume has already been probed, so it is probed once and not per render. */
  const probedVolumeOn = useRef<HTMLVideoElement | null>(null);

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
  const [menu, setMenu] = useState<null | MenuView>(null);
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
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
  const [nextUpDismissed, setNextUpDismissed] = useState(false);
  const [nextUpCountdown, setNextUpCountdown] = useState(NEXT_UP_COUNTDOWN_S);
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
  /**
   * Au doigt, la barre glisse en relatif (19/10/2026, DECISIONS.md §108), comme l'app TV d'Apple et
   * Photos : poser le doigt n'importe où ne déplace rien, glisser déplace la tête de lecture d'autant
   * que le doigt, depuis là où elle était. `x` et `time` : le point de départ ; `target` : la position
   * visée, nulle tant que le doigt n'a pas dépassé `TOUCH_SLOP_PX` — un toucher bref ne saute pas.
   * Le doigt cache la barre : sauter sous lui faisait perdre sa place à qui voulait reculer d'un peu.
   */
  const touchStartRef = useRef<{ x: number; time: number; target: number | null } | null>(null);
  /**
   * Ce qui a saisi l'input en dernier — `pointerType` de son pointerdown, ou « keyboard ».
   *
   * L'input natif pose sa valeur au point touché, avant que le doigt ait glissé d'un pixel : au
   * pointerdown sur Chromium, sur la souris que le navigateur rejoue après le touchend sur iOS. Son
   * `change` passait par `previewSeek`, et la partie lue allait un instant jusqu'au doigt puis revenait
   * (8.70.0, iPhone, 19/10/2026). Au toucher, la valeur affichée ne vient que de la position relative
   * (§108) : l'input est ignoré tant que la dernière saisie est un doigt — la souris rejouée ne
   * produit pas de pointerdown, elle ne le fait donc pas oublier.
   */
  const inputPointerRef = useRef<string | null>(null);
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

  const chapters = useChapters(itemId, lab);

  useElementMirror(videoRef, mirrorSetters, seekSpinner, seekingRef, visibleRef, probeVolume);


  const { castSupported, castKind } = useCastAvailability(videoRef);

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

  const { suspendedRef, showControls, holdControls, toggleControls, windowExitHides } = useAutoHide({
    visible,
    setVisible,
    playing,
    suspended,
    hidden,
    resuming,
    menu,
    setMenu,
    seekingRef,
    liquidRootRef,
  });

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

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    const wantsPlay = video.paused;
    setIntended(wantsPlay);
    if (intendTimerRef.current) clearTimeout(intendTimerRef.current);
    intendTimerRef.current = setTimeout(() => setIntended(null), 1500);
    if (wantsPlay) {
      const started = video.play();
      // Refusée (iOS sans geste récent, source perdue) : l'icône revient aussitôt à l'arrêt.
      if (started && typeof started.catch === "function") started.catch(() => setIntended(null));
    } else video.pause();
  }

  // Un saut, dit d'abord à l'hôte (`onSeekRequest` — le lecteur natif s'y prépare) puis fait sur
  // l'élément. Ne touche pas l'état `currentTime` : `skip` et « Passer l'intro » laissent `seeked`
  // le poser, seul `commitSeek` le pose lui-même.
  function seekElement(video: HTMLVideoElement, time: number) {
    onSeekRequest?.(time);
    video.currentTime = time;
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
    seekElement(video, target);
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
    seekElement(video, value);
    setCurrentTime(value);
  }

  const { trickplay, trickplayTileAt } = useTrickplay(itemId, lab, offlineTrickplay, videoRef);

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

  // La souris : survol (la vignette) et glissement (la barre suit le curseur). Le doigt, lui, glisse en
  // relatif depuis le 19/10/2026 (§108) et passe par `showPreviewAt`. Plain function, not
  // useCallback: nothing needs its referential identity to stay stable, and the extra state/hooks
  // added alongside chapters/PiP/speed tripped the React Compiler's own memoization-preservation
  // check on the manually memoized version.
  /** Le temps sous ce pixel, sur toute la largeur de la barre — ce que la vignette annonce. */
  function fractionAt(clientX: number): number | null {
    const bar = seekBarRef.current;
    if (!bar || !duration) return null;
    const rect = bar.getBoundingClientRect();
    return rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : null;
  }

  /** La vignette et la barre à un instant donné — le glissement relatif au doigt (§108). */
  function showPreviewAt(time: number, follow: boolean) {
    if (!duration) return;
    const clamped = Math.min(duration, Math.max(0, time));
    setPreviewFraction(clamped / duration);
    setPreviewTime(clamped);
    if (follow) previewSeek(clamped);
  }

  function updatePreview(clientX: number) {
    const fraction = fractionAt(clientX);
    if (fraction === null) return;
    setPreviewFraction(fraction);
    setPreviewTime(fraction * duration);
    // The bar follows the cursor while dragging — the same call the input makes, from the one
    // place that knows where the pointer is.
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

  usePlayerKeyboard(togglePlay, skip, showControls, suspendedRef);

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

      <PlayerPrompts
        skipNow={skipNow}
        onSkip={(end) => {
          if (videoRef.current) seekElement(videoRef.current, end);
        }}
        sleepWarning={sleepWarning}
        askStillThere={askStillThere}
        showNextUp={showNextUp}
        nextEpisode={nextEpisode}
        nextUpCountdown={nextUpCountdown}
        requestAdvance={requestAdvance}
        onDismissNextUp={() => setNextUpDismissed(true)}
      />

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
        <PlayerTopBar
          rowRef={topRowRef}
          visible={visible}
          showControls={showControls}
          onClose={handleCloseClick}
          onMinimize={handleMinimizeClick}
          chromecast={chromecast}
          castSupported={castSupported}
          castKind={castKind}
          castActive={castActive}
          onCastRequest={onCastRequest}
          showCastPicker={showCastPicker}
          muted={muted}
          volume={volume}
          volumeSettable={volumeSettable}
          toggleMute={toggleMute}
          changeVolume={changeVolume}
        />

        {menu && (
          <PlayerSettingsMenu
            menu={menu}
            setMenu={setMenu}
            menuRef={menuRef}
            anchorRef={settingsPillRef}
            showControls={showControls}
            itemId={itemId}
            playerItem={playerItem}
            downloadable={downloadable}
            audioTracks={audioTracks}
            currentAudioId={currentAudioId}
            onChangeAudio={onChangeAudio}
            subtitleTracks={subtitleTracks}
            currentSubtitleId={currentSubtitleId}
            onChangeSubtitle={onChangeSubtitle}
            subtitleOffset={subtitleOffset}
            shiftSubtitles={shiftSubtitles}
            secondSubtitle={secondSubtitle}
            secondId={secondId}
            secondOffset={secondOffset}
            shiftSecond={shiftSecond}
            subtitleGeneration={subtitleGeneration}
            subtitleStyle={subtitleStyle}
            dialogue={dialogue}
            hdrCap={hdrCap}
            frameFit={frameFit}
            quality={quality}
            speed={speed}
            changeSpeed={changeSpeed}
            sleepMode={sleepMode}
            sleepMinutes={sleepMinutes}
            nextEpisode={nextEpisode}
            onCastReturn={onCastReturn}
            castActive={castActive}
            castSupported={castSupported}
            chromecast={chromecast}
            onTogglePlaybackInfo={onTogglePlaybackInfo}
            episodesSeriesId={episodesSeriesId}
            onPlayEpisode={onPlayEpisode}
            chapters={chapters}
            jumpToChapter={jumpToChapter}
            currentTime={currentTime}
            trickplay={trickplay}
            trickplayTileAt={trickplayTileAt}
          />
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
            // Au doigt, en relatif (§108) : le toucher montre la vignette là où en est le film, sans
            // rien déplacer ; le glissement déplace la tête d'autant que le doigt, depuis là.
            onTouchStart={(e) => {
              touchDragRef.current = true;
              inputPointerRef.current = "touch";
              const x = e.touches[0].clientX;
              lastTouchXRef.current = x;
              touchStartRef.current = { x, time: currentTime, target: null };
              // Le tic de la position se tait pendant le geste, d'où qu'il parte sur la barre :
              // sans cela il remettrait la barre sous la tête pendant que le doigt glisse.
              seekingRef.current = true;
              holdControls();
              showPreviewAt(currentTime, false);
            }}
            onTouchMove={(e) => {
              holdControls();
              const start = touchStartRef.current;
              const width = seekBarRef.current?.getBoundingClientRect().width ?? 0;
              if (!start || !duration || width <= 0) return;
              // Un doigt immobile n'est pas immobile au dixième de pixel près, et sur un
              // téléphone un pixel de barre vaut une vingtaine de secondes de film : sans ce
              // seuil, la vignette hésitait entre deux images sous un doigt posé.
              const x = e.touches[0].clientX;
              if (lastTouchXRef.current !== null && Math.abs(x - lastTouchXRef.current) < TOUCH_JITTER_PX) return;
              lastTouchXRef.current = x;
              if (start.target === null && Math.abs(x - start.x) < TOUCH_SLOP_PX) return;
              // Un pixel de doigt vaut un pixel de barre : la même échelle que la barre elle-même.
              const target = Math.min(duration, Math.max(0, start.time + ((x - start.x) / width) * duration));
              start.target = target;
              showPreviewAt(target, true);
            }}
            /**
             * Le saut est décidé ici, par le conteneur — et non par la valeur de l'input.
             *
             * Un `input[type=range]` sur iOS ne bouge que si l'on attrape sa pastille, cachée au
             * repos ; le conteneur, lui, suit le doigt depuis le début. Il ne valide qu'un vrai
             * glissement (`target`) : un toucher bref n'en est pas un, et ne déplace rien.
             */
            onTouchEnd={() => {
              const target = touchStartRef.current?.target ?? null;
              seekingRef.current = false;
              touchDragRef.current = false;
              lastTouchXRef.current = null;
              touchStartRef.current = null;
              lastTouchEndRef.current = performance.now();
              if (target !== null) commitSeek(target);
              setPreviewTime(null);
              setTimeout(() => showControls(5000), 0);
            }}
            // A touch the system takes back — a notification, a call, a gesture the browser
            // claims — never reaches touchend, and without this the bar would stay thick with
            // nothing on it. Rien n'est validé : le doigt n'a pas été relâché, il a été repris —
            // et la barre revient là où en est le film.
            onTouchCancel={() => {
              const start = touchStartRef.current;
              seekingRef.current = false;
              touchDragRef.current = false;
              lastTouchXRef.current = null;
              touchStartRef.current = null;
              if (start?.target != null) previewSeek(videoRef.current?.currentTime ?? start.time);
              setPreviewTime(null);
              showControls(5000);
            }}
          >
            {/* The rail at rest. Painted here rather than left to the native track, which cannot
                be sized at all without giving up `accent-color` — and giving that up is what
                lets the bar answer to a finger as well as to a pointer. */}
            <div className={`player-seek-rail pointer-events-none absolute top-1/2 w-full -translate-y-1/2 rounded-full bg-white/20 transition-[height] duration-[260ms] ease-[cubic-bezier(0.33,1,0.68,1)] ${scrubbing ? "h-3" : "h-2"}`} />
            {/* Buffered range — deliberately subtle (a slightly lighter track, not a bold
                second color): its only job is "can I scrub ahead without waiting", not
                competing for attention with the actual playback position. Sits under the
                native range input's own track, which only leaves it visible in the *unplayed*
                portion — exactly the part worth showing. */}
            {downloadedFraction !== undefined && downloadedFraction > 0 && (
              <div
                data-downloaded-range=""
                // Plus sombre que la partie lue, nettement (Louis, 19/10/2026 : l'écart ne se voyait pas).
                className={`pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full bg-white/25 transition-[height] duration-[260ms] ease-[cubic-bezier(0.33,1,0.68,1)] ${scrubbing ? "h-3" : "h-2"}`}
                style={{ width: `${Math.min(100, downloadedFraction * 100)}%`, WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
              />
            )}
            {/* Pas dans le lecteur hors ligne : la partie téléchargée y tient ce rôle, et les deux
                ensemble faisaient quatre teintes sur une barre qui doit en avoir trois (Louis, 19/10/2026). */}
            {downloadedFraction === undefined && duration > 0 && bufferedEnd > 0 && (
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
                if (inputPointerRef.current === "touch") return;
                if (!mouseDragRef.current && !touchDragRef.current) previewSeek(Number(e.target.value));
              }}
              onPointerDown={(e) => {
                inputPointerRef.current = e.pointerType;
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
              //
              // Les autres touches d'un curseur natif (Début, Fin, Page préc./suiv., ↑ ↓) déplaçaient la
              // valeur de l'input sans saut : l'aperçu suivait, puis le tic suivant le ramenait à la
              // vraie position (audit du lecteur, 22/10/2026 — jamais validées, même avant 31bf7599).
              // Retenues ici aussi ; Début, Fin et les pages sautent par le même `skip` que les
              // flèches (Début au commencement, Fin à la fin, une minute par page). ↑ ↓ ne sautent
              // pas : sur une télécommande, ils ne font que montrer les commandes (l'écouteur de la
              // fenêtre, qui ne traite aucune des quatre autres — rien n'est fait deux fois).
              onKeyDown={(e) => {
                inputPointerRef.current = "keyboard";
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.preventDefault();
                const barDelta =
                  e.key === "Home" ? -Infinity
                  : e.key === "End" ? Infinity
                  : e.key === "PageUp" ? 60
                  : e.key === "PageDown" ? -60
                  : null;
                if (barDelta === null && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                // Une combinaison reste au système, comme pour l'écouteur de la fenêtre.
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                e.preventDefault();
                if (barDelta === null || suspendedRef.current) return;
                skip(barDelta);
                showControls();
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

/** Le temps restant, signé « − » (U+2212) tant qu'il en reste. */
function remainingLabel(duration: number, currentTime: number): string {
  const left = Math.max(0, duration - currentTime);
  // Moins d'une seconde s'écrit « 0:00 » : sans signe, pas « −0:00 ».
  return left >= 1 ? `\u2212${formatTime(left)}` : formatTime(0);
}
