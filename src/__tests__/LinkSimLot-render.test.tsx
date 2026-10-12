// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ play: vi.fn(), session: null }) }));

afterEach(cleanup);

// Le lot s'ouvrait sur l'erreur React #185 (boucle de rendu) : il doit simplement s'afficher.
describe("LinkSimLot", () => {
  it("s'affiche sans boucler", async () => {
    const { LinkSimLot } = await import("@/components/animlab/LinkSimLot");
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((e) => errors.push(e));
    expect(() => render(<LinkSimLot movies={[]} />)).not.toThrow();
    spy.mockRestore();
    expect(errors.filter((e) => String(e).includes("185") || String(e).includes("Maximum update depth"))).toEqual([]);
  });
});
