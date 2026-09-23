// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { useEffect } from "react";
import { ToastProvider, useToast } from "@/components/Toast";

/**
 * Les toasts entrent et sortent (23/09/2026) : ils apparaissaient et disparaissaient d'un coup,
 * et un retrait faisait tomber d'un bloc ceux du dessus.
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let toast: ReturnType<typeof useToast>;
const keep = (t: ReturnType<typeof useToast>) => {
  toast = t;
};
function Grab({ onReady }: { onReady: (t: ReturnType<typeof useToast>) => void }) {
  const t = useToast();
  useEffect(() => onReady(t), [t, onReady]);
  return null;
}
const mount = () => render(<ToastProvider><Grab onReady={keep} /></ToastProvider>);

describe("Toast", () => {
  it("entre en montant, et s'annonce", () => {
    mount();
    act(() => toast.success("Ajouté"));
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("Ajouté");
    expect(el.className).toContain("animate-fade-in-up");
  });

  it("une erreur interrompt", () => {
    mount();
    act(() => toast.error("Échec"));
    expect(screen.getByRole("alert")).toHaveTextContent("Échec");
  });

  it("sort en s'effaçant avant de quitter la pile", () => {
    mount();
    act(() => toast.info("Info"));
    act(() => void vi.advanceTimersByTime(4000));
    const el = screen.getByRole("status");
    expect(el.className).toContain("animate-fade-out");
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("la croix puis le minuteur ne font qu'une sortie", () => {
    mount();
    act(() => toast.info("Info"));
    act(() => void fireEvent.click(screen.getByRole("button")));
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => void vi.advanceTimersByTime(4000));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
