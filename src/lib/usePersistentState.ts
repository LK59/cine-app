"use client";

import { useEffect, useState } from "react";

// Persists a small piece of UI state (filter/tab/view) to localStorage so it
// survives navigation and reloads, without touching the URL or a database.
export function usePersistentState<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const stored = window.localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore (e.g. private browsing quota)
    }
  }, [key, value]);

  return [value, setValue];
}
