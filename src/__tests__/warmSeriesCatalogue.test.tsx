// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "fs";

const preload = vi.fn(async () => ({}));
vi.mock("swr", () => ({ preload: (...a: unknown[]) => preload(...(a as [])) }));
let watching = false;
vi.mock("@/lib/playbackBusy", () => ({ isWatchingFullScreen: () => watching }));
vi.mock("@/lib/swr", () => ({ fetcher: async () => ({}), SERIES_CATALOGUE_KEY: "/api/cinema/series" }));

import { useWarmSeriesCatalogue } from "@/lib/useWarmSeriesCatalogue";

function Probe({ ready }: { ready: boolean }) {
  useWarmSeriesCatalogue(ready);
  return null;
}

describe("le réchauffage du catalogue des séries", () => {
  beforeEach(() => {
    preload.mockClear();
    watching = false;
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("ne demande rien tant que les films ne sont pas là", () => {
    render(<Probe ready={false} />);
    vi.runAllTimers();
    expect(preload).not.toHaveBeenCalled();
  });

  it("prépare le catalogue une fois les films arrivés", () => {
    const { rerender } = render(<Probe ready={false} />);
    rerender(<Probe ready />);
    // Rien dans l'instant : le réchauffage attend le temps mort, pour ne pas disputer le rendu
    // de l'accueil.
    expect(preload).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(preload).toHaveBeenCalledWith("/api/cinema/series", expect.any(Function));
  });

  it("s'efface devant un film qui occupe l'écran", () => {
    watching = true;
    render(<Probe ready />);
    vi.runAllTimers();
    expect(preload).not.toHaveBeenCalled();
  });

  it("n'insiste pas si l'écran disparaît avant le temps mort", () => {
    const { unmount } = render(<Probe ready />);
    unmount();
    vi.runAllTimers();
    expect(preload).not.toHaveBeenCalled();
  });
});

/**
 * Les deux écrans réchauffent, et par le même crochet — c'est une décision, pas deux.
 * Le catalogue différé a déjà coûté le même bug deux fois, une fois par interface.
 */
describe("les deux interfaces le font", () => {
  it.each([
    "src/components/cinema/CinemaClient.tsx",
    "src/components/cinema/mobile/CinemaMobileClient.tsx",
  ])("%s appelle useWarmSeriesCatalogue", (file) => {
    expect(readFileSync(file, "utf8")).toMatch(/useWarmSeriesCatalogue\(movies !== undefined\)/);
  });
});
