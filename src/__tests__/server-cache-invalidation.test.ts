import { describe, it, expect, vi } from "vitest";

// Le module importe les clients et la base : on ne teste ici que sa mécanique en mémoire.
const disk = new Map<string, { value: unknown; fetchedAt: number }>();
vi.mock("@/lib/db", () => ({
  kvCacheDb: {
    get: (key: string) => disk.get(key),
    set: (key: string, value: unknown, fetchedAt: number) => disk.set(key, { value, fetchedAt }),
  },
}));
vi.mock("@/lib/clients/radarr", () => ({ radarr: {} }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: {} }));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: {} }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: {} }));

import { withCache, withPersistentCache, invalidateKey, invalidateByPrefix } from "@/lib/server-cache";

/** Une réponse qu'on libère à la main, pour placer l'invalidation pendant le trajet. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("invalidation pendant une requête en vol", () => {
  it("l'appel d'après repart d'une requête neuve, et l'ancienne réponse n'est pas gardée", async () => {
    const old = deferred<string>();
    const first = withCache("t:a", 60_000, () => old.promise);
    invalidateKey("t:a");
    // Avant le correctif : cet appel se joignait à la requête d'avant l'invalidation.
    const second = withCache("t:a", 60_000, async () => "neuf");
    expect(await second).toBe("neuf");
    old.resolve("ancien");
    // Qui attendait la première la reçoit — mais elle n'écrase pas la valeur neuve.
    expect(await first).toBe("ancien");
    expect(await withCache("t:a", 60_000, async () => "jamais appelé")).toBe("neuf");
  });

  it("par préfixe aussi, même quand la clé n'a encore rien en cache", async () => {
    const old = deferred<number>();
    const first = withCache("jf:items", 60_000, () => old.promise);
    invalidateByPrefix("jf:");
    old.resolve(1);
    await first;
    expect(await withCache("jf:items", 60_000, async () => 2)).toBe(2);
  });

  it("une requête en vol qui finit ne retire pas celle, plus récente, qui l'a remplacée", async () => {
    const old = deferred<string>();
    const fresh = deferred<string>();
    const first = withCache("t:b", 60_000, () => old.promise);
    invalidateKey("t:b");
    const second = withCache("t:b", 60_000, () => fresh.promise);
    old.resolve("ancien");
    await first;
    // Un troisième appel se joint à la requête neuve, toujours en vol.
    let calls = 0;
    const third = withCache("t:b", 60_000, async () => {
      calls += 1;
      return "autre";
    });
    fresh.resolve("neuf");
    expect(await second).toBe("neuf");
    expect(await third).toBe("neuf");
    expect(calls).toBe(0);
  });

  it("le cache persistant suit la même règle", async () => {
    const old = deferred<string>();
    const first = withPersistentCache("p:a", 60_000, () => old.promise);
    invalidateKey("p:a");
    const second = withPersistentCache("p:a", 60_000, async () => "neuf");
    expect(await second).toBe("neuf");
    old.resolve("ancien");
    expect(await first).toBe("ancien");
    expect(disk.get("p:a")?.value).toBe("neuf");
    expect(await withPersistentCache("p:a", 60_000, async () => "jamais appelé")).toBe("neuf");
  });
});
