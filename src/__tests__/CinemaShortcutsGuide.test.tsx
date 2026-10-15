// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));

const media = vi.hoisted(() => ({ touch: false }));

function stubMedia() {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("hover: none") ? media.touch : false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// 15/10/2026 (passe de nuit, MOBILE-10) : sur un iPad en portrait, la légende des flèches couvrait
// « Séries » de la bascule Films/Séries — impossible de changer d'onglet au doigt.
describe("légende des raccourcis", () => {
  it("n'est pas rendue sur un appareil qu'on touche", async () => {
    media.touch = true;
    stubMedia();
    const { CinemaShortcutsGuide } = await import("@/components/cinema/CinemaShortcutsGuide");
    const { container } = render(<CinemaShortcutsGuide />);
    expect(container.textContent).toBe("");
  });

  it("reste au clavier et à la souris, sans jamais prendre un clic", async () => {
    media.touch = false;
    stubMedia();
    const { CinemaShortcutsGuide } = await import("@/components/cinema/CinemaShortcutsGuide");
    const { container } = render(<CinemaShortcutsGuide />);
    expect(container.textContent).toContain("cinema.shortcutsNavigate");
    expect((container.firstElementChild as HTMLElement).className).toContain("pointer-events-none");
  });
});
