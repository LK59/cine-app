// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
const passage = vi.hoisted(() => ({ target: "https://app.example.org" as string | null, mode: "closed" as "closed" | "full" | "mini", onboarding: false }));
vi.mock("swr", () => ({ default: (key: string) => ({ data: key === "/api/onboarding" ? { pending: passage.onboarding } : { target: passage.target } }) }));
vi.mock("@/components/PlaybackProvider", () => ({ usePlaybackMode: () => passage.mode }));
const app = vi.hoisted(() => ({ installed: false, apple: false }));
vi.mock("@/lib/iosInstall", async (orig) => ({
  ...(await orig<typeof import("@/lib/iosInstall")>()),
  isInstalledApp: () => app.installed,
  isAppleTouchDevice: () => app.apple,
}));
vi.mock("@/lib/passage/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/passage/client")>()),
  collectPassageInput: async () => ({ settings: {}, pushEndpoint: null, downloads: [] }),
}));

import { PassageBanner } from "@/components/passage/PassageBanner";
import { PASSAGE_BANNER_CLOSED_KEYS, openPassageFor } from "@/lib/passage/client";

/**
 * L'écran du passage sur l'ancienne adresse (DECISIONS.md §119, 25/10/2026) : plein, sans croix ; un
 * gros bouton dans un onglet, les étapes d'installation dans l'application installée ; jamais pendant
 * un film, ni sur la nouvelle adresse, ni sans réponse du serveur.
 */
const PASSAGE_URL = "https://app.example.org/passage#t=jeton";
let posts = 0;
const assign = vi.fn();
const open = vi.fn();

beforeEach(() => {
  passage.target = "https://app.example.org";
  passage.mode = "closed";
  passage.onboarding = false;
  app.installed = false;
  app.apple = false;
  posts = 0;
  assign.mockReset();
  open.mockReset();
  localStorage.clear();
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "/api/passage" && init?.method === "POST") {
      posts++;
      return Response.json({ url: PASSAGE_URL, code: "ABCDEFGH", codeExpiresAt: 0 });
    }
    return Response.json({});
  }) as typeof fetch;
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, host: "cine.example.org", assign } });
  window.open = open as unknown as typeof window.open;
});

afterEach(() => {
  cleanup();
});

const screenOf = () => document.querySelector("[data-passage-screen]");
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

describe("PassageBanner", () => {
  describe("dans un onglet", () => {
    it("un gros bouton, sans croix, qui ouvre la nouvelle adresse connecté — sans rien demander avant l'appui", async () => {
      render(<PassageBanner />);
      expect(screenOf()?.getAttribute("data-passage-screen")).toBe("tab");
      expect(screen.queryByLabelText(/close/i)).toBeNull();
      await settle();
      expect(posts).toBe(0);
      fireEvent.click(screen.getByText("passage.screen.continue"));
      await settle();
      expect(posts).toBe(1);
      expect(assign).toHaveBeenCalledWith(PASSAGE_URL);
    });

    it("dit l'échec sans quitter la page", async () => {
      globalThis.fetch = vi.fn(async () => Response.json({ error: "x" }, { status: 429 })) as typeof fetch;
      render(<PassageBanner />);
      fireEvent.click(screen.getByText("passage.screen.continue"));
      await settle();
      expect(assign).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toBe("passage.screen.rateLimited");
    });
  });

  describe("dans l'application installée", () => {
    it("iPhone : les étapes, le code montré, et le bouton copie le code puis ouvre la nouvelle adresse", async () => {
      app.installed = true;
      app.apple = true;
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      render(<PassageBanner />);
      await settle();
      expect(screenOf()?.getAttribute("data-passage-screen")).toBe("app");
      expect(document.querySelector("[data-passage-steps]")?.getAttribute("data-passage-steps")).toBe("ios");
      expect(document.querySelectorAll("[data-passage-steps] > li")).toHaveLength(5);
      expect(document.querySelector("[data-passage-code]")?.textContent).toBe("ABCD-EFGH");
      // Le bouton après la dernière étape : on lit tout avant de quitter l'écran.
      const steps = document.querySelector("[data-passage-steps]")!;
      const button = document.querySelector("[data-passage-open-new]")!;
      expect(steps.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(steps.contains(button)).toBe(false);
      fireEvent.click(screen.getByText("passage.screen.open"));
      expect(writeText).toHaveBeenCalledWith("ABCD-EFGH");
      expect(open).toHaveBeenCalledWith(PASSAGE_URL, "_blank", "noopener");
    });

    it("ailleurs : quatre étapes, sans code", async () => {
      app.installed = true;
      render(<PassageBanner />);
      await settle();
      expect(document.querySelectorAll("[data-passage-steps] > li")).toHaveLength(4);
      expect(document.querySelector("[data-passage-code]")).toBeNull();
      fireEvent.click(screen.getByText("passage.screen.open"));
      expect(open).toHaveBeenCalledWith(PASSAGE_URL, "_blank", "noopener");
    });
  });

  it("jamais pendant un film, plein écran ou réduit", () => {
    for (const installed of [false, true]) {
      app.installed = installed;
      for (const mode of ["full", "mini"] as const) {
        passage.mode = mode;
        const view = render(<PassageBanner />);
        expect(screenOf()).toBeNull();
        view.unmount();
      }
      passage.mode = "closed";
    }
  });

  it("même quand l'accueil d'un premier lancement est encore dû : passé sans être fini, il revient à chaque ouverture", () => {
    passage.onboarding = true;
    for (const installed of [false, true]) {
      app.installed = installed;
      const view = render(<PassageBanner />);
      expect(screenOf()).not.toBeNull();
      view.unmount();
    }
  });

  it("absent sur la nouvelle adresse elle-même", () => {
    passage.target = "https://cine.example.org";
    render(<PassageBanner />);
    expect(screenOf()).toBeNull();
  });

  it("absent sans réponse du serveur (hors connexion, ou pas de nouvelle adresse) : les téléchargements restent lisibles", () => {
    app.installed = true;
    passage.target = null;
    render(<PassageBanner />);
    expect(screenOf()).toBeNull();
  });

  it("efface les fermetures gardées par le bandeau des 10.0.x", () => {
    for (const key of PASSAGE_BANNER_CLOSED_KEYS) localStorage.setItem(key, "2026-10-24|2");
    render(<PassageBanner />);
    for (const key of PASSAGE_BANNER_CLOSED_KEYS) expect(localStorage.getItem(key)).toBeNull();
  });

  it("le lien de la page Nouveautés est pris en charge tant que l'écran est là, et seulement vers la nouvelle adresse", () => {
    render(<PassageBanner />);
    expect(openPassageFor("https://app.example.org/")).toBe(true);
    expect(openPassageFor("https://ailleurs.example.org/")).toBe(false);
    cleanup();
    expect(openPassageFor("https://app.example.org/")).toBe(false);
  });
});
