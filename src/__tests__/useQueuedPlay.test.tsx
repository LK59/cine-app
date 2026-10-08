// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useQueuedPlay } from "@/lib/useQueuedPlay";

/**
 * Un appui qui précède la confirmation de la cible part à son arrivée, avec la cible confirmée —
 * jamais la supposition (08/10/2026).
 */
describe("useQueuedPlay", () => {
  it("lance tout de suite quand la cible est sûre", () => {
    const fire = vi.fn();
    const { result } = renderHook(() => useQueuedPlay(false, fire));
    act(() => result.current());
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("retient l'appui, puis lance ce que la réponse a dit", () => {
    const launched: string[] = [];
    const { result, rerender } = renderHook(({ waiting, target }) => useQueuedPlay(waiting, () => launched.push(target)), {
      initialProps: { waiting: true, target: "s1e1" },
    });
    act(() => result.current());
    expect(launched).toEqual([]);
    rerender({ waiting: false, target: "s2e3" });
    expect(launched).toEqual(["s2e3"]);
    // Une seule fois.
    rerender({ waiting: false, target: "s2e3" });
    expect(launched).toEqual(["s2e3"]);
  });
});
