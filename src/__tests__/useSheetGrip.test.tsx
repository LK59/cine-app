// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useSheetGrip } from "@/components/cinema/CinemaDetailLayout";

/**
 * La poignée des fiches du bureau, au doigt (tablette). Relâchée sous le seuil, la fiche revenait
 * d'un coup : `offset` repassait à 0 et `dragging` à faux dans le même rendu, et le style qui
 * portait la transition disparaissait avec eux (23/09/2026).
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Sheet({ onDismiss }: { onDismiss: () => void }) {
  const { style, grip } = useSheetGrip(onDismiss, true);
  return (
    <div data-testid="sheet" style={style}>
      {grip}
    </div>
  );
}

const pointer = (el: Element, type: string, clientY: number) =>
  act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY })));

describe("useSheetGrip", () => {
  it("revient en place en glissant, puis ne laisse rien au repos", () => {
    const { getByTestId } = render(<Sheet onDismiss={vi.fn()} />);
    const sheet = getByTestId("sheet");
    const grip = sheet.firstElementChild!;
    pointer(grip, "pointerdown", 100);
    pointer(grip, "pointermove", 140);
    expect(sheet.style.transform).toBe("translateY(40px)");
    act(() => void vi.advanceTimersByTime(500));
    pointer(grip, "pointerup", 140);
    // Le retour s'anime : la position revient à zéro, avec sa transition.
    expect(sheet.style.transform).toBe("translateY(0px)");
    expect(sheet.style.transition).toContain("transform 280ms");
    act(() => void vi.advanceTimersByTime(300));
    // Et au repos, aucun `transform` : le bouton Retour, en `fixed`, en dépend.
    expect(sheet.style.transform).toBe("");
  });
});
