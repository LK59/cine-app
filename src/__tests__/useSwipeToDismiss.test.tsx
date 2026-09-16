// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pointer(clientY: number): React.PointerEvent {
  return {
    clientY,
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    currentTarget: { setPointerCapture: vi.fn() },
  } as unknown as React.PointerEvent;
}

// window.innerHeight is 768 in jsdom, so the distance threshold is 768 * 0.22 ≈ 169, capped at 160.
const THRESHOLD = 160;

describe("useSwipeToDismiss", () => {
  it("tracks the finger one-to-one and can be dragged back up", () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss(onDismiss));

    act(() => result.current.handlers.onPointerDown(pointer(100)));
    expect(result.current.dragging).toBe(true);

    act(() => result.current.handlers.onPointerMove(pointer(180)));
    expect(result.current.offset).toBe(80);

    act(() => result.current.handlers.onPointerMove(pointer(130)));
    expect(result.current.offset).toBe(30);
  });

  it("never goes above its starting position", () => {
    const { result } = renderHook(() => useSwipeToDismiss(vi.fn()));
    act(() => result.current.handlers.onPointerDown(pointer(200)));
    act(() => result.current.handlers.onPointerMove(pointer(50)));
    expect(result.current.offset).toBe(0);
  });

  it("springs back when released short of the threshold", () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss(onDismiss));

    act(() => result.current.handlers.onPointerDown(pointer(0)));
    act(() => result.current.handlers.onPointerMove(pointer(THRESHOLD - 40)));
    // Slow enough not to count as a flick.
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 2000);
    act(() => result.current.handlers.onPointerUp(pointer(THRESHOLD - 40)));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(result.current.offset).toBe(0);
    expect(result.current.dragging).toBe(false);
  });

  it("dismisses when dragged past the threshold", () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss(onDismiss));

    act(() => result.current.handlers.onPointerDown(pointer(0)));
    act(() => result.current.handlers.onPointerMove(pointer(THRESHOLD + 20)));
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 2000);
    act(() => result.current.handlers.onPointerUp(pointer(THRESHOLD + 20)));

    expect(onDismiss).toHaveBeenCalledOnce();
    // Continues off the bottom rather than snapping back first.
    expect(result.current.offset).toBe(window.innerHeight);
  });

  it("dismisses on a short but fast flick", () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss(onDismiss));

    act(() => result.current.handlers.onPointerDown(pointer(0)));
    act(() => result.current.handlers.onPointerMove(pointer(60)));
    act(() => result.current.handlers.onPointerUp(pointer(60)));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("ignores a move that never started with a press", () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss(onDismiss));

    act(() => result.current.handlers.onPointerMove(pointer(300)));
    act(() => result.current.handlers.onPointerUp(pointer(300)));

    expect(result.current.offset).toBe(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  describe("la capture du pointeur", () => {
    // WebKit cesse d'acheminer les pointeurs vers la page quand une capture reste détenue par un
    // nœud retiré du DOM : tout est dessiné, plus rien ne répond, et seul un geste du navigateur
    // en sort. Ces fiches sont montées et démontées par la navigation, et depuis qu'un titre
    // différent est une instance différente, un appui rapide démonte l'élément porteur du geste.
    function capturing() {
      const element = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
      const event = { clientY: 100, pointerId: 7, pointerType: "touch", button: 0, currentTarget: element };
      return { element, event: event as unknown as React.PointerEvent };
    }

    it("la rend quand le geste se termine", () => {
      const { element, event } = capturing();
      const { result } = renderHook(() => useSwipeToDismiss(vi.fn()));

      act(() => result.current.handlers.onPointerDown(event));
      expect(element.setPointerCapture).toHaveBeenCalledWith(7);

      act(() => result.current.handlers.onPointerUp(event));
      expect(element.releasePointerCapture).toHaveBeenCalledWith(7);
    });

    it("la rend aussi quand le geste est annulé", () => {
      const { element, event } = capturing();
      const { result } = renderHook(() => useSwipeToDismiss(vi.fn()));
      act(() => result.current.handlers.onPointerDown(event));
      act(() => result.current.handlers.onPointerCancel(event));
      expect(element.releasePointerCapture).toHaveBeenCalledWith(7);
    });

    it("la rend au démontage, doigt encore posé", () => {
      // Le cas qui gelait l'interface : la fiche disparaît au milieu du geste, le navigateur ne
      // voit jamais de levée, et personne ne lui rend la capture.
      const { element, event } = capturing();
      const { result, unmount } = renderHook(() => useSwipeToDismiss(vi.fn()));
      act(() => result.current.handlers.onPointerDown(event));
      expect(element.releasePointerCapture).not.toHaveBeenCalled();

      unmount();
      expect(element.releasePointerCapture).toHaveBeenCalledWith(7);
    });

    it("ne la rend qu'une fois", () => {
      const { element, event } = capturing();
      const { result, unmount } = renderHook(() => useSwipeToDismiss(vi.fn()));
      act(() => result.current.handlers.onPointerDown(event));
      act(() => result.current.handlers.onPointerUp(event));
      unmount();
      expect(element.releasePointerCapture).toHaveBeenCalledTimes(1);
    });

    it("survit à un pointeur déjà parti au moment de la prise", () => {
      // `setPointerCapture` lève sur un pointeur inactif — un appui déjà relâché quand l'événement
      // arrive, ce qui se produit sous les doigts pressés. Non rattrapée, l'exception part d'un
      // gestionnaire React et emporte l'arbre, pour un geste qui n'aurait rien fait.
      const element = {
        setPointerCapture: vi.fn(() => {
          throw new DOMException("InvalidPointerId");
        }),
        releasePointerCapture: vi.fn(),
      };
      const event = { clientY: 100, pointerId: 7, pointerType: "touch", button: 0, currentTarget: element };
      const { result } = renderHook(() => useSwipeToDismiss(vi.fn()));

      expect(() => act(() => result.current.handlers.onPointerDown(event as unknown as React.PointerEvent))).not.toThrow();
      // Le geste reste utilisable : il suivra tant que le doigt ne quitte pas l'élément.
      act(() => result.current.handlers.onPointerMove({ clientY: 180, pointerId: 7 } as unknown as React.PointerEvent));
      expect(result.current.offset).toBe(80);
      // Et rien à rendre, puisque rien n'a été pris.
      act(() => result.current.handlers.onPointerUp(event as unknown as React.PointerEvent));
      expect(element.releasePointerCapture).not.toHaveBeenCalled();
    });
  });
});
