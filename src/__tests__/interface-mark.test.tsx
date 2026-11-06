// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { createElement, type ComponentType } from "react";

/**
 * La marque d'interface posée avant le premier dessin (06/11/2026).
 *
 * Le serveur ne sait pas quel appareil l'appelle : `useIsMobile` lui répond « ordinateur », et le
 * HTML qu'un iPhone recevait dessinait le rail du bureau jusqu'au démarrage du code, puis le
 * remplaçait par la barre du bas. Un script du layout décide avant le premier dessin, par la même
 * règle (`interfaceDecision.ts`), et le CSS ne laisse voir que la bonne navigation et le bon
 * squelette.
 *
 * Trois choses à tenir : le script et le crochet répondent pareil dans tous les cas où la règle
 * n'est pas une simple largeur (iPad, choix Compte → Interface, Fire TV, simulateur d'iPad) ; le
 * HTML du serveur, sous une marque « tactile », ne montre pas le rail ; et l'hydratation ne s'en
 * plaint pas.
 */
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string) => k,
  useLocale: () => ({ locale: "fr" }),
}));
vi.mock("@/components/player/PlayerRail", () => ({ PlayerRail: () => createElement("nav", { "data-testid": "rail" }) }));
vi.mock("@/components/player/PlayerBottomBar", () => ({ PlayerBottomBar: () => createElement("nav", { "data-testid": "bar" }) }));
vi.mock("next/dynamic", () => ({
  default: (_loader: () => Promise<ComponentType>) =>
    function Nothing() {
      return null;
    },
}));
vi.mock("@/lib/prefetch", () => ({ preloadQuietly: () => Promise.resolve() }));
vi.mock("@/lib/warmPanels", () => ({ scheduleWarmPanels: () => () => {} }));
vi.mock("@/lib/useRole", () => ({ useRole: () => ({ role: "user" }) }));

import { useIsMobile, canChooseInterface, resetInterfaceForTests } from "@/lib/useIsMobile";
import { interfaceMarkScript, INTERFACE_MARK } from "@/lib/interfaceDecision";
import { PlayerShell } from "@/components/player/PlayerShell";
import { HomeSkeletons } from "@/components/cinema/HomeSkeleton";

type Device = { narrow?: boolean; touch?: boolean; anyCoarse?: boolean; screen?: [number, number]; ua?: string };

// Le même appareil simulé que `interface-choice.test.tsx`.
function device({ narrow = false, touch = false, anyCoarse = touch, screen = [1194, 834], ua = "Mozilla/5.0 (Macintosh)" }: Device) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width: 767px") ? narrow : query.includes("hover: none") ? touch : query.includes("any-pointer: coarse") ? anyCoarse : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Object.defineProperty(window, "screen", { configurable: true, value: { width: screen[0], height: screen[1] } });
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: ua });
}

/** Le script tel que le layout l'envoie, exécuté seul : sans la portée du module. */
function runScript(): string | null {
  document.documentElement.removeAttribute(INTERFACE_MARK);
  new Function(interfaceMarkScript())();
  return document.documentElement.getAttribute(INTERFACE_MARK);
}

const hook = () => (renderHook(() => useIsMobile()).result.current ? "touch" : "desktop");

const FIRE_TV = "Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36 (KHTML, like Gecko) Silk/112.3.1 like Chrome/112.0 Safari/537.36";
const IPHONE: Device = { narrow: true, touch: true, screen: [390, 844], ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)" };
const IPAD: Device = { touch: true };
const PC: Device = { touch: false, anyCoarse: false, screen: [1920, 1080] };
const PC_TACTILE: Device = { touch: false, anyCoarse: true, screen: [1920, 1080] };

