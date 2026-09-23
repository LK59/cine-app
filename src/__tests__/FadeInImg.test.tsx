// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { FadeInImg } from "@/components/FadeInImg";

/**
 * Les visuels des fiches arrivent en fondu, comme les affiches, et ne le rejouent pas quand le
 * navigateur les a déjà (23/09/2026) : ils surgissaient d'un coup sur une bannière vide.
 */
const proto = HTMLImageElement.prototype;
const original = {
  complete: Object.getOwnPropertyDescriptor(proto, "complete"),
  naturalWidth: Object.getOwnPropertyDescriptor(proto, "naturalWidth"),
};
function browserHas(cached: boolean) {
  Object.defineProperty(proto, "complete", { configurable: true, get: () => cached });
  Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => (cached ? 300 : 0) });
}
afterEach(() => {
  cleanup();
  for (const [key, d] of Object.entries(original)) if (d) Object.defineProperty(proto, key, d);
});

describe("FadeInImg", () => {
  it("attend son chargement, puis apparaît en fondu", () => {
    browserHas(false);
    const onLoad = vi.fn();
    const { container } = render(<FadeInImg src="/a.jpg" className="absolute inset-0" onLoad={onLoad} />);
    const img = container.querySelector("img")!;
    expect(img.className).toContain("opacity-0");
    expect(img.className).toContain("absolute inset-0");
    expect(img.style.opacity).toBe("");
    fireEvent.load(img);
    expect(img.style.opacity).toBe("1");
    expect(onLoad).toHaveBeenCalled();
  });

  it("s'affiche aussitôt quand le navigateur l'a déjà", () => {
    browserHas(true);
    const { container } = render(<FadeInImg src="/b.jpg" />);
    const img = container.querySelector("img")!;
    expect(img.style.opacity).toBe("1");
    expect(img.style.transition).toBe("none");
  });

  it("laisse passer une erreur à l'appelant", () => {
    browserHas(false);
    const onError = vi.fn();
    const { container } = render(<FadeInImg src="/absent.jpg" onError={onError} />);
    fireEvent.error(container.querySelector("img")!);
    expect(onError).toHaveBeenCalled();
  });
});
