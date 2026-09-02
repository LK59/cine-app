"use client";

import { ChevronDown } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

// Nothing on the detail sheet said a second screen existed below it — the two snap positions are
// only discoverable by trying. This is the affordance: a small drifting chevron at the foot of
// the first section, which is also a shortcut (pressing it scrolls to the next section, the same
// place Down from the last menu row goes).
//
// It finds its target through the DOM rather than a prop: both sheets already mark their sections
// with data-snap-section for the keyboard navigation, and the next one is always the target.
export function CinemaScrollHint() {
  const t = useT();
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <button
        type="button"
        aria-label={t("cinema.similar")}
        onClick={(e) => {
          const section = e.currentTarget.closest<HTMLElement>("[data-snap-section]");
          section?.nextElementSibling?.scrollIntoView({ block: "start", behavior: "smooth" });
        }}
        className="pointer-events-auto animate-scroll-hint rounded-full bg-black/40 p-2 text-white/90 backdrop-blur-xs transition-colors hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <ChevronDown size={20} />
      </button>
    </div>
  );
}
