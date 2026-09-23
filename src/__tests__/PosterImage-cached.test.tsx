// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { PosterImage } from "@/components/PosterImage";

/**
 * Une affiche déjà en mémoire s'affiche sans fondu (23/09/2026) : le fondu de 500 ms se rejouait
 * à chaque retour sur une page, pour une image que le navigateur avait déjà.
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
  for (const [key, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(proto, key, descriptor);
  }
});

describe("PosterImage", () => {
  it("affiche aussitôt une image déjà en mémoire", () => {
    browserHas(true);
    const { container } = render(<PosterImage src="/api/jellyfin/image/a" alt="A" />);
    const img = container.querySelector("img")!;
    expect(img.style.opacity).toBe("1");
    expect(img.style.transition).toBe("none");
  });

  it("garde le fondu pour une image qui arrive", () => {
    browserHas(false);
    const { container } = render(<PosterImage src="/api/jellyfin/image/b" alt="B" />);
    const img = container.querySelector("img")!;
    expect(img.style.opacity).toBe("");
    expect(img.className).toContain("duration-500");
  });
});
