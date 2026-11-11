import { useMemo } from "react";
import { create } from "zustand";
import { browserLang, translate, type Key, type Lang } from "../lib/i18n";
import { AUTO_LEVELS, loadSettings, profileOf, saveSettings, type Quality, type QualityProfile, type Settings } from "../lib/settings";
import { isTouchDevice, type Unsupported } from "../lib/capability";
import type { AudioTrack, Span, SubtitleTrack } from "../media/api";
import type { Episode, Library, Title } from "../media/library";
import { FORCED_LABEL } from "../input/keyboardMouse";
import { IDLE_NET, type NetState } from "../net/types";
import type { QuizUi } from "../game/types";
import type { SeatId } from "../world/interactions";
import type { RoomId } from "../world/layout";

/**
 * L'état du mode, en un seul endroit.
 *
 * `phase` dit où en est la page ; `mode` dit, une fois dans le monde, qui tient le pointeur :
 * - `walk` : le pointeur est verrouillé, la souris tourne la tête ;
 * - `paused` : Échap a rendu le pointeur, le menu pause est ouvert ;
 * - `panel` : le panneau Laterna est ouvert, le pointeur sert à cliquer dedans ;
 * - `remote` : la télécommande (`ui/Remote.tsx`) est posée au bas de l'image, le pointeur sert à la toucher.
 *
 * Le rendu 3D ne lit ici que par sélecteurs (ou par `getState()` dans la boucle d'image) : une
 * valeur qui change à chaque image n'a rien à faire dans cet état.
 */
export type Phase = "checking" | "unsupported" | "loading" | "gate" | "world" | "lost" | "expired" | "leaving";
export type Mode = "walk" | "paused" | "panel" | "remote";

/**
 * La lecture. Deux sortes de champs, qu'il ne faut pas confondre :
 *
 * - **ce qui est voulu** (`itemId`, `wantPaused`, `seek`, `muted`) : posé par les commandes
 *   (`media/commands.ts`), et par elles seules. C'est la vérité ; le `<video>` s'y conforme
 *   (`media/playback.ts`), il n'en est jamais la source. Demain, ces mêmes champs pourront venir d'un
 *   état partagé entre plusieurs spectateurs (`docs/MULTIJOUEUR.md`) sans que rien d'autre ne change.
 * - **ce qui est observé** (`status`, `position`, `duration`, `waiting`, `error`, `method`) : ce que le
 *   `<video>` fait réellement, rapporté ici pour l'affichage.
 */
export interface Playback {
  status: "idle" | "loading" | "playing" | "paused" | "ended" | "error";
  itemId: string | null;
  title: string | null;
  /** Voulu : la lecture est-elle en pause ? */
  wantPaused: boolean;
  /** Voulu : un saut à faire. Chaque demande porte un numéro nouveau, pour qu'un même instant demandé deux fois soit rejoué. */
  seek: { to: number; n: number } | null;
  /** Observé : secondes. Mis à jour deux fois par seconde au plus — c'est l'affichage qui lit ceci. */
  position: number;
  duration: number;
  muted: boolean;
  /** Observé : le flux attend-il des données (mise en mémoire tampon) ? */
  waiting: boolean;
  error: string | null;
  /** Observé : DirectPlay, DirectStream ou Transcode — tel que la négociation l'a décidé. */
  method: string | null;
  /** Observé : les pistes du fichier ; voulu : celle que l'on écoute (`null` : le choix du serveur), celle que l'on lit (`null` : aucune). */
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  audioIndex: number | null;
  subtitleIndex: number | null;
  /** Observé : les repères de l'épisode (secondes), rendus par la négociation ; tous nuls pour un film. */
  markers: { intro: Span | null; recap: Span | null; credits: number | null };
  /**
   * Observé : l'épisode qui suit celui-ci dans sa série, et où le reprendre (`media/upNext.ts`) ; `null` pour
   * un film, un dernier épisode, ou tant que la liste n'est pas arrivée.
   */
  next: { itemId: string; title: string; from: number } | null;
}

