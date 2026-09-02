"use client";

import { useSyncExternalStore } from "react";

// Tailwind's own md breakpoint — the same line the rest of the app's responsive classes switch
// on, so "mobile" here means exactly what it means everywhere else in the UI.
//
// Plus a second clause for the case width alone gets wrong: a phone turned sideways is ~844px
// wide and would fall through to the desktop layout, which assumes a tall window (a hero pane
// stacked over the rows). Short AND coarse-pointer keeps that to touch devices — a 13" laptop is
// ~800px tall with a mouse, so it stays on the desktop UI exactly as before.
const MOBILE_QUERY = "(max-width: 767px), (max-height: 500px) and (pointer: coarse)";

// A viewport with almost no vertical room — a phone in landscape, essentially. Layouts that lead
// with a tall piece of key art use it to lay that art out sideways instead.
const SHORT_QUERY = "(max-height: 500px)";

const subscribers = new Map<string, (onChange: () => void) => () => void>();

// useSyncExternalStore wants a stable subscribe function per query — one built fresh each render
// would tear down and re-add the listener every time.
function subscriberFor(query: string): (onChange: () => void) => () => void {
  let fn = subscribers.get(query);
  if (!fn) {
    fn = (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    };
    subscribers.set(query, fn);
  }
  return fn;
}

// useSyncExternalStore rather than the usual useState+useEffect media-query pattern: that one
// needs a setState in the effect body to seed the initial value (which this project's
// react-hooks/set-state-in-effect rule rejects) and renders one frame with a guessed value.
// The server snapshot returns false — desktop is the safe assumption for markup that only exists
// to be hydrated, and the client corrects it on the very first client render.
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscriberFor(query),
    () => window.matchMedia(query).matches,
    () => false
  );
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

export function useIsShortViewport(): boolean {
  return useMediaQuery(SHORT_QUERY);
}
