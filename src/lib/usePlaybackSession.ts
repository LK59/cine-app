import { useCallback, useEffect, useRef } from "react";

interface PlaybackSessionInfo {
  itemId: string;
  playSessionId: string;
  mediaSourceId: string;
  playMethod?: "DirectPlay" | "DirectStream" | "Transcode";
}

const TICKS_PER_SECOND = 10_000_000;
const HEARTBEAT_MS = 10_000;

function report(path: "progress" | "stop", info: PlaybackSessionInfo, positionTicks: number) {
  // keepalive lets the stop-on-unload report survive the page tearing down —
  // a regular fetch would get cancelled mid-flight on navigation/close.
  fetch(`/api/jellyfin/playback/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...info, positionTicks }),
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
  session: PlaybackSessionInfo | null
): () => void {
  const sessionRef = useRef(session);
  const stoppedRef = useRef(false);
  const positionRef = useRef(getPositionSeconds);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    positionRef.current = getPositionSeconds;
  }, [getPositionSeconds]);

  useEffect(() => {
    if (!session) return;
    stoppedRef.current = false;

    const reportStop = () => {
      if (stoppedRef.current) return;
      stoppedRef.current = true;
      report("stop", session, Math.floor(positionRef.current() * TICKS_PER_SECOND));
    };

    const interval = setInterval(() => {
      report("progress", session, Math.floor(positionRef.current() * TICKS_PER_SECOND));
    }, HEARTBEAT_MS);

    window.addEventListener("beforeunload", reportStop);

    return () => {
      clearInterval(interval);
      window.removeEventListener("beforeunload", reportStop);
      reportStop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.itemId, session?.playSessionId, session?.mediaSourceId]);

  return useCallback(() => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    const s = sessionRef.current;
    if (!s) return;
    report("stop", s, Math.floor(positionRef.current() * TICKS_PER_SECOND));
  }, []);
}