/** Ce que l'invite au bas de l'image propose maintenant (`media/upNext.ts`), ou rien. */
export type Prompt =
  /** « Passer l'intro » ou « Passer le récap » : mène à `end`. */
  | { kind: "skip"; what: "intro" | "recap"; end: number }
  /** L'épisode suivant, dans `countdown` secondes — décompte arrêté pendant une pause (`running`). */
  | { kind: "next"; title: string; countdown: number; running: boolean }
  /** Trois épisodes enchaînés sans un geste : on demande au lieu de continuer. */
  | { kind: "stillThere"; title: string };

export const IDLE_PLAYBACK: Playback = { status: "idle", itemId: null, title: null, wantPaused: false, seek: null, position: 0, duration: 0, muted: false, waiting: false, error: null, method: null, audioTracks: [], subtitleTracks: [], audioIndex: null, subtitleIndex: null, markers: { intro: null, recap: null, credits: null }, next: null };

/**
 * Le panneau Laterna, en état pur : ce qui est chargé, cherché, ouvert. Aucun composant ne garde ceci
 * pour lui — le rendu d'aujourd'hui (du HTML posé dans le monde) n'en est qu'une lecture, et un rendu
 * en 3D (pour un casque) lirait exactement le même état et appellerait les mêmes actions.
 */
export interface PanelState {
  library: Library | null;
  libraryFailed: boolean;
  query: string;
  tab: "movies" | "series";
  /** La fiche ouverte. */
  opened: Title | null;
  episodes: { list: Episode[]; next: string | null } | null;
  episodesFailed: boolean;
  season: number | null;
}

export const EMPTY_PANEL: PanelState = { library: null, libraryFailed: false, query: "", tab: "movies", opened: null, episodes: null, episodesFailed: false, season: null };

export interface ImmersionState {
  phase: Phase;
  unsupported: Unsupported | null;
  mode: Mode;
  /** Le sous-écran du menu pause. */
  pauseView: "menu" | "settings" | "salons" | "stats";
  seated: boolean;
  /** L'écran que le visiteur peut ouvrir d'ici (touche d'action) — son identifiant, ou rien. */
  nearScreen: string | null;
  /** Peut-il s'asseoir d'ici (touche F) ? */
  /** Le siège qu'on peut prendre d'ici (canapé, lit, bain), et celui où l'on est installé. */
  nearSeat: SeatId | null;
  seatSpot: SeatId;
  /** La chose regardée de près sur laquelle on peut agir (`interactions.ts`). */
  nearThing: string | null;
  /** L'écran que le regard vise pendant une lecture (le clic y pose la télécommande), ou rien. */
  aimedScreen: string | null;
  /** Le chat vient d'être caressé (instant, en millisecondes). */
  petAt: number;
  pet: () => void;
  /** La pièce où se tient le visiteur : elle décide de ce qui se dessine et de ce qui s'entend. */
  room: RoomId;
  setRoom: (room: ImmersionState["room"]) => void;
  /** La mesure (« Mesurer », `bench/bench.ts`) : son avancement, ses résultats. `null` : jamais lancée. */
  bench: BenchState | null;
  setBench: (patch: Partial<BenchState>) => void;
  /** Des champs du profil de qualité forcés par le banc de rendu ; `null` en temps normal. */
  perfProfile: Partial<QualityProfile> | null;
  setPerfProfile: (profile: Partial<QualityProfile> | null) => void;
  /** Les lettres de déplacement reconnues sur ce clavier (« ZQSD », « WASD ») ; `null` : pas encore su. */
  keysSeen: string | null;
  setKeysSeen: (label: string) => void;
  /** La chaîne hi-fi : en marche ou non (la musique se tait d'elle-même pendant un film). */
  music: boolean;
  toggleMusic: () => void;
  /** La porte-fenêtre de la terrasse : ouverte ou non. */
  door: boolean;
  toggleDoor: () => void;
  /** Le feu du foyer : allumé ou non. */
  fire: boolean;
  toggleFire: () => void;
  /** Les lampes de chaque groupe de pièces : allumées ou non (les interrupteurs). */
  lamps: Record<"salon" | "sud" | "nuit", boolean>;
  toggleLamps: (group: "salon" | "sud" | "nuit") => void;
  /**
   * En salon, lampes, porte, feu et musique ne changent pas ici : l'intention part au service, et l'état ne bouge
   * qu'à son retour (`net/sync.ts` pose ce relais ; il rend `true` quand il a pris le geste). Seul, `null`.
   */
  sharedSink: ((key: string, value: unknown) => boolean) | null;
  setSharedSink: (sink: ((key: string, value: unknown) => boolean) | null) => void;
  /** La saisie du chat est ouverte (les touches vont au texte, pas au visiteur). */
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  /** La partie de « Devine le film » en cours ou finie (`game/quiz.ts`), ou rien. */
  quiz: QuizUi | null;
  setQuiz: (quiz: QuizUi | null) => void;
  /** La lumière précalculée est-elle en place ? Les lumières temps réel se réduisent alors à ce qui bouge. */
  baked: boolean;
  setBaked: (baked: boolean) => void;
  /** La scène est-elle chargée (textures, modèles) ? */
  sceneReady: boolean;
  /** Le téléchargement des paquets de décors, en octets (`lib/packs.ts`) ; `null` sans paquets (développement). */
  packs: { loaded: number; total: number } | null;
  setPacks: (packs: { loaded: number; total: number }) => void;
  lang: Lang;
  settings: Settings;
  /** Le niveau courant d'« Auto » (0 = Ultra) : réglé par le moniteur de performance, jamais gardé. */
  autoLevel: number;
  stepAuto: (delta: number) => void;
  playback: Playback;
  setPlayback: (patch: Partial<Playback>) => void;
  /** Le HUD de lecture se montre un instant à chaque geste (lecture, saut, son) : ce compteur le réveille. */
  hudWake: number;
  wakeHud: () => void;
  /** L'invite du moment (passer l'intro, épisode suivant), posée par `media/upNext.ts` seul. */
  prompt: Prompt | null;
  setPrompt: (prompt: Prompt | null) => void;
  setPhase: (phase: Phase) => void;
  setUnsupported: (why: Unsupported | null) => void;
  setMode: (mode: Mode) => void;
  setPauseView: (view: "menu" | "settings" | "salons" | "stats") => void;
  /** Les salons du chalet (`net/salons.ts`) : connexion, salon courant, salons publics. Écrit par ce module seul. */
  net: NetState;
  setNet: (patch: Partial<NetState>) => void;
  setSeated: (seated: boolean, spot?: SeatId) => void;
  setNear: (near: { screen: string | null; seat: SeatId | null; thing: string | null; aimed?: string | null }) => void;
  panel: PanelState;
  setPanel: (patch: Partial<PanelState>) => void;
  setSceneReady: (ready: boolean) => void;
  setLang: (lang: Lang) => void;
  updateSettings: (patch: Partial<Settings>) => void;
}

