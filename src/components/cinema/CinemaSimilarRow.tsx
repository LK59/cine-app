"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { similarInLibrary } from "@/lib/cinemaSimilar";
import { uniqueById } from "@/lib/cinemaRails";
import { PosterImage } from "@/components/PosterImage";
import { CinemaNewBadge } from "@/components/cinema/CinemaNewBadge";
import { useT } from "@/components/TranslationProvider";
import type { CinemaMovie, CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
import type { CinemaSeries, CinemaSeriesPayload } from "@/app/api/cinema/series/route";

// "Plus comme ça", at the bottom of a detail sheet — but only titles from your own library, so
// everything it proposes can be started on the spot (see lib/cinemaSimilar for why not TMDB's
// recommendations).
//
// Fetches its own payload rather than taking one as a prop: the SWR key is already in cache
// whenever the browse screen behind it has loaded, so this costs nothing, and it keeps the three
// detail sheets (desktop movie, desktop series, mobile) from each having to thread the catalog
// down. Renders nothing when the subject has no genres in common with anything.

// Radarr and Sonarr ids never collide within one payload, and a row only ever holds one of the
// two kinds.
function idOf(item: CinemaMovie | CinemaSeries): number {
  return "radarrId" in item ? item.radarrId : item.sonarrId;
}

export function CinemaSimilarRow({
  subject,
  mediaType,
  onSelect,
}: {
  subject: CinemaMovie | CinemaSeries;
  mediaType: "movies" | "series";
  onSelect: (item: CinemaMovie | CinemaSeries) => void;
}) {
  const t = useT();
  const { data: movies } = useSWR<CinemaMoviesPayload>(mediaType === "movies" ? "/api/cinema/movies" : null, fetcher);
  const { data: series } = useSWR<CinemaSeriesPayload>(mediaType === "series" ? "/api/cinema/series" : null, fetcher);

  const items = useMemo(() => {
    const payload = mediaType === "movies" ? movies : series;
    if (!payload) return [];
    const all: (CinemaMovie | CinemaSeries)[] = uniqueById(
      [...payload.spotlight, ...Object.values(payload.rows).flat()],
      idOf
    );
    const subjectId = idOf(subject);
    return similarInLibrary(subject, all, (candidate) => idOf(candidate) === subjectId);
  }, [movies, series, mediaType, subject]);

  if (items.length === 0) return null;

  return (
    <section className="w-full">
      <h2 className="mb-2 text-sm font-medium text-white/70">{t("cinema.similar")}</h2>
      {/* py-4 + overflow-y-hidden: a focused poster scales up and needs room inside this box, or
          it gets clipped by the scroller's own edge (any element with overflow-x:auto computes
          overflow-y to auto too, so the box really does clip). Hidden rather than auto on the
          vertical axis also hands the mouse wheel back to the page instead of the row eating it. */}
      <div className="scrollbar-thin flex gap-3 overflow-x-auto overflow-y-hidden py-4">
        {items.map((item) => (
          <button
            key={idOf(item)}
            type="button"
            data-detail-similar
            onClick={() => onSelect(item)}
            className="relative w-24 shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40 outline-none transition-transform hover:scale-105 focus-visible:scale-105 sm:w-28 md:w-32"
          >
            <PosterImage src={item.posterUrl} alt={item.title} subtle unoptimized sizes="120px" />
            <CinemaNewBadge addedAt={item.addedAt} />
          </button>
        ))}
      </div>
    </section>
  );
}

// Arrow-key navigation for the row, called from each detail sheet's own keydown handler before
// its vertical menu logic. Returns true when it handled the key, so the caller stops there.
//
// The sheets navigate their menu with Up/Down over [data-detail-menu]; this row is horizontal and
// sits below that menu, so it joins the same path rather than competing with it: Down off the
// last menu item drops into the row, Up leaves it, Left/Right walk it. Everything is scrolled
// into view as focus moves — the row lives at the bottom of a scrolling column.
export function similarRowKeyNav(e: KeyboardEvent, container: HTMLElement | null): boolean {
  if (!container) return false;
  const cards = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-detail-similar]"));
  if (cards.length === 0) return false;

  const menu = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-detail-menu]"));
  const active = document.activeElement as HTMLElement | null;
  const index = cards.indexOf(active as HTMLButtonElement);

  // Within the row, "nearest" is right: only the horizontal position needs adjusting.
  function focusInRow(el: HTMLElement) {
    el.focus();
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  // Crossing between the sheet's two sections is different: the scroller is snap-mandatory, so
  // scrolling by the *element* moves the minimum needed to reveal it, the scroller then snaps to
  // whichever position is nearest — which is the one it just left — and the view springs back
  // while focus has already moved. Scrolling the whole section to the top lands exactly on a snap
  // position, so it stays. focus(preventScroll) keeps the browser from doing its own element-
  // sized scroll first and fighting this one.
  function focusInOtherSection(el: HTMLElement) {
    el.focus({ preventScroll: true });
    const section = el.closest<HTMLElement>("[data-snap-section]");
    (section ?? el).scrollIntoView({ block: "start", behavior: "smooth" });
  }

  if (index === -1) {
    // Only the last menu row hands off downwards — from anywhere else Down still means "next
    // menu item", which the caller handles.
    if (e.key === "ArrowDown" && menu.length > 0 && active === menu[menu.length - 1]) {
      e.preventDefault();
      focusInOtherSection(cards[0]);
      return true;
    }
    return false;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    focusInOtherSection(menu[menu.length - 1] ?? cards[0]);
    return true;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    focusInRow(cards[Math.min(index + 1, cards.length - 1)]);
    return true;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    focusInRow(cards[Math.max(index - 1, 0)]);
    return true;
  }
  // Down inside the row has nowhere to go — swallow it so it can't fall through to the menu
  // handler and jump focus back up.
  if (e.key === "ArrowDown") {
    e.preventDefault();
    return true;
  }
  return false;
}
