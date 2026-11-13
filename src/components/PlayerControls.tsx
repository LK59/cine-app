"use client";

import type { TrickplayInfo } from "@/lib/trickplayTile";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Play, Pause, Maximize, Minimize, Captions, AudioLines, Loader2, RotateCcw, RotateCw, EllipsisVertical, SkipForward, Layers, ChevronRight, UsersRound, X } from "lucide-react";
import type { DialogueMode } from "@/lib/webcodecs/dialogueEnhance";
import type { HdrCapChoice } from "@/lib/webcodecs/hdrDisplay";
import { useT } from "@/components/TranslationProvider";
import { createLiquidPress, prefersReducedMotion } from "@/lib/liquidGlass/liquid";
import { usePrewarmEpisodes } from "@/components/player/PlayerEpisodesMenu";
import { usePlayerItem } from "@/lib/usePlayerItem";
import { useCastAvailability, type CastVideoElement } from "@/components/playerControls/useCastAvailability";
import { useSystemPip } from "@/components/playerControls/useSystemPip";
import { useChapters, useTrickplay } from "@/components/playerControls/useTrickplay";
import { PlayerTopBar } from "@/components/playerControls/PlayerTopBar";
import { PlayerPrompts } from "@/components/playerControls/PlayerPrompts";
import { useSceneRestart } from "@/components/playerControls/useSceneRestart";
import { useReplaySubtitles, type ReplaySubtitleHost } from "@/components/playerControls/useReplaySubtitles";
import { ONSCREEN_FOLD_HIDDEN_MS, onScreenOpenFor, setOnScreenOpen } from "@/lib/onScreenSession";
import { PlayerNextUp } from "@/components/playerControls/PlayerNextUp";
import { PlayerSettingsMenu, type MenuView } from "@/components/playerControls/PlayerSettingsMenu";
import { BOTTOM_EDGE, PROMPT_BOTTOM } from "@/components/playerControls/layout";
import { usePlayerKeyboard } from "@/components/playerControls/usePlayerKeyboard";
import { usePlaybackMirror, useElementMirror } from "@/components/playerControls/usePlaybackMirror";
import { useVolumeControl } from "@/components/playerControls/useVolumeControl";
import { useLatest } from "@/components/playerControls/useLatest";
import { useAutoHide } from "@/components/playerControls/useAutoHide";
import { PlayerSeekBar } from "@/components/playerControls/PlayerSeekBar";
import { AskPanel } from "@/components/ask/AskPanel";
import { prewarmSofar, sofarPosition, startSofar, useAskAvailable, useAskPersonAvailable, useAskPrepare, useSofarAvailable } from "@/lib/ask/client";
import { PlayerOnScreen } from "@/components/playerControls/PlayerOnScreen";
import { useXrayUiDiag } from "@/lib/xrayUiDiag";
import { noteXrayOffered, noteXrayScene, noteXrayTap } from "@/lib/xrayUsage";
import { useOnScreenPlacement } from "@/components/playerControls/useOnScreenPlacement";
import { onScreenPeople, sceneAt, useXrayAvailable, useXrayScenes } from "@/lib/xray/client";
import type { XrayPlayerPerson } from "@/lib/xray/scenes";
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
  /**
   * Les sous-titres d'un passage rejoué (§150, `useReplaySubtitles`) : la piste que l'hôte montrerait, et de
   * quoi la montrer sur une voie à part. Absent : jamais d'aide (un hôte sans sous-titres à montrer).
   */
  replaySubtitle?: ReplaySubtitleHost;
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
  /**
   * « Poser une question » (DECISIONS.md §139), film en pause : faux pour le lecteur hors ligne — le
   * fichier est sur l'appareil, le réseau souvent absent. Partout ailleurs l'option décide seule
   * (`useAskAvailable`).
   */
  askable?: boolean;
  /**
   * « À l'écran » (DECISIONS.md §138), film en pause : faux pour le lecteur hors ligne, comme `askable`.
   * Partout ailleurs l'option décide seule (`useXrayAvailable`).
   */
  xrayable?: boolean;
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
  replaySubtitle,
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
  askable = true,
  xrayable = true,
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
  const { volumeSettable, probeVolume, toggleMute, changeVolume } = useVolumeControl(videoRef);
  const [visible, setVisible] = useState(true);
  /**
   * Masqués, les contrôles ne prennent la position qu'une fois par seconde (28/09/2026). Chaque
   * `timeupdate` (~4 par seconde) faisait recalculer tout ce composant, même invisible — du travail
   * pour rien, et de quoi réveiller l'affichage. Une seconde suffit à ce qui en dépend quand rien
   * n'est affiché (« Passer l'intro », le compte à rebours de l'épisode suivant) ; affichés, le
   * `timeupdate` suivant les remet à la seconde près.
   */
  const visibleRef = useLatest(visible);
  const topRowRef = useRef<HTMLDivElement>(null);
  const bottomRowRef = useRef<HTMLDivElement>(null);
  /**
   * Ce que les commandes occupent, mesuré plutôt que supposé : la rangée du bas va de 110 px sur un
   * téléphone à plus de 150 au bureau, selon le titre (logo ou texte, une ou deux lignes) et la zone
   * sûre. Remesurée quand une rangée change de taille (rotation, titre chargé) ; cachées, `null`.
   * Les rangées glissent de 4 px en apparaissant (`translate-y-1`) : la mesure prise pendant ce
   * glissement est fausse d'autant au plus, et la suivante la corrige.
   */
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
    // Le bouton rond de la question (§139) est une cible comme le rond seul des commandes (10.29.1) : la même
    // marge de toucher, et il s'allume sous le doigt.
    const press = createLiquidPress({ targets: ".player-pill-btn, .player-center-btn, .player-capsule, .player-ask-btn, .player-onscreen-toggle" });
    // Les pilules d'« À l'écran » (§138, 10.29.1) : le geste des boutons posés dans ce qu'on fait glisser
    // (`data-liquid-pan="press"`, le même que `useLiquidDelegation`) — elles gonflent à l'appui et rebondissent au
    // relâchement, et rendent la main dès que le doigt part de côté (la rangée défile, et le clic natif n'a pas
    // lieu). Un appui sur une rangée qui défile encore (l'élan d'iOS, `data-onscreen-scrolling`) ne fait que
    // l'arrêter : rien ne gonfle.
    const inRow = createLiquidPress({ targets: "[data-liquid-pan]", strength: 0.4, yieldAfter: 8 });
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
      const pill = target?.closest?.<HTMLElement>('[data-liquid-pan="press"]');
      if (pill && root.contains(pill)) {
        if (!pill.closest("[data-onscreen-scrolling]")) inRow.down(e, pill);
        return;
      }
      const surface = target?.closest?.<HTMLElement>("[data-liquid]");
      if (surface && root.contains(surface)) press.down(e, surface);
    };
    root.addEventListener("pointerdown", onDown);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      press.dispose();
      soft.dispose();
      inRow.dispose();
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
  // « Regarder le générique » écarte l'écran jusqu'à la fin de l'épisode, où il revient avec son
  // décompte : le générique regardé jusqu'au bout enchaîne quand même (26/10/2026).
  const inCredits = nextUpFrom != null && currentTime >= nextUpFrom && !!nextEpisode && !sleepBlocksAdvance;
  const showNextUp = inCredits && (!nextUpDismissed || atEnd);
  // Pendant le générique regardé : un bouton discret pour passer quand même à la suite.
  const creditsNextPill = inCredits && nextUpDismissed && !atEnd && !castActive;

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
  const { pipSupported, pipActive, togglePip } = useSystemPip(videoRef);

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

  /**
   * « Poser une question » (§139) : le panneau ouvert, les commandes ne se cachent plus (`held`) et
   * n'écoutent plus le clavier (`suspended`) — espace, flèches, F ou M écrivent dans le champ ou ne font
   * rien, jamais lecture ni saut. Refermé quand l'élément change ou que les commandes se cachent pour
   * un écran d'erreur. Une ouverture = une conversation : ses échanges vivent dans le panneau.
   */
  const askOffered = useAskAvailable() && askable && !lab;
  // Le panneau d'une personne (§139, 09/11/2026) : ses questions et « Jusqu'ici » ont chacun leur réglage.
  const askPersonOffered = useAskPersonAvailable() && askable && !lab;
  const sofarOffered = useSofarAvailable() && askable && !lab;
  const [askOpen, setAskOpen] = useState(false);
  // La personne touchée dans « À l'écran » et sa scène : le panneau s'ouvre sur elle.
  // `sofarAt` : la position lue au toucher (10.28.1) — la même pour la demande de « Jusqu'ici » et pour le panneau.
  const [askPerson, setAskPerson] = useState<{ person: XrayPlayerPerson; scene: XrayPlayerPerson[]; sofarAt: number | null } | null>(null);
  const [askFor, setAskFor] = useState({ itemId, hidden });
  if (askFor.itemId !== itemId || askFor.hidden !== hidden) {
    setAskFor({ itemId, hidden });
    if (askOpen) setAskOpen(false);
  }
  /**
   * « À l'écran » (§138) : les scènes lues une fois à l'ouverture de l'élément (relues pendant l'analyse),
   * la scène de l'instant cherchée ici à chaque rendu en pause — aucune requête à la pause. Seulement
   * l'option allumée pour ce compte, hors banc et hors lecteur hors ligne ; jamais pendant une diffusion.
   */
  const xrayOffered = useXrayAvailable() && xrayable && !lab;
  const xrayPayload = useXrayScenes(itemId, xrayOffered);
  /**
   * « Revenir au début de la scène » (§143) : décidé une fois par séance sur ces mêmes scènes, à la première
   * image ; montré seulement au public réglé (`SCENE_RESTART_ENABLED`, coupé par défaut) — voir `useSceneRestart`.
   */
  /** Les sous-titres d'un passage rejoué (§150) : ouverts par un recul de −10 s, fermés à la fin du passage. */
  const replay = useReplaySubtitles({ itemId, videoRef, host: replaySubtitle, onChangeSubtitle });
  const sceneRestart = useSceneRestart({
    itemId,
    offered: xrayOffered,
    payload: xrayPayload,
    currentTime,
    playing,
    settled: !loading && !openingQuiet && !resuming,
    castActive: !!castActive,
    introSkip,
    recapSkip,
    creditsStart,
  });
  /**
   * La rangée « À l'écran » et le bouton de la question : jamais panneau ouvert, pendant une reprise, l'ouverture
   * du film ou une diffusion. La scène de l'instant se cherche en mémoire à chaque rendu — aucune requête.
   *
   * **Masquée par défaut, ouverte à la demande** (13/11/2026, retour de Louis sur iPhone) : affichée avec les
   * commandes à chaque fois (10.27), elle chargeait l'écran et cachait les sous-titres, pour 5 séances où quelqu'un
   * l'a touchée en deux jours. Un bouton rond, à gauche juste au-dessus du titre — là où la rangée paraît —, l'ouvre
   * et devient une croix ; un glissement au doigt (haut : ouvrir, bas : fermer) et la touche I font de même. Le
   * choix tient la séance (`onScreenSession.ts`) ; elle suit les commandes, et se replie après une minute de
   * commandes cachées (`ONSCREEN_FOLD_HIDDEN_MS`). Le bouton de la question n'existe que dans la rangée ouverte. Montée tant qu'elle peut servir, pour que l'ouverture et la
   * fermeture s'animent (`data-onscreen-open`).
   */
  // Une fiche d'acteur ouverte laisse la rangée en place (13/11/2026) : on passe d'un acteur à l'autre sans la voir
  // disparaître (`onBackdropTap` du panneau), et un toucher ailleurs referme la fiche.
  const rowAllowed = !resuming && !loading && !openingQuiet && !castActive;
  const sceneNow = xrayOffered && rowAllowed ? sceneAt(xrayPayload, currentTime) : null;
  const scenePeople = onScreenPeople(sceneNow);
  // Le relevé `xray-ui` de cette séance (10.29.1, `xrayUiDiag.ts`) : la rangée, les touchers, le panneau.
  const xrayDiag = useXrayUiDiag(itemId);
  // Le bouton de la question n'est plus dans le lecteur (13/11/2026, Louis : celui de la fiche du titre suffit, et
  // poser une question en regardant n'est pas ergonomique) : la rangée n'existe que par les personnes à l'écran.
  const rowShown = rowAllowed && scenePeople.length > 0;
  const onScreenAvailable = rowAllowed && xrayOffered && (xrayPayload?.scenes.length ?? 0) > 0;
  const [onScreenOpen, setOnScreenOpenState] = useState(() => onScreenOpenFor(itemId));
  const rowOpen = onScreenAvailable && onScreenOpen;
  const openOnScreen = (open: boolean) => {
    if (!onScreenAvailable || open === onScreenOpen) return;
    setMenu(null);
    setOnScreenOpenState(open);
    setOnScreenOpen(itemId, open);
  };
  const toggleOnScreen = () => openOnScreen(!onScreenOpen);
  // Dépliée, elle suit les commandes : cachées puis rappelées, elle revient avec elles. Mais **une minute sans
  // commandes** (Louis, 13/11/2026) veut dire qu'on regarde le film, pas « À l'écran » : elle se replie sans bruit,
  // et les commandes rappelées ensuite reviennent sans elle. Le minuteur vit dans un effet ; l'état change dans son
  // rappel, jamais dans le corps de l'effet.
  useEffect(() => {
    if (visible || !onScreenOpen) return;
    const timer = window.setTimeout(() => {
      setOnScreenOpenState(false);
      setOnScreenOpen(itemId, false);
    }, ONSCREEN_FOLD_HIDDEN_MS);
    return () => window.clearTimeout(timer);
  }, [visible, onScreenOpen, itemId]);
  // L'usage, porté par le bilan `stop` (`xrayUsage.ts`, 11/11/2026) : l'option proposée, chaque scène où la rangée
  // a paru avec quelqu'un, commandes visibles. Rien sans l'option — le bilan reste celui d'avant.
  const usageScene = xrayOffered && visible && rowOpen && rowShown && scenePeople.length > 0 && sceneNow ? sceneNow.start : null;
  useEffect(() => {
    if (xrayOffered) noteXrayOffered(itemId);
  }, [itemId, xrayOffered]);
  useEffect(() => {
    if (usageScene !== null) noteXrayScene(itemId, usageScene);
  }, [itemId, usageScene]);
  const onScreenWrapRef = useRef<HTMLDivElement>(null);
  // Ce que les commandes occupent, à éviter par les sous-titres — voir plus haut (déclaré ici pour lire `rowOpen`).
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
    // « À l'écran » ouvert (13/11/2026) : les sous-titres passent au-dessus de la rangée, pas dessous — affichée
    // avec les commandes, elle cachait la réplique. Mesurée sur sa place d'arrivée (`offsetTop`), pas pendant son
    // glissement d'ouverture.
    const wrap = rowOpen ? onScreenWrapRef.current : null;
    const measure = () => {
      const area = root.getBoundingClientRect();
      const bottomTop = bottom.getBoundingClientRect().top - area.top;
      const wrapTop = wrap ? wrap.offsetTop : Infinity;
      onChromeEdges({
        top: top.getBoundingClientRect().bottom - area.top,
        bottom: area.height - Math.min(bottomTop, wrapTop),
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const el of [root, top, bottom, ...(wrap ? [wrap] : [])]) observer.observe(el);
    return () => observer.disconnect();
  }, [visible, hidden, onChromeEdges, rowOpen]);
  const centerGroupRef = useRef<HTMLDivElement>(null);
  const titleRowRef = useRef<HTMLDivElement>(null);
  const onScreenPlace = useOnScreenPlacement({ wrap: onScreenWrapRef, center: centerGroupRef, titleRow: titleRowRef, tools: settingsPillRef }, onScreenAvailable);
  // Le film s'ouvre, une des trois portes ouverte à la séance (10.27.2, §139) : le serveur prépare le contexte
  // des questions et de « Jusqu'ici » (l'élément, ses épisodes, les répliques) — `prepareAskContext`. Une fois
  // par élément.
  useAskPrepare(itemId, askOffered || askPersonOffered || sofarOffered);
  /**
   * « Jusqu'ici » préparé sur une intention seulement (§139, 10.27.2) : le pointeur fin posé sur une pilule
   * (`onIntent` de `PlayerOnScreen`) — une personne, à la position de l'instant, coupée comme le serveur
   * (`sofarCut` sur ces scènes). La rangée qui paraît ne prépare rien.
   */
  const intentAt = useLatest(currentTime);
  const pickPerson = (person: XrayPlayerPerson) => {
    // « Jusqu'ici » part au toucher même (10.27.2), avant le panneau et ses requêtes ; le panneau reprend cette
    // demande (`useSofar`). La position est lue **une fois**, ici (10.28.1) : la demande et le panneau prennent le
    // même nombre, donc la même coupe — à une limite de tranche, l'heure affichée et celle que le panneau
    // relisait donnaient deux clés.
    noteXrayTap(itemId, person.personId);
    const at = positionNow ? positionNow() : (videoRef.current?.currentTime ?? null);
    const sofarAt = sofarOffered ? startSofar(itemId, person.personId, at, xrayPayload) : sofarPosition(at);
    setMenu(null);
    // Une personne ouvre son panneau — avec les questions et « Jusqu'ici » si l'option est ouverte à ce compte,
    // sinon la personne seule (photo, faits, biographie, ses titres).
    setAskPerson({ person, scene: scenePeople, sofarAt });
    setAskOpen(true);
  };
  const onPersonIntent = sofarOffered
    ? (person: XrayPlayerPerson) => prewarmSofar(itemId, person.personId, intentAt.current, xrayPayload)
    : undefined;
  const { suspendedRef, showControls, holdControls, toggleControls, windowExitHides } = useAutoHide({
    visible,
    setVisible,
    playing,
    suspended: suspended || askOpen,
    held: askOpen,
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
  // Le glissement d'« À l'écran » au doigt (13/11/2026) : vers le haut ouvre, vers le bas ferme — sur l'image seule,
  // commandes affichées, un doigt, franc (50 px au moins, nettement plus vertical qu'horizontal, en moins de 0,6 s).
  const swipeRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const swipedRef = useRef(false);
  function onSurfaceTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    // Un doigt qui a glissé de 50 px n'est suivi d'aucun `click` : le drapeau d'un glissement précédent restait
    // levé et avalait le `click` du toucher suivant — commandes ni masquées ni rappelées (13/11/2026). Un `click`
    // émis malgré tout après un glissement arrive avant tout nouveau `touchstart` : il reste avalé.
    swipedRef.current = false;
    const touch = e.touches[0];
    swipeRef.current =
      e.touches.length === 1 && touch && isEmptySurface(e.target, e.currentTarget) ? { x: touch.clientX, y: touch.clientY, at: Date.now() } : null;
  }
  function onSurfaceTouchEnd(e: React.TouchEvent<HTMLDivElement>) {
    const start = swipeRef.current;
    swipeRef.current = null;
    const touch = e.changedTouches[0];
    if (!start || !touch || !visible || !onScreenAvailable) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Date.now() - start.at > 600 || Math.abs(dy) < 50 || Math.abs(dy) < Math.abs(dx) * 1.5) return;
    swipedRef.current = true;
    openOnScreen(dy < 0);
    showControls();
  }

  function onSurfaceClick(e: React.MouseEvent<HTMLDivElement>) {
    // Un glissement n'est pas un toucher : ni commandes masquées, ni pause.
    if (swipedRef.current) {
      swipedRef.current = false;
      return;
    }
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
  function seekElement(video: HTMLVideoElement, time: number, replayRewind = false) {
    // Un saut avant la première image refuse « Revenir au début de la scène » ; pendant qu'il est montré, le retire.
    sceneRestart.noteSeek();
    // Tout autre saut que le recul d'un passage rejoué ferme son aide (§150) ; `skip` dit lui-même lequel il est.
    if (!replayRewind) replay.end();
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
    seekElement(video, target, true);
    // Lu avant le saut : la position d'où l'on recule est la fin du passage à sous-titrer (§150).
    replay.noteSkip(deltaSeconds, from);
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

  usePlayerKeyboard(togglePlay, skip, showControls, suspendedRef, toggleOnScreen);

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
      onTouchStart={onSurfaceTouchStart}
      onTouchEnd={onSurfaceTouchEnd}
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

      {showNextUp && !askStillThere && nextEpisode && !castActive && (
        <PlayerNextUp
          key={nextEpisode.itemId}
          videoRef={videoRef}
          seriesId={playerItem?.seriesId ?? null}
          nextEpisode={nextEpisode}
          countdown={nextUpCountdown}
          total={NEXT_UP_COUNTDOWN_S}
          running={nextUpRunning}
          onPlay={() => {
            noteViewerPresent();
            requestAdvance();
          }}
          onWatchCredits={() => {
            setNextUpDismissed(true);
            // Les commandes, le temps de voir où l'on en est : revenir au générique les montrait cachées.
            showControls();
          }}
        />
      )}
      {creditsNextPill && nextEpisode && (
        <button
          type="button"
          data-player-surface-ignore
          data-player-credits-next=""
          onClick={(e) => {
            e.stopPropagation();
            noteViewerPresent();
            requestAdvance();
          }}
          data-liquid
          className="player-pill pointer-events-auto absolute z-30 flex items-center gap-1.5 py-2.5 pl-4 pr-3 text-sm font-medium text-white"
          style={{ bottom: PROMPT_BOTTOM, right: "max(1rem, env(safe-area-inset-right))" }}
        >
          {t("player.nextUp.label")}
          <ChevronRight size={16} aria-hidden />
        </button>
      )}
      <PlayerPrompts
        skipNow={skipNow}
        onSkip={(end) => {
          if (videoRef.current) seekElement(videoRef.current, end);
        }}
        // « Passer l'intro / le récap » garde la priorité : une invite à la fois, au même endroit.
        sceneRestart={skipNow ? null : sceneRestart.prompt}
        onSceneRestart={() => sceneRestart.use((target) => commitSeek(target))}
        replaySubtitle={replay.notice}
        onKeepReplaySubtitle={replay.keep}
        sleepWarning={sleepWarning}
        askStillThere={askStillThere}
        // La petite carte ne reste que pour une diffusion : l'image est sur le téléviseur.
        showNextUp={showNextUp && !!castActive}
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
          pip={{ supported: pipSupported, active: pipActive, toggle: togglePip }}
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
            onChangeAudio={(id) => {
              // Un changement de piste avant la première image refuse « Revenir au début de la scène » (§143).
              sceneRestart.noteTrack();
              onChangeAudio(id);
            }}
            subtitleTracks={subtitleTracks}
            currentSubtitleId={currentSubtitleId}
            onChangeSubtitle={(id) => {
              // Un choix dans le menu remplace l'aide d'un passage rejoué (§150).
              replay.end();
              onChangeSubtitle(id);
            }}
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
          <div ref={centerGroupRef} data-player-navgroup="center" className={`${visible ? "pointer-events-auto" : "pointer-events-none"} absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-9 sm:gap-12 max-[379px]:gap-6`}>
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

        {/* « À l'écran » (§138) et le bouton de la question (§139), juste au-dessus du bloc du titre, à gauche — loin
            de « Passer l'intro » et de l'épisode suivant, posés à droite ; la rangée va aussi loin que possible à droite
            et ne s'arrête avant les boutons du centre (ou la pilule des outils) que s'ils partagent sa hauteur
            (`useOnScreenPlacement`, 10.27.1). Depuis le 13/11/2026, **masquée par défaut** : le bouton rond de gauche
            l'ouvre — elle sort de lui vers la droite, pilule après pilule — et devient une croix qui la referme. Plus de
            bouton de la question dans le lecteur : il reste sur la fiche du titre. */}
        {onScreenAvailable &&
          (() => {
            return (
              <div
                ref={onScreenWrapRef}
                data-onscreen-wrap=""
                data-onscreen-open={rowOpen ? "true" : "false"}
                className="player-chrome-x pointer-events-none absolute inset-x-0 flex items-end gap-2"
                style={{ bottom: onScreenPlace.bottom ?? PROMPT_BOTTOM }}
              >
                <button
                  type="button"
                  data-player-nav="onscreen"
                  data-player-surface-ignore
                  aria-label={t("xray.onScreen")}
                  title={t("xray.onScreen")}
                  aria-expanded={rowOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleOnScreen();
                    showControls();
                  }}
                  data-liquid
                  className={`player-fade player-pill player-onscreen-toggle ${visible ? "pointer-events-auto" : "pointer-events-none"} flex shrink-0 items-center justify-center text-white`}
                >
                  <UsersRound size={20} aria-hidden className="player-onscreen-toggle-people" />
                  <X size={20} aria-hidden className="player-onscreen-toggle-close" />
                </button>
                {/* Les pilules jusqu'au bord de l'écran (Louis, 13/11/2026) : au bout de la rangée, le bouton de la
                    question laissait au milieu de l'écran une pilule tranchée sous le voile. */}
                <div data-onscreen-body="" inert={!rowOpen} className="flex min-w-0 flex-1 items-end gap-2">
                  {rowShown && (
                    <div className="min-w-0 flex-1">
                      <PlayerOnScreen
                        people={scenePeople}
                        visible={visible && rowOpen}
                        maxWidth={onScreenPlace.maxWidth}
                        // Toucher ou faire défiler la rangée tient les commandes affichées ; la fin du geste relance
                        // leur décompte ordinaire (10.27.2 — elles partaient sous le doigt).
                        onHold={holdControls}
                        onIntent={onPersonIntent}
                        onRelease={() => showControls(10000)}
                        onPick={pickPerson}
                        diag={xrayDiag}
                        sceneStart={sceneNow?.start ?? null}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

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
          <div ref={titleRowRef} className="flex items-end gap-3">
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
          <PlayerSeekBar
            videoRef={videoRef}
            seekingRef={seekingRef}
            suspendedRef={suspendedRef}
            currentTime={currentTime}
            duration={duration}
            bufferedEnd={bufferedEnd}
            downloadedFraction={downloadedFraction}
            chapters={chapters}
            trickplay={trickplay}
            trickplayTileAt={trickplayTileAt}
            previewSeek={previewSeek}
            commitSeek={commitSeek}
            skip={skip}
            showControls={showControls}
            holdControls={holdControls}
            windowExitHides={windowExitHides}
          />
        </div>
      </div>
      {askOpen && (
        <AskPanel
          // Une autre personne : un autre panneau — sa propre entrée, ses propres demandes.
          key={askPerson ? `personne:${askPerson.person.personId}` : "question"}
          itemId={itemId}
          where="lecteur"
          placement="player"
          position={() => (positionNow ? positionNow() : (videoRef.current?.currentTime ?? null))}
          sofarPosition={askPerson?.sofarAt}
          person={askPerson?.person}
          scene={askPerson?.scene}
          scenes={xrayPayload}
          diag={xrayDiag}
          ask={askPerson ? askPersonOffered : askOffered}
          sofar={sofarOffered}
          onBackdropTap={(x, y) => {
            // Une autre pilule d'« À l'écran », visible à travers le fond : sa fiche, à la place de celle-ci.
            const pills = onScreenWrapRef.current?.querySelectorAll<HTMLElement>("[data-onscreen-person]") ?? [];
            for (const pill of pills) {
              const box = pill.getBoundingClientRect();
              // Une pilule sans taille (pas encore posée, ou qui s'efface) n'attrape rien.
              if (box.width === 0 || box.height === 0) continue;
              if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
              const person = scenePeople.find((p) => String(p.personId) === pill.dataset.onscreenPerson);
              if (!person || !rowOpen) return false;
              pickPerson(person);
              return true;
            }
            return false;
          }}
          onClose={() => {
            setAskOpen(false);
            setAskPerson(null);
            showControls();
          }}
        />
      )}
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
