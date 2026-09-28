// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/webcodecs/capabilities", () => ({
  probeCapabilities: vi.fn().mockResolvedValue({}),
  describeCapabilities: () => ({ "HEVC matériel": "oui" }),
}));

import { ExperimentalPlayerReport, type ReportInput } from "@/components/ExperimentalPlayerReport";

afterEach(cleanup);

const input = (position: string): ReportInput => ({
  error: null,
  elapsedMs: null,
  title: "Un film",
  itemId: "abc",
  file: null,
  pathReason: "remultiplexage",
  diagnostics: { Position: position },
  running: true,
});

/**
 * Le rapport du panneau technique (28/09/2026) : réécrit à chaque rendu — toutes les 500 ms —, il
 * ramenait sans cesse la zone de texte en haut et figeait le défilement sur iPhone.
 */
describe("ExperimentalPlayerReport", () => {
  it("se tient à jour en direct, et copie ce qu'il montre", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { rerender } = render(<ExperimentalPlayerReport input={input("10 s")} />);
    const text = () => screen.getByTestId("player-report-text").textContent ?? "";
    await waitFor(() => expect(text()).toContain("HEVC matériel"));
    rerender(<ExperimentalPlayerReport input={input("42 s")} />);
    expect(text()).toContain("Position: 42 s");
    await act(async () => void screen.getByText("player.report.copy").click());
    expect(writeText.mock.calls[0][0]).toContain("Position: 42 s");
  });

  it("dans le panneau, suit son défilement — aucune zone défilante imbriquée, aucune sélection au toucher", () => {
    // 28/09/2026, iPhone : défiler dans le rapport bloquait tout le panneau.
    render(<ExperimentalPlayerReport input={input("10 s")} flow />);
    const text = screen.getByTestId("player-report-text");
    expect(text.tagName).toBe("PRE");
    expect(text.className).not.toContain("overflow-y-auto");
    expect(text.className).toContain("select-text");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("ailleurs (écran d'erreur, attente), garde sa propre zone bornée", () => {
    render(<ExperimentalPlayerReport input={input("10 s")} />);
    expect(screen.getByTestId("player-report-text").className).toContain("max-h-48");
  });
});
