// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { InstallPrompt } from "@/components/InstallPrompt";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { ...window.navigator, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1" });
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  try {
    localStorage.clear();
  } catch {}
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 15/10/2026 (passe de nuit, MOBILE-1 / ROBUSTESSE-9) : dans Safari sur iPhone, la bannière se posait
// exactement sur la barre du bas du cinéma — ses quatre onglets ne répondaient plus — et sa seule
// sortie était une croix de 13 px sans nom.
describe("bannière « Installer »", () => {
  it("se pose au-dessus de la réserve de la barre du bas, avec une croix nommée de 44 px", () => {
    render(<InstallPrompt />);
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    const close = screen.getByRole("button", { name: "common.close" });
    expect(close.className).toContain("h-11");
    expect(close.className).toContain("w-11");
    const frame = close.closest<HTMLElement>(".fixed")!;
    expect(frame.style.paddingBottom).toContain("var(--player-bar-space, 0px)");
  });

  // La même décision pour l'autre bannière du bas (« Réactiver les notifications ») : une seule
  // valeur, lue par les deux.
  it("est partagée avec la bannière des notifications", () => {
    const src = readFileSync(join(process.cwd(), "src/components/player/PushResumePrompt.tsx"), "utf8");
    expect(src).toContain("paddingBottom: ABOVE_BOTTOM_BAR");
    expect(src).toContain("PROMPT_CLOSE_CLASS");
  });
});
