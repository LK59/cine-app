// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { forgetHeldThumbs, nearestFirst, thumbHeld, warmThumbs } from "@/lib/episodeThumbs";

/**
 * Les miniatures du menu « Épisodes », chargées d'avance (19/10/2026) : l'épisode en cours puis ses
 * voisins, une requête à la fois, gardées une fois chargées et décodées.
 */

const started: string[] = [];
const pending: { url: string; ok: () => void }[] = [];
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decoding = "";
  set src(url: string) {
    started.push(url);
    pending.push({ url, ok: () => this.onload?.() });
  }
  decode() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  started.length = 0;
  pending.length = 0;
  forgetHeldThumbs();
  vi.stubGlobal("Image", FakeImage);
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("miniatures du menu « Épisodes »", () => {
  it("l'épisode en cours, puis celui d'avant, celui d'après, en s'éloignant", () => {
    expect(nearestFirst([1, 2, 3, 4, 5, 6], 2)).toEqual([3, 2, 4, 1, 5, 6]);
    expect(nearestFirst([1, 2, 3], 0)).toEqual([1, 2, 3]);
    expect(nearestFirst([1, 2, 3], -1)).toEqual([1, 2, 3]);
  });

  it("une requête à la fois ; gardée une fois chargée ; jamais redemandée", async () => {
    warmThumbs(["/a", "/b", "/a"], () => false);
    expect(started).toEqual(["/a"]);
    pending.shift()!.ok();
    await flush();
    expect(thumbHeld("/a")).toBe(true);
    expect(started).toEqual(["/a", "/b"]);
    pending.shift()!.ok();
    await flush();
    warmThumbs(["/a", "/b"], () => false);
    await flush();
    expect(started).toEqual(["/a", "/b"]);
  });

  it("arrêtée entre deux quand la séance change", async () => {
    let cancelled = false;
    warmThumbs(["/a", "/b"], () => cancelled);
    cancelled = true;
    pending.shift()!.ok();
    await flush();
    expect(started).toEqual(["/a"]);
  });
});