export const useStore = create<ImmersionState>((set, get) => ({
  phase: "checking",
  unsupported: null,
  mode: "paused",
  pauseView: "menu",
  seated: false,
  nearScreen: null,
  nearSeat: null,
  seatSpot: "sofa",
  nearThing: null,
  aimedScreen: null,
  petAt: 0,
  pet: () => set({ petAt: performance.now() }),
  room: "salon",
  baked: false,
  keysSeen: null,
  setKeysSeen: (keysSeen) => get().keysSeen !== keysSeen && set({ keysSeen }),
  music: false,
  toggleMusic: () => {
    const next = !get().music;
    if (!get().sharedSink?.("musique", next)) set({ music: next });
  },
  door: false,
  toggleDoor: () => {
    const next = !get().door;
    if (!get().sharedSink?.("porte", next)) set({ door: next });
  },
  fire: true,
  toggleFire: () => {
    const next = !get().fire;
    if (!get().sharedSink?.("feu", next)) set({ fire: next });
  },
  lamps: { salon: true, sud: true, nuit: true },
  toggleLamps: (group) => {
    const next = !get().lamps[group];
    if (!get().sharedSink?.(`lampes.${group}`, next)) set({ lamps: { ...get().lamps, [group]: next } });
  },
  sharedSink: null,
  setSharedSink: (sharedSink) => set({ sharedSink }),
  chatOpen: false,
  setChatOpen: (chatOpen) => get().chatOpen !== chatOpen && set({ chatOpen }),
  quiz: null,
  setQuiz: (quiz) => set({ quiz }),
  bench: null,
  setBench: (patch) => set({ bench: { ...(get().bench ?? EMPTY_BENCH), ...patch } }),
  perfProfile: null,
  setPerfProfile: (perfProfile) => set({ perfProfile }),
  setBaked: (baked) => get().baked !== baked && set({ baked }),
  setRoom: (room) => get().room !== room && set({ room }),
  sceneReady: false,
  packs: null,
  setPacks: (packs) => set({ packs }),
  lang: browserLang(),
  settings: loadSettings(),
  // Au doigt (téléphone, tablette), « Auto » part bas et remonte si la machine suit — l'inverse d'un ordinateur.
  autoLevel: isTouchDevice() ? 6 : 0,
  stepAuto: (delta) => {
    const next = Math.max(0, Math.min(AUTO_LEVELS.length - 1, get().autoLevel + delta));
    if (next !== get().autoLevel) set({ autoLevel: next });
  },
  playback: IDLE_PLAYBACK,
  setPlayback: (patch) => set({ playback: { ...get().playback, ...patch } }),
  hudWake: 0,
  wakeHud: () => set({ hudWake: get().hudWake + 1 }),
  prompt: null,
  setPrompt: (prompt) => {
    const now = get().prompt;
    // Recalculée deux fois par seconde : ne rien redessiner quand elle dit la même chose.
    if (JSON.stringify(now) !== JSON.stringify(prompt)) set({ prompt });
  },
  setPhase: (phase) => set({ phase }),
  setUnsupported: (unsupported) => set({ unsupported, phase: unsupported ? "unsupported" : "loading" }),
  setMode: (mode) => set(mode === "paused" ? { mode } : { mode, pauseView: "menu" }),
  setPauseView: (pauseView) => set({ pauseView }),
  net: IDLE_NET,
  setNet: (patch) => set({ net: { ...get().net, ...patch } }),
  setSeated: (seated, spot) => set(spot ? { seated, seatSpot: spot } : { seated }),
  setNear: ({ screen, seat, thing, aimed = null }) => {
    const s = get();
    if (s.nearScreen !== screen || s.nearSeat !== seat || s.nearThing !== thing || s.aimedScreen !== aimed) set({ nearScreen: screen, nearSeat: seat, nearThing: thing, aimedScreen: aimed });
  },
  panel: EMPTY_PANEL,
  setPanel: (patch) => set({ panel: { ...get().panel, ...patch } }),
  setSceneReady: (sceneReady) => set({ sceneReady }),
  setLang: (lang) => {
    document.documentElement.lang = lang;
    set({ lang });
  },
  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    saveSettings(settings);
    set({ settings });
  },
}));

