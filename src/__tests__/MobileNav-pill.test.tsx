// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "fs";

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/gestion", useRouter: () => ({ push, replace, prefetch: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/lib/signOut", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/leaveCinema", () => ({ enterCinema: vi.fn() }));
vi.mock("@/lib/prefetch", () => ({ prefetchRoute: vi.fn() }));
vi.mock("@/lib/pwaRefresh", () => ({ hardRefreshApp: vi.fn() }));
vi.mock("@/lib/useIsMobile", () => ({ useIsShortViewport: () => false }));

import { MobileNav } from "@/components/MobileNav";

/**
 * La pilule du bas de la gestion est celle du cinéma (13/10/2026, DECISIONS.md §45) : la même pièce
 * (`LiquidNavPill`), donc la même lentille et le même geste — un glisser sur la pilule parcourt les
 * onglets, le relâchement navigue. Elle n'en avait que l'allure : ni lentille, ni glisser.
 */
const ORDER = ["/gestion", "/radarr", "/sonarr", "/qbittorrent", "more"];
const STEP = 64;

beforeEach(() => {
  push.mockClear();
  replace.mockClear();
  Object.defineProperty(HTMLElement.prototype, "animate", {
    value: () => ({ id: "", cancel() {}, finished: Promise.resolve() }),
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, "getAnimations", { value: () => [], configurable: true });
});
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
});

/** jsdom ne met rien en page : chaque onglet reçoit sa place le long de la pilule. */
function layOut() {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>("[data-gestion-nav] [data-lens]"));
  expect(tabs.map((el) => el.dataset.lens)).toEqual(ORDER);
  tabs.forEach((el, i) => {
    Object.defineProperty(el, "offsetLeft", { value: i * STEP, configurable: true });
    Object.defineProperty(el, "offsetTop", { value: 0, configurable: true });
    Object.defineProperty(el, "offsetWidth", { value: 60, configurable: true });
  });
  return (key: string) => tabs[ORDER.indexOf(key)];
}

/** Un doigt posé sur un onglet, glissé le long de la pilule, relâché ailleurs. */
function drag(from: HTMLElement, toX: number) {
  const x = Number(from.offsetLeft) + 30;
  fireEvent.pointerDown(from, { pointerId: 1, button: 0, pointerType: "touch", clientX: x, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, pointerType: "touch", clientX: (x + toX) / 2, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, pointerType: "touch", clientX: toX, clientY: 10 });
  fireEvent.pointerUp(window, { pointerId: 1, pointerType: "touch", clientX: toX, clientY: 10 });
}

describe("MobileNav — la pilule du cinéma", () => {
  it("est la pièce partagée avec la barre du cinéma, et non une copie", () => {
    for (const file of ["src/components/MobileNav.tsx", "src/components/player/PlayerBottomBar.tsx"]) {
      const src = readFileSync(file, "utf8");
      expect(src).toContain('from "@/components/LiquidNavPill"');
      expect(src).toContain("<LiquidNavPill");
      // La lentille ne se branche qu'à un endroit.
      expect(src).not.toMatch(/useLiquidLens\(/);
    }
    render(<MobileNav />);
    const bar = document.querySelector("[data-gestion-nav] [data-liquid-nav]");
    expect(bar?.className).toContain("nav-glass");
    expect(bar?.querySelector(".nav-lens")).not.toBeNull();
  });

  it("un appui long ne sélectionne aucun libellé : la sélection d'iOS figeait la lentille", () => {
    render(<MobileNav />);
    const bar = document.querySelector<HTMLElement>("[data-gestion-nav] [data-liquid-nav]");
    // Posé par le geste lui-même, donc sur chaque barre à lentille, et la feuille de style le lit.
    expect(bar?.hasAttribute("data-liquid-lens")).toBe(true);
    const css = readFileSync("src/app/globals.css", "utf8");
    const rule = css.match(/\[data-liquid-lens\],\s*\[data-liquid-lens\] \*\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("-webkit-user-select: none");
    expect(rule).toContain("user-select: none");
    expect(rule).toContain("-webkit-touch-callout: none");
  });

  it("navigue au contact, comme au cinéma", () => {
    render(<MobileNav />);
    const tab = layOut();
    fireEvent.pointerDown(tab("/radarr"), { pointerId: 3, button: 0, pointerType: "touch", clientX: 90, clientY: 10 });
    expect(push).toHaveBeenCalledWith("/radarr");
    fireEvent.pointerUp(window, { pointerId: 3, pointerType: "touch", clientX: 90, clientY: 10 });
    // Le clic qui suit l'appui ne navigue pas une seconde fois.
    fireEvent.click(tab("/radarr"));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("glisser d'un onglet à l'autre ouvre celui où le doigt est relâché, à la place du premier", () => {
    render(<MobileNav />);
    const tab = layOut();
    drag(tab("/radarr"), 2 * STEP + 20);
    expect(push).toHaveBeenCalledWith("/radarr");
    expect(replace).toHaveBeenCalledWith("/sonarr");
  });

  it("parti de l'onglet ouvert, le glisser ajoute la page choisie à l'historique", () => {
    render(<MobileNav />);
    const tab = layOut();
    drag(tab("/gestion"), 3 * STEP + 20);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/qbittorrent");
    expect(replace).not.toHaveBeenCalled();
  });

  it("relâché sur « Plus », il ouvre la feuille", () => {
    render(<MobileNav />);
    const tab = layOut();
    const more = screen.getByText("nav.mobile.more").closest("button")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    drag(tab("/gestion"), 4 * STEP + 20);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(push).not.toHaveBeenCalled();
  });
});
