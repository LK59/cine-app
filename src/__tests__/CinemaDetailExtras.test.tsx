// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, renderHook } from "@testing-library/react";

// Trois détails légers repris de la gestion le 21/09/2026, écrits une fois pour toutes les fiches.

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
}));

import { CinemaTagline, CinemaDownloading, downloadPercent, useRuntimeLabel, ratingParts } from "@/components/cinema/CinemaDetailExtras";
import { queueProgress } from "@/lib/downloadProgress";

afterEach(cleanup);

describe("CinemaTagline", () => {
  it("affiche l'accroche, et rien quand il n'y en a pas", () => {
    const { container, rerender } = render(<CinemaTagline text="  In space no one can hear you scream. " />);
    expect(screen.getByText("In space no one can hear you scream.")).toBeTruthy();
    rerender(<CinemaTagline text={null} />);
    expect(container.innerHTML).toBe("");
    rerender(<CinemaTagline text="   " />);
    expect(container.innerHTML).toBe("");
  });
});

describe("useRuntimeLabel", () => {
  it("dit la durée d'un film, et celle d'un épisode pour une série", () => {
    const { result } = renderHook(() => useRuntimeLabel());
    expect(result.current(125, false)).toBe("2h05");
    expect(result.current(45, true)).toBe('cinema.perEpisode:{"time":"45min"}');
    expect(result.current(null, true)).toBeNull();
    expect(result.current(0, false)).toBeNull();
  });
});

describe("la progression d'un téléchargement", () => {
  it("additionne les morceaux d'une même arrivée", () => {
    expect(queueProgress([])).toBeNull();
    expect(queueProgress([{ size: 1000, sizeleft: 250 }])).toBe(0.75);
    expect(queueProgress([{ size: 1000, sizeleft: 1000 }, { size: 1000, sizeleft: 0 }])).toBe(0.5);
    // Taille pas encore connue : dans la file, donc « 0 % », pas « rien ».
    expect(queueProgress([{ size: 0, sizeleft: 0 }])).toBe(0);
  });

  it("ne dit « 100 % » jamais, et arrondit vers le bas", () => {
    expect(downloadPercent(0.639)).toBe(63);
    expect(downloadPercent(1)).toBe(99);
    expect(downloadPercent(-1)).toBe(0);
  });

  it("s'affiche en pourcentage", () => {
    render(<CinemaDownloading progress={0.63} />);
    expect(screen.getByText('cinema.downloading:{"pct":63}')).toBeTruthy();
  });
});

describe("la ligne des notes critiques", () => {
  const none = { imdb: null, tomatoes: null, tomatoesAudience: null, metacritic: null, metacriticUser: null, letterboxd: null, trakt: null, tmdb: null };
  const audience = (pct: number) => `public ${pct} %`;

  it("dit chaque source dans son unité, séparées par des points", () => {
    const parts = ratingParts({ ...none, imdb: 78, tomatoes: 92, tomatoesAudience: 88, metacritic: 81, letterboxd: 82 }, "fr", audience);
    expect(parts).toEqual(["IMDb 7,8", "Rotten Tomatoes 92 % (public 88 %)", "Metacritic 81", "Letterboxd 4,1"]);
  });

  it("tait une source absente, et tout quand aucune ne répond", () => {
    expect(ratingParts({ ...none, tomatoes: 60 }, "en", audience)).toEqual(["Rotten Tomatoes 60 %"]);
    expect(ratingParts(none, "fr", audience)).toEqual([]);
    expect(ratingParts(null, "fr", audience)).toEqual([]);
  });
});
