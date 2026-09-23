// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { Modal } from "@/components/Modal";

/**
 * Le geste de fermeture de la fenêtre modale (23/09/2026).
 *
 * - Un simple appui sur la poignée pouvait la fermer : la vitesse seule était jugée, et un doigt
 *   qui se pose et se lève bouge toujours de quelques pixels en quelques millisecondes — le défaut
 *   déjà corrigé dans `useSwipeToDismiss` (`MIN_FLICK_PX`).
 * - Un glissement était abandonné en cours de route quand le parent se redessinait : l'effet des
 *   gestes dépendait de `onClose`, recréé à chaque rendu (qBittorrent se rafraîchit toutes les
 *   cinq secondes), et son nettoyage oubliait le doigt posé. La carte restait à mi-hauteur.
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function touch(target: Element, type: string, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = [{ clientY: y }];
  Object.defineProperty(event, type === "touchend" ? "changedTouches" : "touches", { value: point });
  act(() => void target.dispatchEvent(event));
}

const handleOf = () => document.querySelector("[data-drag-handle]")!;

describe("Modal — geste de fermeture", () => {
  it("un appui bref sur la poignée ne ferme pas la fenêtre", () => {
    const onClose = vi.fn();
    render(<Modal title="Titre" onClose={onClose}>contenu</Modal>);
    touch(handleOf(), "touchstart", 100);
    act(() => void vi.advanceTimersByTime(4));
    touch(handleOf(), "touchend", 103);
    act(() => void vi.advanceTimersByTime(500));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("un vrai coup de doigt vers le bas la ferme", () => {
    const onClose = vi.fn();
    render(<Modal title="Titre" onClose={onClose}>contenu</Modal>);
    touch(handleOf(), "touchstart", 100);
    act(() => void vi.advanceTimersByTime(60));
    touch(handleOf(), "touchmove", 160);
    touch(handleOf(), "touchend", 160);
    act(() => void vi.advanceTimersByTime(500));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("un glissement survit à un nouveau rendu du parent", () => {
    const first = vi.fn();
    const { rerender } = render(<Modal title="Titre" onClose={first}>contenu</Modal>);
    touch(handleOf(), "touchstart", 100);
    touch(handleOf(), "touchmove", 200);
    // Le parent se redessine en plein geste, avec une nouvelle fonction de fermeture.
    const second = vi.fn();
    rerender(<Modal title="Titre" onClose={second}>contenu</Modal>);
    touch(handleOf(), "touchmove", 300);
    touch(handleOf(), "touchend", 300);
    act(() => void vi.advanceTimersByTime(500));
    // La plus récente, celle que le parent a donnée en dernier.
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
