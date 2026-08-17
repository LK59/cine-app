"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

function isInputFocused(): boolean {
  const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
  return ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
}

// How many [data-nav-idx] cards currently share `index`'s row on screen — the poster grid wraps
// at a column count that changes with viewport width (and collapses to 1 in list view), so
// there's no fixed "items per row" to hardcode; reading actual bounding rects is the only way
// ArrowUp/Down can jump a real visual row instead of an arbitrary guessed offset. Cheap enough
// to run fresh on every press (only DOM reads, no layout writes) rather than caching a value
// that would go stale on resize/view-mode toggle.
function columnsInRowOf(index: number, count: number): number {
  const el = document.querySelector(`[data-nav-idx="${index}"]`);
  if (!el) return 1;
  const top = el.getBoundingClientRect().top;
  let n = 0;
  for (let i = 0; i < count; i++) {
    const e = document.querySelector(`[data-nav-idx="${i}"]`);
    if (e && Math.abs(e.getBoundingClientRect().top - top) < 2) n++;
  }
  return Math.max(1, n);
}

export function useListKeyNav(count: number, getHref: (i: number) => string) {
  const [cursor, setCursor] = useState(-1);
  const cursorRef = useRef(-1);
  const router = useRouter();
  const getHrefRef = useRef(getHref);
  // Tracks the count value the cursor was last reset against, so the reset below only
  // fires once per actual change (applied during render, not in an effect, per React's
  // guidance for adjusting state from a prop change).
  const [resetForCount, setResetForCount] = useState(count);

  useEffect(() => {
    getHrefRef.current = getHref;
  }, [getHref]);

  if (count !== resetForCount) {
    setResetForCount(count);
    setCursor(-1);
  }

  // Refs can't be written during render — keep cursorRef mirroring cursor state via an effect
  // instead (the keydown handler below also updates it eagerly on its own, synchronously with
  // setCursor, so Enter never reads a stale value between a j/k press and this effect running).
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  useEffect(() => {
    function moveTo(next: number) {
      cursorRef.current = next;
      document.querySelector(`[data-nav-idx="${next}"]`)?.scrollIntoView({ block: "nearest" });
      setCursor(next);
    }

    function handler(e: KeyboardEvent) {
      if (isInputFocused()) return;
      const arrowKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
      if (!["j", "k", "Enter", ...arrowKeys].includes(e.key)) return;

      // First press of any arrow/j/k just selects the first card — makes an arrow key
      // meaningful the very moment the user starts browsing, instead of ArrowDown/Right
      // silently jumping a whole row ahead of nothing.
      if (cursorRef.current === -1 && (e.key === "j" || arrowKeys.includes(e.key))) {
        e.preventDefault();
        moveTo(0);
        return;
      }

      if (e.key === "j" || e.key === "ArrowRight") {
        e.preventDefault();
        moveTo(Math.min(count - 1, cursorRef.current + 1));
      } else if (e.key === "k" || e.key === "ArrowLeft") {
        e.preventDefault();
        moveTo(Math.max(0, cursorRef.current - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const cols = columnsInRowOf(cursorRef.current, count);
        moveTo(Math.min(count - 1, cursorRef.current + cols));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const cols = columnsInRowOf(cursorRef.current, count);
        moveTo(Math.max(0, cursorRef.current - cols));
      } else if (e.key === "Enter") {
        const c = cursorRef.current;
        if (c >= 0 && c < count) router.push(getHrefRef.current(c));
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [count, router]);

  return cursor;
}
