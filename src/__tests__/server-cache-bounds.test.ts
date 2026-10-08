import { describe, it, expect, vi } from "vitest";

// La mécanique en mémoire seulement — voir `server-cache-invalidation.test.ts`.
vi.mock("@/lib/db", () => ({ kvCacheDb: { get: () => null, set: () => {} } }));
vi.mock("@/lib/clients/radarr", () => ({ radarr: {} }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: {} }));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: {} }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: {} }));
vi.mock("@/lib/clients/qbittorrent", () => ({ qbittorrent: {} }));

import { withCache, sweepServerCache, serverCacheSizes } from "@/lib/server-cache";

/**
 * Le cache en mémoire est borné (08/10/2026) : chaque texte cherché, chaque plage du calendrier y
 * restait jusqu'au redémarrage, et une boucle sur des requêtes au hasard menait le conteneur à sa
 * limite mémoire.
 */
describe("les bornes du cache du serveur", () => {
  it("ne garde pas plus de quatre mille entrées, quelles que soient les clés demandées", async () => {
    for (let i = 0; i < 4_200; i++) await withCache(`borne:${i}`, 60_000, async () => i);
    expect(serverCacheSizes().store).toBeLessThanOrEqual(4_000);
    expect(serverCacheSizes().stale).toBeLessThanOrEqual(1_500);
  });

  it("lâche la moins servie, pas celle qu'on vient de relire", async () => {
    const fn = vi.fn(async () => "gardée");
    await withCache("borne:servie", 60_000, fn);
    for (let i = 0; i < 3_000; i++) {
      await withCache(`borne:remplissage:${i}`, 60_000, async () => i);
      // Relue régulièrement : elle remonte en tête à chaque fois.
      if (i % 500 === 0) await withCache("borne:servie", 60_000, fn);
    }
    await withCache("borne:servie", 60_000, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("le balayage retire ce qui a expiré", async () => {
    await withCache("borne:courte", 1, async () => "x");
    const before = serverCacheSizes().store;
    sweepServerCache(Date.now() + 10);
    expect(serverCacheSizes().store).toBeLessThan(before);
  });
});
