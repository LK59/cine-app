import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

async function fresh() {
  vi.resetModules();
  return import("@/lib/searchFocus");
}

// 15/10/2026 (passe de nuit, BUREAU-10) : « / » ouvrait la Recherche, mais le panneau — chargé à la
// demande — n'était pas monté quand la demande de focus partait ; le curseur restait sur le titre et
// la frappe n'allait nulle part.
describe("searchFocus — « / » ouvre la recherche pour taper", () => {
  it("attend le panneau, et le sert à son montage", async () => {
    const { requestSearchFocusOnOpen, onSearchFocusRequest } = await fresh();
    requestSearchFocusOnOpen();
    const listener = vi.fn();
    onSearchFocusRequest(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    // Consommée : un second montage ne lève rien.
    const again = vi.fn();
    onSearchFocusRequest(again);
    expect(again).not.toHaveBeenCalled();
  });

  it("ne sert pas une demande trop vieille", async () => {
    vi.useFakeTimers();
    const { requestSearchFocusOnOpen, onSearchFocusRequest } = await fresh();
    requestSearchFocusOnOpen();
    vi.advanceTimersByTime(5000);
    const listener = vi.fn();
    onSearchFocusRequest(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("sert tout de suite un panneau déjà là ; la demande du toucher, elle, n'attend pas", async () => {
    const { requestSearchFocusOnOpen, requestSearchFocus, onSearchFocusRequest } = await fresh();
    // Le toucher (second appui sur l'onglet) : sans panneau, rien — et rien ne reste en attente.
    requestSearchFocus();
    const late = vi.fn();
    const off = onSearchFocusRequest(late);
    expect(late).not.toHaveBeenCalled();
    requestSearchFocusOnOpen();
    expect(late).toHaveBeenCalledTimes(1);
    off();
  });

  it("est demandé par le raccourci « / » du bureau", () => {
    const src = readFileSync(join(process.cwd(), "src/components/cinema/CinemaClient.tsx"), "utf8");
    const handler = src.slice(src.indexOf('if (e.key !== "/") return;'), src.indexOf('window.addEventListener("keydown", onKey);', src.indexOf('if (e.key !== "/") return;')));
    expect(handler).toContain("setSearchOpen(true)");
    expect(handler).toContain("requestSearchFocusOnOpen()");
  });
});