const CASES: Array<{ name: string; device: Device; storage?: Record<string, string>; expected: "touch" | "desktop" }> = [
  { name: "un iPhone", device: IPHONE, expected: "touch" },
  { name: "un iPhone qui a rangé « Ordinateur » (sans effet : pas proposé)", device: IPHONE, storage: { "cine:interface": "desktop" }, expected: "touch" },
  { name: "un iPad en automatique", device: IPAD, expected: "touch" },
  { name: "un iPad réglé sur « Ordinateur »", device: IPAD, storage: { "cine:interface": "desktop" }, expected: "desktop" },
  { name: "un iPad réglé sur « Tactile »", device: IPAD, storage: { "cine:interface": "touch" }, expected: "touch" },
  { name: "un ordinateur à souris", device: PC, expected: "desktop" },
  { name: "un ordinateur à souris qui a rangé « Tactile » (sans effet)", device: PC, storage: { "cine:interface": "touch" }, expected: "desktop" },
  { name: "un PC à écran tactile réglé sur « Tactile »", device: PC_TACTILE, storage: { "cine:interface": "touch" }, expected: "touch" },
  { name: "une Fire TV", device: { touch: true, screen: [1920, 1080], ua: FIRE_TV }, expected: "desktop" },
  { name: "une Fire TV qui a rangé « Tactile » (sans effet)", device: { touch: true, screen: [1920, 1080], ua: FIRE_TV }, storage: { "cine:interface": "touch" }, expected: "desktop" },
  { name: "le simulateur d'iPad sur un iPhone", device: { ...IPHONE, narrow: false }, storage: { "cine:simu-ipad": "1" }, expected: "touch" },
  {
    name: "le simulateur d'iPad réglé sur « Ordinateur », la méta viewport pas encore relue",
    device: IPHONE,
    storage: { "cine:simu-ipad": "1", "cine:interface": "desktop" },
    expected: "desktop",
  },
];

describe("le script d'avant le premier dessin décide comme `useIsMobile`", () => {
  beforeEach(() => {
    resetInterfaceForTests();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute(INTERFACE_MARK);
  });

  it.each(CASES)("$name", ({ device: d, storage, expected }) => {
    device(d);
    for (const [k, v] of Object.entries(storage ?? {})) window.localStorage.setItem(k, v);
    expect(runScript()).toBe(expected);
    expect(hook()).toBe(expected);
  });

  it("le choix n'est proposé que là où le script le lit aussi", () => {
    device(IPAD);
    expect(canChooseInterface()).toBe(true);
    resetInterfaceForTests();
    device({ touch: true, screen: [1920, 1080], ua: FIRE_TV });
    expect(canChooseInterface()).toBe(false);
  });

  it("un script en échec ne pose rien, et ne lève pas", () => {
    vi.stubGlobal("matchMedia", () => {
      throw new Error("refusé");
    });
    expect(() => runScript()).not.toThrow();
    expect(document.documentElement.hasAttribute(INTERFACE_MARK)).toBe(false);
  });
});

/** Les règles de `globals.css` qui lisent la marque — les vraies, pas une copie. */
function markCss(): string {
  const css = readFileSync("src/app/globals.css", "utf8");
  const rules = css.match(/html(?::not\(\[data-ui="touch"\]\)|\[data-ui="(?:touch|desktop)"\])[^{]*\{[^}]*\}/g) ?? [];
  expect(rules.length).toBeGreaterThanOrEqual(3);
  return rules.join("\n");
}

function shown(el: Element | null): boolean {
  for (let node = el; node; node = node.parentElement) if (getComputedStyle(node).display === "none") return false;
  return true;
}

