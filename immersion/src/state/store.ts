import { create } from "zustand";
import { browserLang, translate, type Key, type Lang } from "../lib/i18n";
import { AUTO_LEVELS, loadSettings, profileOf, saveSettings, type QualityProfile, type Settings } from "../lib/settings";
import type { Unsupported } from "../lib/capability";

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

/** Ce que la télévision est en train de faire. */
export interface Playback {
  status: "idle" | "loading" | "playing" | "paused" | "ended" | "error";
  itemId: string | null;
  title: string | null;
  /** Secondes. Mis à jour deux fois par seconde au plus : c'est l'affichage qui lit ceci. */
  position: number;
  duration: number;
  muted: boolean;
  /** Le flux attend-il des données (mise en mémoire tampon) ? */
  waiting: boolean;
  error: string | null;
  /** DirectPlay, DirectStream ou Transcode — tel que la négociation l'a décidé. */
  method: string | null;
}

export const IDLE_PLAYBACK: Playback = { status: "idle", itemId: null, title: null, position: 0, duration: 0, muted: false, waiting: false, error: null, method: null };

export interface ImmersionState {
  phase: Phase;
  unsupported: Unsupported | null;
  mode: Mode;
  /** Le sous-écran du menu pause. */
  pauseView: "menu" | "settings";
  seated: boolean;
  /** Le visiteur est-il assez près de la télévision pour l'ouvrir (touche E) ? */
  nearTv: boolean;
  /** Peut-il s'asseoir d'ici (touche F) ? */
  nearSofa: boolean;
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
  setNear: (near: { tv: boolean; sofa: boolean }) => void;
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
  nearTv: false,
  nearSofa: false,
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
  setNear: ({ tv, sofa }) => {
    const s = get();
    if (s.nearTv !== tv || s.nearSofa !== sofa) set({ nearTv: tv, nearSofa: sofa });
  },
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

/** Le profil de qualité en vigueur. Une référence stable par niveau : rien ne se redessine pour rien. */
export function useProfile(): QualityProfile {
  return useStore((s) => profileOf(s.settings.quality, s.autoLevel));
}
