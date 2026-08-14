"use client";

import { createContext, useCallback, useContext, useState } from "react";

export interface PlaybackSession {
  itemId: string;
  title: string;
  /** Resume position in seconds, if reopening a partially-watched item. */
  resumeAt?: number;
  /** Resolves the episode after `currentItemId`, if any — recomputed on every advance so the
   *  "next up" prompt keeps working after auto-advancing more than once in a row. */
  getNextEpisode?: (currentItemId: string) => { itemId: string; title: string } | null;
}

export type PlaybackMode = "closed" | "full" | "mini";

interface PlaybackContextValue {
  session: PlaybackSession | null;
  mode: PlaybackMode;
  play: (session: PlaybackSession) => void;
  close: () => void;
  minimize: () => void;
  expand: () => void;
  advance: (next: { itemId: string; title: string }) => void;
}

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

export function usePlayback(): PlaybackContextValue {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error("usePlayback must be used within a PlaybackProvider");
  return ctx;
}

// Owns the single, app-wide "what's currently playing" state — deliberately separate from the
// component that actually renders the <video> (PlayerHost, mounted once in the dashboard
// layout) so play() can be called from anywhere (movie sheets, episode rows, dashboard cards)
// without each caller owning its own player instance. That's what lets playback survive
// navigating to a different page while minimized.
export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [mode, setMode] = useState<PlaybackMode>("closed");

  const play = useCallback((s: PlaybackSession) => {
    setSession(s);
    setMode("full");
  }, []);

  const close = useCallback(() => {
    setMode("closed");
    setSession(null);
  }, []);

  const minimize = useCallback(() => setMode("mini"), []);
  const expand = useCallback(() => setMode("full"), []);

  // Resets resumeAt — an advance always starts the new episode from 0, matching the previous
  // per-invocation player's behavior.
  const advance = useCallback((next: { itemId: string; title: string }) => {
    setSession((prev) => (prev ? { ...prev, itemId: next.itemId, title: next.title, resumeAt: undefined } : prev));
  }, []);

  return (
    <PlaybackContext.Provider value={{ session, mode, play, close, minimize, expand, advance }}>
      {children}
    </PlaybackContext.Provider>
  );
}
