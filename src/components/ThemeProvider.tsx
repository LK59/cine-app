"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { ACCENT_PRESETS, DEFAULT_ACCENT, type AccentKey } from "@/lib/theme";

interface ThemeContextValue {
  accent: AccentKey;
  amoled: boolean;
  setAccent: (key: AccentKey) => void;
  setAmoled: (enabled: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  accent: DEFAULT_ACCENT,
  amoled: false,
  setAccent: () => {},
  setAmoled: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function applyAccent(key: AccentKey) {
  document.documentElement.dataset.accent = key;
}

function applyAmoled(enabled: boolean) {
  if (enabled) {
    document.documentElement.dataset.amoled = "";
  } else {
    delete document.documentElement.dataset.amoled;
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [accent, setAccentState] = useState<AccentKey>(DEFAULT_ACCENT);
  const [amoled, setAmoledState] = useState(false);

  // localStorage is unavailable during SSR — the persisted theme can only be read post-mount,
  // client-side. State starts at the fixed DEFAULT_ACCENT/false, matching SSR output, so this
  // doesn't cause a hydration mismatch.
  useEffect(() => {
    try {
      const saved = (localStorage.getItem("cine-accent") as AccentKey) || DEFAULT_ACCENT;
      const valid = ACCENT_PRESETS.some((p) => p.key === saved) ? saved : DEFAULT_ACCENT;
      const savedAmoled = localStorage.getItem("cine-amoled") === "1";
      /* eslint-disable react-hooks/set-state-in-effect */
      setAccentState(valid);
      setAmoledState(savedAmoled);
      /* eslint-enable react-hooks/set-state-in-effect */
      applyAccent(valid);
      applyAmoled(savedAmoled);
    } catch {}
  }, []);

  function setAccent(key: AccentKey) {
    setAccentState(key);
    try { localStorage.setItem("cine-accent", key); } catch {}
    applyAccent(key);
  }

  function setAmoled(enabled: boolean) {
    setAmoledState(enabled);
    try { localStorage.setItem("cine-amoled", enabled ? "1" : "0"); } catch {}
    applyAmoled(enabled);
  }

  return (
    <ThemeContext.Provider value={{ accent, amoled, setAccent, setAmoled }}>
      {children}
    </ThemeContext.Provider>
  );
}
