"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

function isInputFocused(): boolean {
  const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
  return ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
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
    function handler(e: KeyboardEvent) {
      if (isInputFocused()) return;
      if (e.key === "j") {
        e.preventDefault();
        setCursor((c) => {
          const next = c < count - 1 ? c + 1 : c;
          cursorRef.current = next;
          document.querySelector(`[data-nav-idx="${next}"]`)?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "k") {
        e.preventDefault();
        setCursor((c) => {
          const prev = c > 0 ? c - 1 : 0;
          cursorRef.current = prev;
          document.querySelector(`[data-nav-idx="${prev}"]`)?.scrollIntoView({ block: "nearest" });
          return prev;
        });
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
