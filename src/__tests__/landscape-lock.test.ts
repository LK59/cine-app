import { describe, it, expect, vi } from "vitest";
import { holdLandscape } from "@/lib/landscapeLock";

/** Le lecteur en paysage (18/11/2026) : demandé au navigateur, refus silencieux, relâché à la sortie. */
function fakeWindow({ touch = true, lock = vi.fn(() => Promise.resolve()), fullscreen = false } = {}) {
  const unlock = vi.fn();
  const listeners = new Map<string, () => void>();
  const doc = {
    fullscreenElement: fullscreen ? {} : null,
    addEventListener: (k: string, f: () => void) => listeners.set(k, f),
    removeEventListener: (k: string) => listeners.delete(k),
  };
  const w = { screen: { orientation: { lock, unlock } }, matchMedia: () => ({ matches: touch }), document: doc } as unknown as Window;
  return { w, lock, unlock, doc, listeners };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("holdLandscape", () => {
  it("tient l'écran couché sur un écran tactile, et le rend à la sortie", async () => {
    const { w, lock, unlock } = fakeWindow();
    const release = holdLandscape(w);
    await flush();
    expect(lock).toHaveBeenCalledWith("landscape");
    release();
    expect(unlock).toHaveBeenCalledTimes(1);
  });
  it("ne demande rien à un écran qu'on survole, ni sans la fonction", () => {
    const desk = fakeWindow({ touch: false });
    holdLandscape(desk.w)();
    expect(desk.lock).not.toHaveBeenCalled();
    expect(() => holdLandscape({ screen: {}, matchMedia: () => ({ matches: true }), document: {} } as unknown as Window)()).not.toThrow();
  });
  it("refusé (iPhone, hors plein écran) : silencieux, réessayé à l'entrée en plein écran", async () => {
    const lock = vi.fn().mockRejectedValueOnce(new Error("NotSupportedError")).mockResolvedValue(undefined);
    const { w, doc, listeners, unlock } = fakeWindow({ lock });
    const release = holdLandscape(w);
    await flush();
    expect(lock).toHaveBeenCalledTimes(1);
    doc.fullscreenElement = {};
    listeners.get("fullscreenchange")!();
    await flush();
    expect(lock).toHaveBeenCalledTimes(2);
    release();
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(listeners.has("fullscreenchange")).toBe(false);
  });
  it("relâché avant la réponse : rendu dès qu'elle arrive", async () => {
    const { w, unlock } = fakeWindow();
    holdLandscape(w)();
    await flush();
    expect(unlock).toHaveBeenCalledTimes(1);
  });
});
