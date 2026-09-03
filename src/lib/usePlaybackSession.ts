import { useCallback, useEffect, useRef } from "react";
import { PLAYBACK_CLIENTS, type PlaybackClient } from "@/lib/playbackClients";

interface PlaybackSessionInfo {
  itemId: string;
  playSessionId: string;
  mediaSourceId: string;
  playMethod?: "DirectPlay" | "DirectStream" | "Transcode";
  /**
   * Which of the two players is running, as Jellyfin's dashboard and history will name it.
   *
   * Defaulted rather than required so a caller that does not care keeps the app's own name.
   */
  client?: PlaybackClient;
  /**
   * Whether this player has to announce the start itself.
   *
   * The stable one does not: negotiating its stream already tells the server. The experimental
   * one negotiates nothing, so without this it reports progress against a session the server was
   * never told about.
   */
  announce?: boolean;
}

const TICKS_PER_SECOND = 10_000_000;
const HEARTBEAT_MS = 10_000;

function report(
  path: "playing" | "progress" | "stop",
  info: PlaybackSessionInfo,
  positionTicks: number,
  isPaused = false
) {
  // keepalive lets the stop-on-unload report survive the page tearing down —
  // a regular fetch would get cancelled mid-flight on navigation/close.
  fetch(`/api/jellyfin/playback/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: PLAYBACK_CLIENTS.stable, ...info, positionTicks, isPaused }),
    keepalive: true,
  }).catch(() => {});
}

// Keeps Jellyfin's "now playing" / resume state in sync with an active
// PlayerHost session: a progress heartbeat every 10s, and a stop report
// (with the final position) on close, unmount, or tab close. Returns a
// stopNow() the caller can invoke at the exact moment the user closes the
// player — capturing currentTime right then, rather than whenever React
// gets around to unmounting (which can lag behind a close-transition delay).
//
// Takes a getPositionSeconds() callback rather than reading video.currentTime directly:
// switching audio/subtitle (or retrying after an error) calls video.load(), which resets
// currentTime to 0 immediately, before the new manifest has actually loaded — a heartbeat
// firing in that window (or while a track switch is stuck/failed, per the live PWA report)
// would silently overwrite Jellyfin's resume point with 0. The caller is expected to pass a
// value that only moves forward with real playback progress (e.g. a ref updated on
// 'timeupdate'), never one that resets on an in-flight reload.
export function usePlaybackSession(
  getPositionSeconds: () => number,
  session: PlaybackSessionInfo | null,
  getPaused?: () => boolean
): () => void {
  const sessionRef = useRef(session);
  const stoppedRef = useRef(false);
  const positionRef = useRef(getPositionSeconds);
  const pausedRef = useRef(getPaused);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    positionRef.current = getPositionSeconds;
    pausedRef.current = getPaused;
  }, [getPositionSeconds, getPaused]);

  useEffect(() => {
    if (!session) return;
    stoppedRef.current = false;

    const ticks = () => Math.floor(positionRef.current() * TICKS_PER_SECOND);
    const paused = () => pausedRef.current?.() ?? false;

    // Announced before anything else, so the first heartbeat lands on a session the server knows.
    if (session.announce) report("playing", session, ticks());

    const reportStop = () => {
      if (stoppedRef.current) return;
      stoppedRef.current = true;
      report("stop", session, ticks());
    };
    // Saves the position without ending anything. Putting an app in the background is not
    // closing a film, and on a phone it is the last moment anything is guaranteed to run.
    const saveNow = () => {
      if (stoppedRef.current || document.visibilityState !== "hidden") return;
      report("progress", session, ticks(), paused());
    };

    const interval = setInterval(() => report("progress", session, ticks(), paused()), HEARTBEAT_MS);

    window.addEventListener("beforeunload", reportStop);
    // iOS never fires beforeunload — closing a tab, swiping the app away or following a link out
    // all end at pagehide instead, so on a phone that was the whole of the final position being
    // lost. Both are listened to; whichever arrives first reports, and the other finds it done.
    window.addEventListener("pagehide", reportStop);
    document.addEventListener("visibilitychange", saveNow);

    return () => {
      clearInterval(interval);
      window.removeEventListener("beforeunload", reportStop);
      window.removeEventListener("pagehide", reportStop);
      document.removeEventListener("visibilitychange", saveNow);
      reportStop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.itemId, session?.playSessionId, session?.mediaSourceId, session?.announce, session?.client]);

  return useCallback(() => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    const s = sessionRef.current;
    if (!s) return;
    report("stop", s, Math.floor(positionRef.current() * TICKS_PER_SECOND));
  }, []);
}
