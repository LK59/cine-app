"use client";

import type { useRouter } from "next/navigation";

type Router = ReturnType<typeof useRouter>;

// Leaving Cinema Mode used to be a plain `window.location.href = "/"`, i.e. a full page load,
// which tears down the whole React tree — including PlayerHost, so anything playing (full screen
// or minimized) was killed on the way out.
//
// It doesn't have to be. /cinema lives under the (dashboard) route group, and PlayerHost is
// mounted by that group's layout, so a client-side navigation from /cinema to / keeps the same
// layout — and the same <video> element — alive. Playback simply continues, with the mini player
// carrying over onto the dashboard.
//
// The hard navigation existed for a reason though (see Sidebar's comment on the entry link):
// Next's client-side transition fetches the target route's RSC payload, and that fetch was
// observed failing at transport level in production. So this tries the client-side route first
// and falls back to a real navigation if the URL hasn't actually changed shortly after. Worst
// case is exactly the old behavior — you always end up on the dashboard.
const FALLBACK_MS = 1200;

export function leaveCinema(router: Router): void {
  if (typeof window === "undefined") return;

  // No cleanup needed: on a successful transition the pathname is no longer /cinema and this
  // fires as a no-op.
  setTimeout(() => {
    if (window.location.pathname.startsWith("/cinema")) window.location.href = "/";
  }, FALLBACK_MS);

  try {
    router.push("/");
  } catch {
    window.location.href = "/";
  }
}
