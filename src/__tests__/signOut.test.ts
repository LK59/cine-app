import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { signOut } from "@/lib/signOut";
import { prefetchPlaybackState, takePrefetchedPlaybackState } from "@/lib/playbackPrefetch";

afterEach(() => vi.unstubAllGlobals());

/**
 * Se déconnecter hors ligne mène quand même à la page de connexion.
 *
 * Les trois boutons attendaient `fetch` sans le garder : hors ligne il levait, la redirection ne
 * partait jamais, et le rejet finissait dans server.log. On appuyait, et rien ne se passait.
 */
describe("signOut", () => {
  it("prévient le serveur, puis va à la connexion", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const go = vi.fn();
    await signOut(go);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(go).toHaveBeenCalledWith("/login");
  });

  it("va à la connexion même quand le réseau manque, sans lever", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
    const go = vi.fn();
    await expect(signOut(go)).resolves.toBeUndefined();
    expect(go).toHaveBeenCalledWith("/login");
  });

  it("oublie l'état du spectateur demandé d'avance pour le compte qui part", async () => {
    // Chasse aux bugs du 22/09/2026 : la table n'est rangée que par titre, et la déconnexion
    // ne recharge pas la page. Le compte suivant, ouvrant le même film dans les trente
    // secondes, reprenait à la position du compte précédent.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ resumeSeconds: 1200, preferences: null }) }));
    prefetchPlaybackState("film");
    await signOut(vi.fn());
    expect(takePrefetchedPlaybackState("film")).toBeNull();
  });

  it("efface le catalogue gardé sur l'appareil avant de partir", async () => {
    // 25/09/2026 : un iPad partagé ne doit rien garder de la bibliothèque ni de la reprise du
    // compte qui s'en va.
    const { fakeIndexedDb } = await import("./helpers/fakeIndexedDb");
    const cache = await import("@/lib/persistentCache");
    cache.resetPersistentCacheForTests();
    vi.stubGlobal("indexedDB", fakeIndexedDb());
    await cache.writeEntries([{ account: "louis", key: "/api/jellyfin/resume", savedAt: Date.now(), schema: cache.PERSISTED_CACHE_SCHEMA, data: { items: [] } }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await signOut(vi.fn());
    expect(await cache.readAccountCache("louis")).toEqual([]);
    cache.resetPersistentCacheForTests();
  });

  // Une seule façon de se déconnecter : trois copies non gardées, c'est ainsi que le défaut
  // existait trois fois.
  it("est la seule à appeler la déconnexion côté client", () => {
    for (const f of ["src/components/player/PlayerAccountPanel.tsx", "src/components/Sidebar.tsx", "src/components/MobileNav.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect([f, src.includes("signOut(")]).toEqual([f, true]);
      expect([f, src.includes('"/api/auth/logout"')]).toEqual([f, false]);
    }
  });
});
