// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

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

const focus = vi.hoisted(() => ({ onOpen: vi.fn() }));
vi.mock("@/lib/searchFocus", () => ({ requestSearchFocusOnOpen: focus.onOpen, requestSearchFocus: vi.fn() }));

import { PlayerRail } from "@/components/player/PlayerRail";

afterEach(cleanup);

describe("PlayerRail — la gestion", () => {
  it("n'est plus proposée dans le rail, même à l'administrateur", () => {
    render(<PlayerRail />);
    expect(screen.queryByText("player.nav.manage")).toBeNull();
    expect(document.querySelector('a[href="/gestion"], button[data-href="/gestion"]')).toBeNull();
  });
});

// 18/11/2026 : sur ordinateur, cliquer « Recherche » puis taper n'écrivait rien — le champ n'avait
// pas le focus (règle pensée pour le doigt, qui ne doit pas lever le clavier).
describe("PlayerRail — Recherche", () => {
  function clickSearch(pointerType: string) {
    render(<PlayerRail />);
    const button = screen.getByText("player.nav.search").closest("button")!;
    const ev = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(ev, "pointerType", { value: pointerType });
    fireEvent(button, ev);
  }

  it("met le curseur dans le champ au clic de souris", () => {
    focus.onOpen.mockClear();
    clickSearch("mouse");
    expect(focus.onOpen).toHaveBeenCalledTimes(1);
  });

  it("le met aussi à la touche Entrée (clic sans pointeur)", () => {
    focus.onOpen.mockClear();
    clickSearch("");
    expect(focus.onOpen).toHaveBeenCalledTimes(1);
  });

  it("ne lève pas le clavier au doigt", () => {
    focus.onOpen.mockClear();
    clickSearch("touch");
    expect(focus.onOpen).not.toHaveBeenCalled();
  });
});
