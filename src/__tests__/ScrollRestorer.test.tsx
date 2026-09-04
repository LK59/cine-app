// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const mockPathname = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => mockPathname() }));

import { ScrollRestorer } from "@/components/ScrollRestorer";

/** Un conteneur de défilement qui se laisse mesurer, comme le <main> de l'app. */
function mountMain(): HTMLElement {
  const main = document.createElement("main");
  document.body.appendChild(main);
  return main;
}

/** jsdom ne peint rien : sans hauteur déclarée, scrollTop reste collé à zéro. */
function makeScrollable(main: HTMLElement, height: number) {
  Object.defineProperty(main, "scrollHeight", { value: height, configurable: true });
  Object.defineProperty(main, "clientHeight", { value: 500, configurable: true });
  let top = 0;
  Object.defineProperty(main, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, height - 500));
    },
  });
}

async function flushFrames() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

let main: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id as unknown as NodeJS.Timeout));
  sessionStorage.clear();
  main = mountMain();
  makeScrollable(main, 5000);
});

afterEach(() => {
  cleanup();
  main.remove();
  vi.unstubAllGlobals();
});

describe("ScrollRestorer", () => {
  it("remonte en haut en arrivant sur une fiche, quoi qu'il ait été mémorisé pour elle", async () => {
    sessionStorage.setItem("scroll:/radarr/42", "1800");
    mockPathname.mockReturnValue("/radarr/42");
    main.scrollTop = 900;

    render(<ScrollRestorer />);
    await flushFrames();

    expect(main.scrollTop).toBe(0);
  });

  it("rend sa place à une grille dont on revient", async () => {
    sessionStorage.setItem("scroll:/radarr", "1800");
    mockPathname.mockReturnValue("/radarr");

    render(<ScrollRestorer />);
    await flushFrames();

    expect(main.scrollTop).toBe(1800);
    // Consommée : rouvrir la grille par un lien neuf repart du haut.
    expect(sessionStorage.getItem("scroll:/radarr")).toBeNull();
  });

  /**
   * Le bug signalé. La restauration surveillait la croissance du DOM pendant cinq secondes pour
   * attendre les données ; elle ne s'arrêtait pas en quittant la page, et continuait donc de
   * repousser la page suivante à l'ancienne position pendant qu'elle se remplissait.
   */
  it("cesse de restaurer dès qu'on a quitté la page", async () => {
    sessionStorage.setItem("scroll:/radarr", "1800");
    mockPathname.mockReturnValue("/radarr");
    // Trop courte pour accepter 1800 : l'observateur se met en place et attend.
    makeScrollable(main, 600);

    const { rerender } = render(<ScrollRestorer />);
    await flushFrames();
    expect(main.scrollTop).toBeLessThan(1800);

    mockPathname.mockReturnValue("/radarr/42");
    rerender(<ScrollRestorer />);
    await flushFrames();

    // La fiche se remplit : le DOM grandit, et plus rien ne doit y toucher.
    makeScrollable(main, 5000);
    await act(async () => {
      main.appendChild(document.createElement("div"));
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(main.scrollTop).toBe(0);
  });

  it("ne mémorise pas la position d'une fiche quand on la quitte par un lien", async () => {
    mockPathname.mockReturnValue("/radarr/42");
    window.history.replaceState({}, "", "/radarr/42");
    render(<ScrollRestorer />);
    await flushFrames();

    main.scrollTop = 900;
    const link = document.createElement("a");
    link.setAttribute("href", "/radarr/43");
    document.body.appendChild(link);
    await act(async () => { link.click(); });

    expect(sessionStorage.getItem("scroll:/radarr/42")).toBeNull();
    link.remove();
  });

  it("mémorise en revanche celle d'une grille", async () => {
    mockPathname.mockReturnValue("/radarr");
    window.history.replaceState({}, "", "/radarr");
    render(<ScrollRestorer />);
    await flushFrames();

    main.scrollTop = 1200;
    const link = document.createElement("a");
    link.setAttribute("href", "/radarr/42");
    document.body.appendChild(link);
    await act(async () => { link.click(); });

    expect(sessionStorage.getItem("scroll:/radarr")).toBe("1200");
    link.remove();
  });

  it("ignore les liens qui quittent l'app", async () => {
    mockPathname.mockReturnValue("/radarr");
    window.history.replaceState({}, "", "/radarr");
    render(<ScrollRestorer />);
    await flushFrames();

    main.scrollTop = 1200;
    const link = document.createElement("a");
    link.setAttribute("href", "https://example.com");
    document.body.appendChild(link);
    await act(async () => { link.click(); });

    expect(sessionStorage.getItem("scroll:/radarr")).toBeNull();
    link.remove();
  });
});
