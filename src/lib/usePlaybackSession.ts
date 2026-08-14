import { useCallback, useEffect, useRef, type RefObject } from "react";

interface PlaybackSessionInfo {
  itemId: string;
  playSessionId: string;
  mediaSourceId: string;
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
export function usePlaybackSession(
  videoRef: RefObject<HTMLVideoElement | null>,
  session: PlaybackSessionInfo | null
): () => void {
  const sessionRef = useRef(session);
  const stoppedRef = useRef(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!session) return;
    stoppedRef.current = false;

    const reportStop = () => {
      if (stoppedRef.current) return;
      stoppedRef.current = true;
      const video = videoRef.current;
      if (!video) return;
      report("stop", session, Math.floor(video.currentTime * TICKS_PER_SECOND));
    };

    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      report("progress", session, Math.floor(video.currentTime * TICKS_PER_SECOND));
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
    const video = videoRef.current;
    if (!s || !video) return;
    report("stop", s, Math.floor(video.currentTime * TICKS_PER_SECOND));
  }, [videoRef]);
}
