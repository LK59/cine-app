// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

const apiAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/apiAction", () => ({ apiAction }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));

import { useRemoveFromResume } from "@/lib/useRemoveFromResume";
import { RESUME_KEY } from "@/lib/swr";

/**
 * Retirer un film de « Reprendre » (23/09/2026) : la carte part tout de suite, le serveur oublie la
 * position, et un échec se dit — la carte revient.
 */
afterEach(() => {
  apiAction.mockReset();
  toastError.mockReset();
});

const FILM = "b".repeat(32);
function setup() {
  const cache = new Map<string, unknown>([[RESUME_KEY, { data: { items: [{ id: FILM }, { id: "c".repeat(32) }] } }]]);
  const wrapper = function Wrapper({ children }: { children: ReactNode }) {
    return <SWRConfig value={{ provider: () => cache as never, fetcher: async () => ({ items: [{ id: FILM }, { id: "c".repeat(32) }] }) }}>{children}</SWRConfig>;
  };
  const { result } = renderHook(() => useRemoveFromResume(), { wrapper });
  const items = () => (cache.get(RESUME_KEY) as { data: { items: { id: string }[] } }).data.items.map((i) => i.id);
  return { remove: result.current, items };
}

describe("useRemoveFromResume", () => {
  it("retire la carte tout de suite, puis demande l'oubli de la position", async () => {
    let seenBeforeServer: string[] = [];
    const { remove, items } = setup();
    apiAction.mockImplementation(async () => {
      seenBeforeServer = items();
    });
    await act(async () => remove(FILM));
    expect(seenBeforeServer).not.toContain(FILM);
    expect(apiAction).toHaveBeenCalledWith(RESUME_KEY, { method: "DELETE", body: JSON.stringify({ itemId: FILM }) });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("dit l'échec au lieu de le taire", async () => {
    const { remove } = setup();
    apiAction.mockRejectedValue(new Error("502"));
    await act(async () => remove(FILM));
    expect(toastError).toHaveBeenCalledWith("cinema.removeFromContinueFailed");
  });
});
