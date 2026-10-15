// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Des noms pour les lecteurs d'écran (15/10/2026, passe de nuit, BUREAU-18) : les puces de la
 * bannière s'annonçaient « bouton 1 », « bouton 2 »… et les photos d'une personne étaient vingt-trois
 * boutons sans nom (axe `button-name`, critique).
 */
const t = (k: string, v?: Record<string, unknown>) => (v ? `${k} ${JSON.stringify(v)}` : k);
vi.mock("@/components/TranslationProvider", () => ({ useT: () => t, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false }));
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (url: string) =>
    url.includes("/photos")
      ? { photos: [{ filePath: "/a.jpg", aspectRatio: 0.66 }, { filePath: "/b.jpg", aspectRatio: 0.66 }] }
      : url.includes("/enriched")
        ? {}
        : { name: "Tom Hanks", biography: "", credits: [] },
}));

import { HeroBannerControls } from "@/components/cinema/CinemaHero";
import { PlayerPersonSheet } from "@/components/player/PlayerPersonSheet";

afterEach(cleanup);

describe("noms accessibles", () => {
  it("les puces de la bannière disent leur position", () => {
    render(<HeroBannerControls onPlay={() => {}} onInfo={() => {}} count={3} index={0} running runKey="0" onPick={() => {}} />);
    expect(screen.getByRole("button", { name: 'cinema.heroSlide {"n":2,"total":3}' })).toBeTruthy();
  });

  it("chaque photo d'une personne a un nom", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PlayerPersonSheet tmdbId={31} />
      </SWRConfig>
    );
    // Les photos attendent la fin de l'entrée (minuteur de secours de la fiche).
    const photos = await screen.findAllByRole("button", { name: /player\.person\.photoN/ }, { timeout: 3000 });
    expect(photos.map((p) => p.getAttribute("aria-label"))).toEqual([
      'player.person.photoN {"n":1,"total":2,"name":"Tom Hanks"}',
      'player.person.photoN {"n":2,"total":2,"name":"Tom Hanks"}',
    ]);
  });
});
