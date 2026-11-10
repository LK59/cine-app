import { create } from "zustand";
import { browserLang, translate, type Key, type Lang } from "../lib/i18n";
import { AUTO_LEVELS, loadSettings, profileOf, saveSettings, type Quality, type QualityProfile, type Settings } from "../lib/settings";
import type { Unsupported } from "../lib/capability";
import type { Episode, Library, Title } from "../media/library";

/**
 * L'état du mode, en un seul endroit.
 *
 * `phase` dit où en est la page ; `mode` dit, une fois dans le monde, qui tient le pointeur :
 * - `walk` : le pointeur est verrouillé, la souris tourne la tête ;
 * - `paused` : Échap a rendu le pointeur, le menu pause est ouvert ;
 * - `panel` : le panneau Laterna est ouvert, le pointeur sert à cliquer dedans.
 *
 * Le rendu 3D ne lit ici que par sélecteurs (ou par `getState()` dans la boucle d'image) : une
 * valeur qui change à chaque image n'a rien à faire dans cet état.
 */
export type Phase = "checking" | "unsupported" | "loading" | "gate" | "world" | "lost" | "expired" | "leaving";
export type Mode = "walk" | "paused" | "panel";

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
}

export const IDLE_PLAYBACK: Playback = { status: "idle", itemId: null, title: null, wantPaused: false, seek: null, position: 0, duration: 0, muted: false, waiting: false, error: null, method: null };

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
  pauseView: "menu" | "settings";
  seated: boolean;
  /** L'écran que le visiteur peut ouvrir d'ici (touche d'action) — son identifiant, ou rien. */
  nearScreen: string | null;
  /** Peut-il s'asseoir d'ici (touche F) ? */
  nearSofa: boolean;
  /** La pièce où se tient le visiteur : elle décide de ce qui se dessine et de ce qui s'entend. */
  room: "salon" | "cuisine" | "mezzanine" | "couloir" | "chambre";
  setRoom: (room: ImmersionState["room"]) => void;
  /** La mesure (« Mesurer », `bench/bench.ts`) : son avancement, ses résultats. `null` : jamais lancée. */
  bench: BenchState | null;
  setBench: (patch: Partial<BenchState>) => void;
  /** Le feu du foyer : allumé ou non. */
  fire: boolean;
  toggleFire: () => void;
  /** Les lampes de chaque groupe de pièces : allumées ou non (les interrupteurs). */
  lamps: Record<"salon" | "sud" | "nuit", boolean>;
  toggleLamps: (group: "salon" | "sud" | "nuit") => void;
  /** La lumière précalculée est-elle en place ? Les lumières temps réel se réduisent alors à ce qui bouge. */
  baked: boolean;
  setBaked: (baked: boolean) => void;
  /** La scène est-elle chargée (textures, modèles) ? */
  sceneReady: boolean;
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
  setPhase: (phase: Phase) => void;
  setUnsupported: (why: Unsupported | null) => void;
  setMode: (mode: Mode) => void;
  setPauseView: (view: "menu" | "settings") => void;
  setSeated: (seated: boolean) => void;
  setNear: (near: { screen: string | null; sofa: boolean }) => void;
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
  nearSofa: false,
  room: "salon",
  baked: false,
  fire: true,
  toggleFire: () => set({ fire: !get().fire }),
  lamps: { salon: true, sud: true, nuit: true },
  toggleLamps: (group) => set({ lamps: { ...get().lamps, [group]: !get().lamps[group] } }),
  bench: null,
  setBench: (patch) => set({ bench: { ...(get().bench ?? EMPTY_BENCH), ...patch } }),
  setBaked: (baked) => get().baked !== baked && set({ baked }),
  setRoom: (room) => get().room !== room && set({ room }),
  sceneReady: false,
  lang: browserLang(),
  settings: loadSettings(),
  autoLevel: 0,
  stepAuto: (delta) => {
    const next = Math.max(0, Math.min(AUTO_LEVELS.length - 1, get().autoLevel + delta));
    if (next !== get().autoLevel) set({ autoLevel: next });
  },
  playback: IDLE_PLAYBACK,
  setPlayback: (patch) => set({ playback: { ...get().playback, ...patch } }),
  hudWake: 0,
  wakeHud: () => set({ hudWake: get().hudWake + 1 }),
  setPhase: (phase) => set({ phase }),
  setUnsupported: (unsupported) => set({ unsupported, phase: unsupported ? "unsupported" : "loading" }),
  setMode: (mode) => set(mode === "paused" ? { mode } : { mode, pauseView: "menu" }),
  setPauseView: (pauseView) => set({ pauseView }),
  setSeated: (seated) => set({ seated }),
  setNear: ({ screen, sofa }) => {
    const s = get();
    if (s.nearScreen !== screen || s.nearSofa !== sofa) set({ nearScreen: screen, nearSofa: sofa });
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
  return useStore((s) => profileOf(s.bench?.running && s.bench.preset ? s.bench.preset : s.settings.quality, s.autoLevel));
}
