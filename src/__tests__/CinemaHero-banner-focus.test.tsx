// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Les commandes de la bannière du bureau au clavier (08/10/2026). La clé de la colonne entière les
 * remontait à chaque changement de titre : « Lire » perdait le focus, → ne marchait qu'une fois, et
 * aux seules flèches « Plus d'infos » n'était jamais atteignable.
 */
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: () => new Promise(() => {}),
}));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/cinema/CinemaLogo", () => ({ CinemaLogo: () => null }));

import { CinemaHero, HeroBannerControls } from "@/components/cinema/CinemaHero";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

afterEach(cleanup);

const film = (id: number) =>
  ({ radarrId: id, tmdbId: id + 1000, title: `Film ${id}`, year: 2000, logoUrl: null, overview: "", genres: [], imdbRating: null, quality: null }) as unknown as CinemaMovie;

function Banner({ id, onPick = () => {} }: { id: number; onPick?: (i: number) => void }) {
  return (
    <SWRConfig value={{ provider: () => new Map() }}>
      <CinemaHero
        item={film(id)}
        banner={<HeroBannerControls onPlay={() => {}} onInfo={() => {}} count={3} index={0} running runKey="0" onPick={onPick} />}
      />
    </SWRConfig>
  );
}

describe("les commandes de la bannière", () => {
  it("« Lire » garde le focus quand le titre change", () => {
    const { rerender } = render(<Banner id={1} />);
    const play = screen.getByRole("button", { name: /common.play/ });
    play.focus();
    rerender(<Banner id={2} />);
    expect(screen.getByRole("button", { name: /common.play/ })).toBe(play);
    expect(document.activeElement).toBe(play);
  });

  it("→ va de « Lire » à « Plus d'infos », puis fait tourner ; ← revient", () => {
    const onPick = vi.fn();
    render(<Banner id={1} onPick={onPick} />);
    const play = screen.getByRole("button", { name: /common.play/ });
    const info = screen.getByRole("button", { name: /cinema.moreInfo/ });
    play.focus();
    fireEvent.keyDown(play, { key: "ArrowRight" });
    expect(document.activeElement).toBe(info);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(info, { key: "ArrowRight" });
    expect(onPick).toHaveBeenCalledWith(1);
    fireEvent.keyDown(info, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(play);
    fireEvent.keyDown(play, { key: "ArrowLeft" });
    expect(onPick).toHaveBeenLastCalledWith(2);
  });
});
