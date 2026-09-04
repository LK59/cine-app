"use client";

import type { useRouter } from "next/navigation";

type Router = ReturnType<typeof useRouter>;

// Leaving Cinema Mode used to be a plain `window.location.href = "/"`, i.e. a full page load,
// which tears down the whole React tree — including PlayerHost, so anything playing (full screen
// or minimized) was killed on the way out.
//
// It doesn't have to be. PlayerHost is mounted by the *root* layout (it moved there when the
// player got its own route group), so a client-side navigation between /player and /gestion keeps
// the same <video> element alive. Playback simply continues, with the mini player carrying over.
//
// The hard navigation existed for a reason: Next's client-side transition fetches the target
// route's RSC payload, and that fetch was, for months, failing in production. It no longer does
// — verified live in both directions — most likely because the service worker used to cache
// those responses and convert a network failure into a synthetic 504 the router could only read
// as a server error, which made a passing hiccup look permanent.
//
// The fallback stays anyway, and not out of superstition: the app is redeployed by hand, and a
// click landing inside the few seconds the container takes to restart gets a real 502. Ten lines
// turn that into a page reload instead of a button that does nothing.
const FALLBACK_MS = 1200;

export function leaveCinema(router: Router): void {
  navigateWithFallback(router, "/gestion", (path) => path.startsWith("/player"));
}

// Entering Cinema Mode, with the same belt-and-braces as leaving it.
//
// The entry links used a plain <a> — a full page load — because this transition was failing in
// production. It works now (verified live: instant, no reload, and a minimized player survives
// the crossing), so they go through the router again. Same fallback as above, for the same
// deploy-window reason.
export function enterCinema(router: Router): void {
  navigateWithFallback(router, "/player", (path) => !path.startsWith("/player"));
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
