// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));

import { CinemaModeToggle } from "@/components/cinema/CinemaModeToggle";

afterEach(cleanup);

// 15/10/2026 (passe de nuit, ROBUSTESSE-11) : la bascule Films / Séries ne disait pas, à un lecteur
// d'écran, lequel des deux était actif — la lentille ne le dit qu'à l'œil.
describe("la bascule Films / Séries", () => {
  it("expose l'onglet actif", () => {
    const { rerender } = render(<CinemaModeToggle placement="inline" mode="movies" onChange={() => {}} />);
    expect(screen.getByText("cinema.moviesTab").closest("button")!.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("cinema.seriesTab").closest("button")!.getAttribute("aria-pressed")).toBe("false");
    rerender(<CinemaModeToggle placement="inline" mode="series" onChange={() => {}} />);
    expect(screen.getByText("cinema.seriesTab").closest("button")!.getAttribute("aria-pressed")).toBe("true");
  });
});
