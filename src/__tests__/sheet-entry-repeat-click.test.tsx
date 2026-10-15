// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useRef } from "react";
import { useSwallowEntryRepeatClicks, ENTRY_REPEAT_CLICK_MS } from "@/lib/sheetMorph/entryClicks";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Sheet({ onSynopsis }: { onSynopsis: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useSwallowEntryRepeatClicks(ref);
  return (
    <div ref={ref}>
      <button type="button" onClick={onSynopsis}>
        Résumé
      </button>
    </div>
  );
}

// 15/10/2026 (passe de nuit, BUREAU-17 / ROBUSTESSE-2) : double-cliquer une affiche ouvrait la fiche,
// puis le second clic ouvrait le résumé (ou cochait « À voir ») de la fiche toute neuve.
describe("la suite d'un double-clic dans une fiche qui arrive", () => {
  it("est retenue ; un clic simple passe", () => {
    vi.useFakeTimers();
    const onSynopsis = vi.fn();
    render(<Sheet onSynopsis={onSynopsis} />);
    fireEvent.click(screen.getByText("Résumé"), { detail: 2 });
    expect(onSynopsis).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Résumé"), { detail: 1 });
    expect(onSynopsis).toHaveBeenCalledTimes(1);
  });

  it("n'est plus retenue une fois la fiche arrivée", () => {
    vi.useFakeTimers();
    const onSynopsis = vi.fn();
    render(<Sheet onSynopsis={onSynopsis} />);
    vi.advanceTimersByTime(ENTRY_REPEAT_CLICK_MS + 50);
    fireEvent.click(screen.getByText("Résumé"), { detail: 2 });
    expect(onSynopsis).toHaveBeenCalledTimes(1);
  });

  it("est posée par le crochet que toutes les fiches de titre traversent", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/sheetMorph/useSheetMorph.ts"), "utf8");
    const body = src.slice(src.indexOf("export function useSheetMorph("));
    expect(body.slice(0, 400)).toContain("useSwallowEntryRepeatClicks(opts.rootRef)");
  });
});
