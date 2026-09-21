// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

const apiAction = vi.fn();
vi.mock("@/lib/apiAction", () => ({ apiAction: (...a: unknown[]) => apiAction(...a) }));
const toastError = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: toastError, info: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/lib/watchlistCache", () => ({ noteWatchlistChange: vi.fn(), refreshWatchlistViews: vi.fn() }));

import { usePlayerTitleActions } from "@/lib/usePlayerTitleActions";

const REF = { tmdbId: 603, type: "movie" as const, title: "Matrix" };

beforeEach(() => {
  apiAction.mockReset();
  toastError.mockClear();
});
afterEach(cleanup);

/**
 * Ranger un titre dit si c'est fait.
 *
 * Rien n'était rendu : l'ajout depuis « Ma liste » cochait la ligne quoi qu'il arrive, et un ajout
 * refusé restait affiché comme fait à côté du message qui disait le contraire.
 */
describe("usePlayerTitleActions — setStatus", () => {
  it("rend true quand c'est rangé", async () => {
    apiAction.mockResolvedValue({});
    const { result } = renderHook(() => usePlayerTitleActions(REF));
    let done: boolean | undefined;
    await act(async () => {
      done = await result.current.setStatus("to_watch");
    });
    expect(done).toBe(true);
  });

  it("rend false quand c'est refusé, et le dit", async () => {
    apiAction.mockRejectedValue(new Error("Hors ligne"));
    const { result } = renderHook(() => usePlayerTitleActions(REF));
    let done: boolean | undefined;
    await act(async () => {
      done = await result.current.setStatus("to_watch");
    });
    expect(done).toBe(false);
    expect(toastError).toHaveBeenCalledWith("Hors ligne");
  });
});
