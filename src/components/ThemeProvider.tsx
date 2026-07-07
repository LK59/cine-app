"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { ACCENT_PRESETS, DEFAULT_ACCENT, type AccentKey } from "@/lib/theme";

interface ThemeContextValue {
  accent: AccentKey;
  amoled: boolean;
  autoTrailer: boolean;
  setAccent: (key: AccentKey) => void;
  setAmoled: (enabled: boolean) => void;
  setAutoTrailer: (enabled: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  accent: DEFAULT_ACCENT,
  amoled: false,
  autoTrailer: true,
  setAccent: () => {},
  setAmoled: () => {},
  setAutoTrailer: () => {},
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
  const [autoTrailer, setAutoTrailerState] = useState(true);

  useEffect(() => {
    try {
      const saved = (localStorage.getItem("cine-accent") as AccentKey) || DEFAULT_ACCENT;
      const valid = ACCENT_PRESETS.some((p) => p.key === saved) ? saved : DEFAULT_ACCENT;
      const savedAmoled = localStorage.getItem("cine-amoled") === "1";
      const savedTrailer = localStorage.getItem("cine-autotrailer") !== "0";
      setAccentState(valid);
      setAmoledState(savedAmoled);
      setAutoTrailerState(savedTrailer);
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

  function setAutoTrailer(enabled: boolean) {
    setAutoTrailerState(enabled);
    try { localStorage.setItem("cine-autotrailer", enabled ? "1" : "0"); } catch {}
  }

  return (
    <ThemeContext.Provider value={{ accent, amoled, autoTrailer, setAccent, setAmoled, setAutoTrailer }}>
      {children}
    </ThemeContext.Provider>
  );
}
