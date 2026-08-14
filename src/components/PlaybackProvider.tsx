"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export interface PlaybackSession {
  itemId: string;
  title: string;
  /** Resume position in seconds, if reopening a partially-watched item. */
  resumeAt?: number;
  /** Only honored for the very first startPlayback call after opening — an initial audio track
   *  other than the default, used to resume into the right track after a WebKit reload-based
   *  track switch (see PLAYER_RELOAD_INTENT_KEY below). */
  initialAudioStreamIndex?: number;
  /** True when this session resumes a reload-based track switch. PlayerHost then delays the
   *  first load by a grace period: iOS's media daemon releases the previous page's HLS session
   *  asynchronously and roughly proportionally to how much it had buffered — verified live with
   *  byte-identical server responses producing success after a ~3s-old session but failure
   *  after an 8-minute one. Loading immediately on the fresh page races that release and gets
   *  refused (SRC_NOT_SUPPORTED); a short deliberate wait lets it finish first. */
  fromReload?: boolean;
  /** How many reload attempts this switch has already consumed — see PLAYER_RELOAD_ATTEMPTS_KEY. */
  reloadAttempt?: number;
  /** Resolves the episode after `currentItemId`, if any — recomputed on every advance so the
   *  "next up" prompt keeps working after auto-advancing more than once in a row. Lost across a
   *  reload-based track switch (the page context it closed over doesn't survive) — an accepted,
   *  minor tradeoff: the "next episode" prompt just won't reappear for that session until the
   *  user navigates away and back, no crash either way. */
  getNextEpisode?: (currentItemId: string) => { itemId: string; title: string } | null;
}

// WebKit-only workaround (see the long comment in PlayerHost's changeAudio) for a reproducible
// "can't load a second HLS session in the same page" limitation: switching audio track there
// does a full page reload instead of switching in place, stashing just enough here to resume
// into the right track/position once the fresh page comes back up.
export const PLAYER_RELOAD_INTENT_KEY = "cine:player-reload-intent";

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

  // Resumes into a WebKit reload-based track switch — see PLAYER_RELOAD_INTENT_KEY. Runs once on
  // mount, before anything has had a chance to open a *different* player session, so there's no
  // risk of clobbering unrelated playback that might otherwise start first.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY);
      if (raw) sessionStorage.removeItem(PLAYER_RELOAD_INTENT_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const intent = JSON.parse(raw) as { itemId: string; title: string; audioStreamIndex: number; resumeAt: number; attempt?: number };
      // eslint-disable-next-line react-hooks/set-state-in-effect
      play({
        itemId: intent.itemId,
        title: intent.title,
        resumeAt: intent.resumeAt,
        initialAudioStreamIndex: intent.audioStreamIndex,
        fromReload: true,
        reloadAttempt: intent.attempt ?? 0,
      });
    } catch {
      // Malformed — ignore, nothing to resume.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PlaybackContext.Provider value={{ session, mode, play, close, minimize, expand, advance }}>
      {children}
    </PlaybackContext.Provider>
  );
}
