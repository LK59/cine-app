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
  navigateWithFallback(router, "/", (path) => path.startsWith("/cinema"));
}

// Entering Cinema Mode, with the same belt-and-braces as leaving it.
//
// The entry links used a plain <a> — a full page load — because this client-side transition was
// seen failing in production. The proxy's access logs since then record 40 of these requests for
// /cinema, all 200, and no failure; the service worker also no longer intercepts them (it used to
// cache them, and to convert a network failure into a synthetic 504 the router could only read as
// a server error). So this is worth trying again — but tried, not assumed: if the URL hasn't
// actually changed shortly after, it falls back to the full page load, which is exactly the old
// behaviour. The button can never do nothing.
export function enterCinema(router: Router): void {
  navigateWithFallback(router, "/cinema", (path) => !path.startsWith("/cinema"));
}

function navigateWithFallback(router: Router, target: string, stillHere: (path: string) => boolean): void {
  if (typeof window === "undefined") return;

  // No cleanup needed: after a successful transition the pathname is the target one and this
  // fires as a no-op.
  setTimeout(() => {
    if (stillHere(window.location.pathname)) window.location.href = target;
  }, FALLBACK_MS);

  try {
    router.push(target);
  } catch {
    window.location.href = target;
  }
}
