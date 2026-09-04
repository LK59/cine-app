"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { ACCENT_PRESETS, DEFAULT_ACCENT, type AccentKey } from "@/lib/theme";

interface ThemeContextValue {
  accent: AccentKey;
  setAccent: (key: AccentKey) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  accent: DEFAULT_ACCENT,
  setAccent: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function applyAccent(key: AccentKey) {
  document.documentElement.dataset.accent = key;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [accent, setAccentState] = useState<AccentKey>(DEFAULT_ACCENT);

  // localStorage is unavailable during SSR — the persisted theme can only be read post-mount,
  // client-side. State starts at the fixed DEFAULT_ACCENT, matching SSR output, so this
  // doesn't cause a hydration mismatch.
  useEffect(() => {
    try {
      const saved = (localStorage.getItem("cine-accent") as AccentKey) || DEFAULT_ACCENT;
      const valid = ACCENT_PRESETS.some((p) => p.key === saved) ? saved : DEFAULT_ACCENT;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAccentState(valid);
      applyAccent(valid);
      // Le mode ultra-sombre n'existe plus : on efface son réglage plutôt que de laisser dormir
      // une préférence que plus rien ne lit.
      localStorage.removeItem("cine-amoled");
    } catch {}
  }, []);

  function setAccent(key: AccentKey) {
    setAccentState(key);
    try { localStorage.setItem("cine-accent", key); } catch {}
    applyAccent(key);
  }

  return (
    <ThemeContext.Provider value={{ accent, setAccent }}>
      {children}
    </ThemeContext.Provider>
  );
}
