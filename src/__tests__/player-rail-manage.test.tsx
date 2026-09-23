// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Le rail montrait « Gestion » à tout le monde, vers des pages où chaque bouton répond 403 ; le
// panneau Compte, lui, ne la propose qu'à l'administrateur (23/09/2026).

let me: { role: string } | undefined = { role: "user" };
vi.mock("swr", () => ({ default: () => ({ data: me }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  useCinemaRoute: () => ({
    tab: "movies", film: null, serie: null, episodes: false, search: false, list: false, account: false,
    discover: null, discoverType: "movie", person: null, browse: null,
  }),
}));

import { PlayerRail } from "@/components/player/PlayerRail";

afterEach(cleanup);

describe("PlayerRail — la gestion", () => {
  it("n'est pas proposée à un compte ordinaire", () => {
    me = { role: "user" };
    render(<PlayerRail />);
    expect(screen.queryByText("player.nav.manage")).toBeNull();
  });

  it("l'est à l'administrateur", () => {
    me = { role: "admin" };
    render(<PlayerRail />);
    expect(screen.getByText("player.nav.manage")).toBeTruthy();
  });
});
