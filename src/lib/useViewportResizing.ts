"use client";

import { useEffect, useState } from "react";

// True while the viewport is actively changing size, false again shortly after it settles.
//
// Exists for one reason: an element whose width/height/position is animated with a CSS transition
// will happily animate a *rotation* too. The full-screen player is 100vw × 100dvh with a 300ms
// size transition, so turning the phone made it crawl from the old rectangle to the new one —
// the "weird animations" when changing orientation. A rotation isn't a state change worth
// animating, it's a new viewport; suppressing the transition while it happens makes the player
// simply already be the right size when the new orientation appears.
export function useViewportResizing(settleMs = 250): boolean {
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function onResize() {
      setResizing(true);
      clearTimeout(timer);
      timer = setTimeout(() => setResizing(false), settleMs);
    }
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [settleMs]);

  return resizing;
}