/** Le traducteur de la langue courante. */
export function useT(): (key: Key) => string {
  const lang = useStore((s) => s.lang);
  return (key) => translate(lang, key);
}

export interface BenchState {
  running: boolean;
  /** Le préréglage du passage en cours. */
  preset: Quality | null;
  video: boolean;
  /** Avancement du passage en cours, de 0 à 1. */
  progress: number;
  step: number;
  steps: number;
  results: { preset: Quality; video: boolean; fps: number; low1: number; width: number; height: number }[];
}
const EMPTY_BENCH: BenchState = { running: false, preset: null, video: false, progress: 0, step: 0, steps: 0, results: [] };

/** Le profil de qualité en vigueur. Une référence stable par niveau : rien ne se redessine pour rien. */
export function useProfile(): QualityProfile {
  // Pendant une mesure, c'est elle qui choisit le préréglage — sans toucher aux réglages gardés.
  const profile = useStore((s) => profileOf(s.bench?.running && s.bench.preset ? s.bench.preset : s.settings.quality, s.autoLevel));
  // Le banc de rendu (`tests/perf.mjs`) peut forcer des champs du profil, pour mesurer ce que chacun coûte.
  const forced = useStore((s) => s.perfProfile);
  return useMemo(() => (forced ? { ...profile, ...forced } : profile), [profile, forced]);
}

/** Les lettres des touches de déplacement à afficher : celles du réglage s'il force une disposition, sinon celles reconnues. */
export function useMovementKeys(): string {
  return useStore((s) => (s.settings.keyboard === "auto" ? (s.keysSeen ?? "WASD") : FORCED_LABEL[s.settings.keyboard]));
}
