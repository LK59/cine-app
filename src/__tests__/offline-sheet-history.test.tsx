// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useState } from "react";
import { useOfflineSheetBack, __resetOfflineSheetHistory } from "@/lib/offline/offlineSheetHistory";

/**
 * Retour ferme la fiche hors ligne, pas la page des téléchargements (Louis, 19/10/2026) : la fiche a
 * son entrée d'historique, comme le lecteur ; la fermer autrement rend cette entrée.
 */

const popped = () => new Promise<void>((resolve) => window.addEventListener("popstate", () => setTimeout(resolve, 0), { once: true }));

function Sheet({ onClose }: { onClose: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useOfflineSheetBack(() => {
    onClose();
    setLeaving(true);
  }, leaving);
  return (
    <button type="button" onClick={() => setLeaving(true)}>
      fermer
    </button>
  );
}

afterEach(() => {
  cleanup();
  __resetOfflineSheetHistory();
});

describe("l'entrée d'historique de la fiche hors ligne", () => {
  it("Retour ferme la fiche, et l'adresse ne bouge pas", async () => {
    const start = window.history.length;
    const onClose = vi.fn();
    const { getByText } = render(<Sheet onClose={onClose} />);
    expect(window.history.length).toBe(start + 1);
    const href = window.location.href;
    const done = popped();
    window.history.back();
    await act(() => done);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(href);
    expect(getByText("fermer")).toBeTruthy();
  });

  it("la croix rend l'entrée sans rien fermer de plus", async () => {
    const onClose = vi.fn();
    const before = (window.history.state ?? {}) as Record<string, unknown>;
    const { getByText } = render(<Sheet onClose={onClose} />);
    expect(typeof (window.history.state as Record<string, unknown>).cineOfflineSheet).toBe("string");
    const done = popped();
    await act(async () => getByText("fermer").click());
    await act(() => done);
    expect(onClose).not.toHaveBeenCalled();
    expect((window.history.state ?? {}) as Record<string, unknown>).toEqual(before);
  });
});
