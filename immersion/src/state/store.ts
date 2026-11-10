import { create } from "zustand";
import { browserLang, translate, type Key, type Lang } from "../lib/i18n";
import { loadSettings, saveSettings, type Settings } from "../lib/settings";
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
