// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { __testing } from "@/lib/webcodecs/renderer";

const { FallbackRenderer } = __testing as unknown as {
  FallbackRenderer: new (
    canvas: HTMLCanvasElement,
    hdr: () => { draw: (f: unknown) => unknown; destroy: () => void },
    onFallback: (reason: string) => void,
    makeFallback: (c: HTMLCanvasElement) => { draw: (f: unknown) => unknown; destroy: () => void }
  ) => { draw: (f: unknown) => unknown; destroy: () => void };
};

function mounted(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  return canvas;
}

/**
 * Mesuré sur un Chrome Windows : les images d'un décodeur matériel sont opaques, `format` est
 * nul, et `allocationSize()` lève — c'est ce qui déclenche ce repli sur un fichier Dolby Vision.
 */
const opaqueFrame = {} as unknown;

describe("le repli du rendu HDR", () => {
  it("laisse le canevas exactement où il était", () => {
    const canvas = mounted();
    const fallback = { draw: vi.fn(), destroy: vi.fn() };
    const hdr = { draw: vi.fn(() => { throw new Error("format is null"); }), destroy: vi.fn() };

    const renderer = new FallbackRenderer(canvas, () => hdr, vi.fn(), () => fallback);
    renderer.draw(opaqueFrame);

    // Le nœud rendu par React est toujours dans le document, et c'est bien le même.
    expect(canvas.isConnected).toBe(true);
    expect(document.body.firstElementChild).toBe(canvas);
  });

  it("dessine sur le canevas qui est dans le document, pas sur une copie", () => {
    const canvas = mounted();
    const fallback = { draw: vi.fn(), destroy: vi.fn() };
    const hdr = { draw: vi.fn(() => { throw new Error("format is null"); }), destroy: vi.fn() };
    const makeFallback = vi.fn(() => fallback);

    const renderer = new FallbackRenderer(canvas, () => hdr, vi.fn(), makeFallback);
    renderer.draw(opaqueFrame);
    renderer.draw(opaqueFrame);

    expect(makeFallback).toHaveBeenCalledWith(canvas);
    expect(fallback.draw).toHaveBeenCalledTimes(2);
  });

  it("dit une fois pourquoi, et ne le répète pas à chaque image", () => {
    const canvas = mounted();
    const onFallback = vi.fn();
    const fallback = { draw: vi.fn(), destroy: vi.fn() };
    const hdr = { draw: vi.fn(() => { throw new Error("format is null"); }), destroy: vi.fn() };

    const renderer = new FallbackRenderer(canvas, () => hdr, onFallback, () => fallback);
    renderer.draw(opaqueFrame);
    renderer.draw(opaqueFrame);
    renderer.draw(opaqueFrame);

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith("format is null");
  });

  it("ferme le rendu HDR abandonné plutôt que de le laisser sur le contexte", () => {
    const canvas = mounted();
    const hdr = { draw: vi.fn(() => { throw new Error("format is null"); }), destroy: vi.fn() };

    const renderer = new FallbackRenderer(canvas, () => hdr, vi.fn(), () => ({ draw: vi.fn(), destroy: vi.fn() }));
    renderer.draw(opaqueFrame);
    expect(hdr.destroy).toHaveBeenCalled();
  });
});
