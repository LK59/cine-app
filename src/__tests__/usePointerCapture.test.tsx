// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { usePointerCapture } from "@/lib/usePointerCapture";

// Le protocole que trois gestes partagent, et qu'ils avaient écrit trois fois — correctement une
// seule. Ce qui est vérifié ici n'est pas un geste : c'est ce qui arrive autour.

afterEach(cleanup);

function target(overrides: Partial<{ setPointerCapture: () => void }> = {}) {
  return {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    ...overrides,
  };
}

const event = (currentTarget: unknown, pointerId = 7) => ({ currentTarget, pointerId });

describe("usePointerCapture", () => {
  it("prend puis rend", () => {
    const element = target();
    const { result } = renderHook(() => usePointerCapture());

    act(() => result.current.take(event(element)));
    expect(element.setPointerCapture).toHaveBeenCalledWith(7);

    act(() => result.current.release());
    expect(element.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("rend au démontage ce que le geste n'a pas rendu", () => {
    // Le cas qui gelait l'interface : l'élément quitte le DOM pendant le geste, le navigateur ne
    // voit jamais de levée, et WebKit cesse d'acheminer les pointeurs vers la page.
    const element = target();
    const { result, unmount } = renderHook(() => usePointerCapture());
    act(() => result.current.take(event(element)));
    expect(element.releasePointerCapture).not.toHaveBeenCalled();

    unmount();
    expect(element.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("ne rend qu'une fois, quel que soit le nombre d'appels", () => {
    const element = target();
    const { result, unmount } = renderHook(() => usePointerCapture());
    act(() => result.current.take(event(element)));
    act(() => {
      result.current.release();
      result.current.release();
    });
    unmount();
    expect(element.releasePointerCapture).toHaveBeenCalledTimes(1);
  });

  it("ne rend rien quand rien n'a été pris", () => {
    const { result, unmount } = renderHook(() => usePointerCapture());
    expect(() => {
      act(() => result.current.release());
      unmount();
    }).not.toThrow();
  });

  it("ne lève pas quand le pointeur n'est plus actif", () => {
    // `setPointerCapture` refuse un pointeur déjà relâché, ce qui arrive sous les doigts pressés.
    // Non rattrapée, l'exception part d'un gestionnaire React et emporte l'arbre — pour un geste
    // qui n'aurait rien fait de toute façon.
    const element = target({
      setPointerCapture: vi.fn(() => {
        throw new DOMException("InvalidPointerId");
      }),
    });
    const { result } = renderHook(() => usePointerCapture());

    expect(() => act(() => result.current.take(event(element)))).not.toThrow();
    // Rien n'a été pris, donc il n'y a rien à rendre — ni maintenant, ni au démontage.
    act(() => result.current.release());
    expect(element.releasePointerCapture).not.toHaveBeenCalled();
  });

  it("ne lève pas non plus quand le relâchement est refusé", () => {
    // L'élément peut avoir déjà perdu la capture — retiré du document, par exemple.
    const element = target();
    element.releasePointerCapture = vi.fn(() => {
      throw new DOMException("InvalidPointerId");
    });
    const { result, unmount } = renderHook(() => usePointerCapture());
    act(() => result.current.take(event(element)));

    expect(() => act(() => result.current.release())).not.toThrow();
    // Et il ne réessaie pas indéfiniment : l'échec compte comme rendu.
    unmount();
    expect(element.releasePointerCapture).toHaveBeenCalledTimes(1);
  });

  it("ignore une cible qui ne sait pas capturer", () => {
    // Décrite par sa forme et non par `instanceof` : ce qui ne sait pas prendre est simplement
    // laissé tranquille, sans exception à rattraper plus haut.
    const { result } = renderHook(() => usePointerCapture());
    expect(() => act(() => result.current.take(event({})))).not.toThrow();
    expect(() => act(() => result.current.take(event(null)))).not.toThrow();
  });

  it("suit le dernier élément quand le geste change de cible", () => {
    const first = target();
    const second = target();
    const { result } = renderHook(() => usePointerCapture());

    act(() => result.current.take(event(first)));
    act(() => result.current.take(event(second, 9)));
    act(() => result.current.release());

    expect(second.releasePointerCapture).toHaveBeenCalledWith(9);
  });
});
