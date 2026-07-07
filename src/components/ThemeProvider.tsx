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

  useEffect(() => {
    try {
      const saved = (localStorage.getItem("cine-accent") as AccentKey) || DEFAULT_ACCENT;
      const valid = ACCENT_PRESETS.some((p) => p.key === saved) ? saved : DEFAULT_ACCENT;
      const savedAmoled = localStorage.getItem("cine-amoled") === "1";
      setAccentState(valid);
      setAmoledState(savedAmoled);
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
