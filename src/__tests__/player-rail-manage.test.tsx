// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// La gestion n'est plus dans le rail, pour personne (06/10/2026) : l'administrateur l'ouvre depuis
// l'onglet Compte, seul endroit où elle vit. Avant, le rail la montrait à l'administrateur (et, plus
// tôt encore, à tout le monde, vers des pages où chaque bouton répondait 403).

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
  it("n'est plus proposée dans le rail, même à l'administrateur", () => {
    render(<PlayerRail />);
    expect(screen.queryByText("player.nav.manage")).toBeNull();
    expect(document.querySelector('a[href="/gestion"], button[data-href="/gestion"]')).toBeNull();
  });
});
