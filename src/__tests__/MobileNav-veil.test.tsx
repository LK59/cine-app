// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/gestion", useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/lib/signOut", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/leaveCinema", () => ({ enterCinema: vi.fn() }));
vi.mock("@/lib/prefetch", () => ({ prefetchRoute: vi.fn() }));
vi.mock("@/lib/pwaRefresh", () => ({ hardRefreshApp: vi.fn() }));

import { MobileNav } from "@/components/MobileNav";

/**
 * Le voile de la feuille « Plus » fond avec elle (23/09/2026) : il apparaissait et disparaissait
 * d'un coup pendant que la feuille glissait en 300 ms.
 */
afterEach(cleanup);

const veil = () => document.querySelector<HTMLElement>("div[aria-hidden].bg-black\\/60")!;

describe("MobileNav — le voile", () => {
  it("reste monté, caché, quand la feuille est fermée", () => {
    render(<MobileNav />);
    expect(veil()).not.toBeNull();
    expect(veil().className).toContain("invisible");
    expect(veil().className).toContain("opacity-0");
  });

  it("fond à l'ouverture et à la fermeture au lieu d'apparaître d'un coup", () => {
    render(<MobileNav />);
    act(() => void fireEvent.click(screen.getByText("nav.mobile.more")));
    expect(veil().className).toContain("opacity-100");
    expect(veil().className).toContain("transition-[opacity,visibility]");
    act(() => void fireEvent.click(veil()));
    expect(veil()).not.toBeNull();
    expect(veil().className).toContain("opacity-0");
  });

  it("efface l'opacité qu'une fermeture au doigt a laissée, à la réouverture", () => {
    render(<MobileNav />);
    act(() => void fireEvent.click(screen.getByText("nav.mobile.more")));
    veil().style.opacity = "0"; // ce que le geste écrit en fermant
    act(() => void fireEvent.click(veil()));
    act(() => void fireEvent.click(screen.getByText("nav.mobile.more")));
    expect(veil().style.opacity).toBe("");
  });
});