describe("le HTML du serveur sous la marque", () => {
  let style: HTMLStyleElement;
  let root: Root | null = null;
  beforeEach(() => {
    resetInterfaceForTests();
    window.localStorage.clear();
    style = document.createElement("style");
    style.textContent = markCss();
    document.head.appendChild(style);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    style.remove();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute(INTERFACE_MARK);
    vi.unstubAllGlobals();
  });

  it("sur un téléphone, ne montre pas le rail du bureau mais la barre du bas", () => {
    const html = renderToString(createElement(PlayerShell));
    // Le serveur rend les deux : c'est la marque qui choisit.
    expect(html).toContain('data-testid="rail"');
    expect(html).toContain('data-testid="bar"');
    document.body.innerHTML = `<div id="app">${html}</div>`;
    device(IPHONE);
    runScript();
    expect(shown(document.querySelector('[data-testid="rail"]'))).toBe(false);
    expect(shown(document.querySelector('[data-testid="bar"]'))).toBe(true);
    // Et la réserve du rail est nulle dès le premier dessin, celle de la barre posée.
    const vars = getComputedStyle(document.documentElement);
    expect(vars.getPropertyValue("--player-rail").trim()).toBe("0px");
    expect(vars.getPropertyValue("--player-bar-space").trim()).toBe("5.5rem");
  });

  it("sur un ordinateur, le rail et sa réserve, pas la barre", () => {
    document.body.innerHTML = `<div id="app">${renderToString(createElement(PlayerShell))}</div>`;
    device(PC);
    runScript();
    expect(shown(document.querySelector('[data-testid="rail"]'))).toBe(true);
    expect(shown(document.querySelector('[data-testid="bar"]'))).toBe(false);
    expect(getComputedStyle(document.documentElement).getPropertyValue("--player-rail").trim()).toBe("3.75rem");
  });

  it("sans marque (script en échec), l'interface ordinateur, comme avant", () => {
    document.body.innerHTML = `<div id="app">${renderToString(createElement(PlayerShell))}</div>`;
    expect(shown(document.querySelector('[data-testid="rail"]'))).toBe(true);
    expect(shown(document.querySelector('[data-testid="bar"]'))).toBe(false);
  });

  it("s'hydrate sans désaccord, garde la seule bonne navigation et tient la marque à jour", async () => {
    document.body.innerHTML = `<div id="app">${renderToString(createElement(PlayerShell))}</div>`;
    device(IPHONE);
    runScript();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = document.getElementById("app")!;
    await act(async () => {
      root = hydrateRoot(app, createElement(PlayerShell), {
        onRecoverableError: (e) => {
          throw e;
        },
      });
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    expect(app.querySelector('[data-testid="rail"]')).toBeNull();
    expect(shown(app.querySelector('[data-testid="bar"]'))).toBe(true);
    expect(document.documentElement.getAttribute(INTERFACE_MARK)).toBe("touch");
    expect(document.documentElement.style.getPropertyValue("--player-rail")).toBe("0px");
  });

  it("l'écran de lancement montre le squelette de l'accueil du téléphone, pas celui du bureau", () => {
    document.body.innerHTML = `<div id="app">${renderToString(createElement(HomeSkeletons))}</div>`;
    device(IPHONE);
    runScript();
    expect(shown(document.querySelector('[data-ui-only="touch"] > *'))).toBe(true);
    expect(shown(document.querySelector('[data-ui-only="desktop"] > *'))).toBe(false);
  });
});

describe("les réserves de la marque sont celles de PlayerShell", () => {
  it("mêmes valeurs dans globals.css et dans PlayerShell.tsx", () => {
    const shell = readFileSync("src/components/player/PlayerShell.tsx", "utf8");
    const rail = shell.match(/export const RAIL_WIDTH = "([^"]+)"/)![1];
    const bar = shell.match(/export const BAR_SPACE = "([^"]+)"/)![1];
    const css = markCss();
    expect(css).toMatch(new RegExp(`html\\[data-ui="desktop"\\]\\s*\\{[^}]*--player-rail:\\s*${rail.replace(".", "\\.")}`));
    expect(css).toMatch(new RegExp(`html\\[data-ui="touch"\\]\\s*\\{[^}]*--player-bar-space:\\s*${bar.replace(".", "\\.")}`));
  });

  it("le layout du cinéma envoie le script, après celui du simulateur", () => {
    const layout = readFileSync("src/app/(player)/layout.tsx", "utf8");
    const simulator = layout.indexOf("ipadSimulatorScript()");
    const mark = layout.indexOf("interfaceMarkScript()");
    expect(simulator).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(simulator);
  });
});
