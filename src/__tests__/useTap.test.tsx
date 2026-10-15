// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TapButton } from "@/components/TapButton";

afterEach(cleanup);

/**
 * 04/10/2026 : au bout d'une page qu'on vient de faire défiler, iOS gardait le premier clic pour
 * arrêter l'élan — « Voir tous les films » demandait deux appuis. L'appui est servi au relâchement.
 */
describe("un appui servi au relâchement", () => {
  const setup = () => {
    const onTap = vi.fn();
    render(<TapButton onTap={onTap}>Voir tout</TapButton>);
    return { onTap, button: screen.getByRole("button") };
  };

  it("part au relâchement du doigt, et le clic qui suit ne le rejoue pas", () => {
    const { onTap, button } = setup();
    fireEvent.pointerDown(button, { pointerType: "touch", pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(button, { pointerType: "touch", pointerId: 1, clientX: 12, clientY: 11 });
    expect(onTap).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("ne part pas pour un doigt qui a glissé (un défilement), ni pour un geste repris", () => {
    const { onTap, button } = setup();
    fireEvent.pointerDown(button, { pointerType: "touch", pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(button, { pointerType: "touch", pointerId: 2, clientX: 10, clientY: 60 });
    fireEvent.pointerDown(button, { pointerType: "touch", pointerId: 3, clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(button, { pointerId: 3 });
    fireEvent.pointerUp(button, { pointerType: "touch", pointerId: 3, clientX: 10, clientY: 10 });
    expect(onTap).not.toHaveBeenCalled();
  });

  // 15/10/2026 (ROBUSTESSE-1) : le clic de compatibilité qui suit l'appui tombait sur « Lire » de la
  // fiche qui venait de s'ouvrir sous le doigt — le film démarrait sur Android.
  it("retient l'écho du doigt qui tombe sur un autre bouton, et seulement lui", () => {
    const onTap = vi.fn();
    const onPlay = vi.fn();
    render(
      <>
        <TapButton onTap={onTap}>Affiche</TapButton>
        <button type="button" onClick={onPlay}>
          Lire
        </button>
      </>,
    );
    const poster = screen.getByRole("button", { name: "Affiche" });
    const play = screen.getByRole("button", { name: "Lire" });
    fireEvent.pointerDown(poster, { pointerType: "touch", pointerId: 7, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(poster, { pointerType: "touch", pointerId: 7, clientX: 10, clientY: 10 });
    expect(onTap).toHaveBeenCalledTimes(1);
    // L'écho du relâchement (un clic de doigt porte `detail: 1`) atterrit sur « Lire » : retenu.
    fireEvent.click(play, { detail: 1 });
    expect(onPlay).not.toHaveBeenCalled();
    // Le vrai appui suivant commence par un `pointerdown` : son clic passe.
    fireEvent.pointerDown(play, { pointerType: "touch", pointerId: 8 });
    fireEvent.click(play, { detail: 1 });
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("ne retient ni un clic clavier ni un clic d'après le délai", () => {
    vi.useFakeTimers();
    try {
      const onPlay = vi.fn();
      render(
        <>
          <TapButton onTap={() => {}}>Affiche</TapButton>
          <button type="button" onClick={onPlay}>
            Lire
          </button>
        </>,
      );
      const poster = screen.getByRole("button", { name: "Affiche" });
      const play = screen.getByRole("button", { name: "Lire" });
      fireEvent.pointerDown(poster, { pointerType: "touch", pointerId: 9, clientX: 1, clientY: 1 });
      fireEvent.pointerUp(poster, { pointerType: "touch", pointerId: 9, clientX: 1, clientY: 1 });
      // Entrée sur un bouton : `detail` vaut 0.
      fireEvent.click(play, { detail: 0 });
      expect(onPlay).toHaveBeenCalledTimes(1);
      fireEvent.pointerDown(poster, { pointerType: "touch", pointerId: 10, clientX: 1, clientY: 1 });
      fireEvent.pointerUp(poster, { pointerType: "touch", pointerId: 10, clientX: 1, clientY: 1 });
      vi.advanceTimersByTime(800);
      fireEvent.click(play, { detail: 1 });
      expect(onPlay).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("garde le clic pour la souris et le clavier", () => {
    const { onTap, button } = setup();
    fireEvent.pointerDown(button, { pointerType: "mouse", pointerId: 4 });
    fireEvent.pointerUp(button, { pointerType: "mouse", pointerId: 4 });
    expect(onTap).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});
