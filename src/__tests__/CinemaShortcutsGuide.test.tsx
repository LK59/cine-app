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

  // 18/11/2026 : à 1024 px, la légende chevauchait « Livres » de la bascule centrée. Mesuré dans
  // Chromium : plus de contact dès ~1 060 px en français ; le seuil garde la marge de l'espagnol.
  it("ne s'affiche qu'à partir de 1180 px, là où elle ne touche plus la bascule", async () => {
    media.touch = false;
    stubMedia();
    const { CinemaShortcutsGuide } = await import("@/components/cinema/CinemaShortcutsGuide");
    const { container } = render(<CinemaShortcutsGuide />);
    const cls = (container.firstElementChild as HTMLElement).className.split(/\s+/);
    expect(cls).toContain("hidden");
    expect(cls).toContain("min-[1180px]:flex");
    expect(cls).not.toContain("md:flex");
  });
});
