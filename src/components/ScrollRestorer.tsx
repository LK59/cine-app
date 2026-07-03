"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

function restoreScrollWhenReady(main: HTMLElement, pos: number) {
  function trySet() {
    main.scrollTop = pos;
    return Math.abs(main.scrollTop - pos) <= 2;
  }

  requestAnimationFrame(() => {
    if (trySet()) return;

    // Content not tall enough yet (SWR still loading). Watch for DOM growth.
    const obs = new MutationObserver(() => {
      if (trySet()) obs.disconnect();
    });
    obs.observe(main, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 5000);
  });
}

export function ScrollRestorer() {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;

    const onCapture = (e: MouseEvent) => {
      const a = (e.target as Element)?.closest("a[href]");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("http") || href.startsWith("//") || href.startsWith("mailto:")) return;
      if (main.scrollTop <= 0) return;
      sessionStorage.setItem(
        `scroll:${window.location.pathname}`,
        String(Math.round(main.scrollTop))
      );
    };

    const onPopstate = () => {
      if (main.scrollTop <= 0) return;
      sessionStorage.setItem(
        `scroll:${pathnameRef.current}`,
        String(Math.round(main.scrollTop))
      );
    };

    document.addEventListener("click", onCapture, true);
    window.addEventListener("popstate", onPopstate);
    return () => {
      document.removeEventListener("click", onCapture, true);
      window.removeEventListener("popstate", onPopstate);
    };
  }, []);

  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;

    const saved = sessionStorage.getItem(`scroll:${pathname}`);
    if (saved !== null) {
      sessionStorage.removeItem(`scroll:${pathname}`);
      restoreScrollWhenReady(main, Number(saved));
    } else {
      requestAnimationFrame(() => { main.scrollTop = 0; });
    }
  }, [pathname]);

  return null;
}
