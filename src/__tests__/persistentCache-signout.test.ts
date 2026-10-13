import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Une réponse arrivée pendant la déconnexion ne se réécrit pas sur l'appareil (13/10/2026).
 *
 * `signOut` efface le cache, puis attend `/api/auth/logout` avant de recharger la page — plus d'une
 * seconde sur un réseau lent. Une requête déjà en vol (« Reprendre » au retour sur l'onglet, Ma
 * liste) qui répondait dans cet intervalle était réécrite une seconde plus tard sous le compte qui
 * partait : sa reprise restait sur un iPad partagé après « Se déconnecter ».
 */
afterEach(() => vi.unstubAllGlobals());

describe("cache du catalogue et déconnexion", () => {
  it("rien n'est réécrit après l'effacement de la déconnexion", async () => {
    const { fakeIndexedDb } = await import("./helpers/fakeIndexedDb");
    const cache = await import("@/lib/persistentCache");
    cache.resetPersistentCacheForTests();
    vi.stubGlobal("indexedDB", fakeIndexedDb());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await cache.hydrateFromDisk("louis", { has: () => false, set: () => {} });

    await cache.clearPersistedCache();
    // La réponse d'une requête partie avant la déconnexion.
    cache.noteResponse("/api/jellyfin/resume", { items: [{ id: "film" }] });
    await new Promise((r) => setTimeout(r, 1300));

    expect(await cache.readAccountCache("louis")).toEqual([]);
    cache.resetPersistentCacheForTests();
  });
});
