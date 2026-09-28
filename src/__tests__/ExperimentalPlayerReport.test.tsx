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
  it("est une photo : les rendus suivants ne la réécrivent pas, « Actualiser » la reprend", async () => {
    const { rerender } = render(<ExperimentalPlayerReport input={input("10 s")} />);
    const text = () => (screen.getByRole("textbox") as HTMLTextAreaElement).value;
    await waitFor(() => expect(text()).toContain("HEVC matériel"));
    expect(text()).toContain("Position: 10 s");

    rerender(<ExperimentalPlayerReport input={input("11 s")} />);
    rerender(<ExperimentalPlayerReport input={input("12 s")} />);
    expect(text()).toContain("Position: 10 s");

    await act(async () => void screen.getByRole("button", { name: "player.report.refresh" }).click());
    expect(text()).toContain("Position: 12 s");
  });

  it("copie l'état du moment, pas la photo de l'ouverture", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { rerender } = render(<ExperimentalPlayerReport input={input("10 s")} />);
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("HEVC"));
    rerender(<ExperimentalPlayerReport input={input("42 s")} />);
    await act(async () => void screen.getByText("player.report.copy").click());
    expect(writeText.mock.calls[0][0]).toContain("Position: 42 s");
  });
});
