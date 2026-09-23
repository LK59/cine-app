// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { saveUnsentStop, clearUnsentStop, findOrphanStops, flushOrphanStops, ORPHAN_AFTER_MS } from "@/lib/unsentStop";
import { reportPlayback } from "@/lib/reportPlayback";

/**
 * Le bilan d'une séance qu'iOS a tuée en arrière-plan.
 *
 * Douze séances sur 163, du 21 au 23/09/2026, n'avaient pas de ligne `stop` : la page n'a pas
 * survécu jusqu'à `pagehide`. Le bilan attend sur l'appareil et part au lancement suivant.
 */
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("le bilan gardé sur l'appareil", () => {
  it("n'est pas déclaré perdu tant que la séance peut encore le réécrire", () => {
    saveUnsentStop("abcd1234", { itemId: "x", watched: 60 }, 0);
    expect(findOrphanStops(ORPHAN_AFTER_MS - 1)).toEqual([]);
  });

  it("l'est passé ce délai, marqué comme tel, avec son retard", () => {
    saveUnsentStop("abcd1234", { itemId: "x", watched: 60 }, 0);
    const [found] = findOrphanStops(ORPHAN_AFTER_MS + 5000);
    expect(found.fields).toEqual({ itemId: "x", watched: 60, why: "lost", lateByMs: ORPHAN_AFTER_MS + 5000 });
  });

  it("disparaît quand l'arrêt est parti normalement", () => {
    saveUnsentStop("abcd1234", { itemId: "x" }, 0);
    clearUnsentStop("abcd1234");
    expect(findOrphanStops(10 * ORPHAN_AFTER_MS)).toEqual([]);
  });

  it("ne part du stockage qu'une fois accepté", async () => {
    saveUnsentStop("aaaa", { itemId: "a" }, 0);
    // Sans session — l'écran de connexion : refusé, gardé pour plus tard.
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await flushOrphanStops(ORPHAN_AFTER_MS + 1);
    expect(findOrphanStops(ORPHAN_AFTER_MS + 1)).toHaveLength(1);

    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await flushOrphanStops(ORPHAN_AFTER_MS + 1);
    expect(findOrphanStops(ORPHAN_AFTER_MS + 1)).toHaveLength(0);
    const body = JSON.parse((fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ kind: "stop", fields: { itemId: "a", why: "lost" } });
  });

  it("oublie ce qui est illisible", () => {
    localStorage.setItem("cine:unsent-stop:zzz", "{pas du json");
    expect(findOrphanStops(10 * ORPHAN_AFTER_MS)).toEqual([]);
    expect(localStorage.getItem("cine:unsent-stop:zzz")).toBeNull();
  });
});

describe("reportPlayback — l'arrêt part par balise", () => {
  it("confie la ligne `stop` à sendBeacon, qui survit à la page", () => {
    const beacon = vi.fn(() => true);
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    reportPlayback("stop", { itemId: "x" });
    expect(beacon).toHaveBeenCalledWith("/api/player/log", expect.any(Blob));
    expect(fetchMock).not.toHaveBeenCalled();

    // Les autres lignes, et une balise refusée, passent par fetch.
    reportPlayback("seek", { itemId: "x" });
    beacon.mockReturnValue(false);
    reportPlayback("stop", { itemId: "x" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(navigator, "sendBeacon", { value: undefined, configurable: true });
  });
});
