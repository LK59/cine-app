// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useRef } from "react";

let back = false;
vi.mock("@/lib/cinemaRoute", () => ({ arrivedByBack: () => back }));

import { usePanelScrollMemory } from "@/lib/panelScrollMemory";

class RO {
  constructor(private cb: () => void) {}
  observe() {
    this.cb();
  }
  disconnect() {}
}

function Body({ k }: { k: string }) {
  const ref = useRef<HTMLDivElement>(null);
  usePanelScrollMemory(ref, k);
  return (
    <div ref={ref} data-testid="body">
      <div />
    </div>
  );
}

function sized(el: HTMLElement) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 5000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 800 });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 5000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("la position d'une vue de l'activité (06/10/2026)", () => {
  it("est rendue en revenant en arrière", () => {
    sessionStorage.setItem("cine:panel-scroll", JSON.stringify({ "activite:1": 1234 }));
    back = true;
    const { getByTestId } = render(<Body k="activite:1" />);
    sized(getByTestId("body"));
    expect(getByTestId("body").scrollTop).toBe(1234);
  });

  it("n'est pas rendue quand on ouvre la vue normalement", () => {
    sessionStorage.setItem("cine:panel-scroll", JSON.stringify({ "activite:1": 1234 }));
    back = false;
    const { getByTestId } = render(<Body k="activite:1" />);
    expect(getByTestId("body").scrollTop).toBe(0);
  });
});
