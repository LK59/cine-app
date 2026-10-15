import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CATALOGUE_REFRESH_AFTER_MS,
  catalogueRefreshDue,
  catalogueUnchanged,
  noteCatalogueRead,
  reconcileCatalogue,
  refreshCatalogues,
  resetCatalogueRefreshForTests,
  type RefreshIo,
} from "@/lib/catalogueRefresh";
import { MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY } from "@/lib/catalogueKeys";

/**
 * La relecture du catalogue au retour au premier plan (DECISIONS.md §94) : la règle des quinze
 * minutes, la requête conditionnelle, une seule relecture en vol, et la copie de secours de §92 qui
 * ne remplace pas un catalogue plus récent.
 */

const T0 = Date.parse("2026-10-15T10:00:00Z");

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
}

function io(overrides: Partial<RefreshIo> = {}): RefreshIo & { applied: [string, unknown][] } {
  const applied: [string, unknown][] = [];
  const held = new Map<string, unknown>();
  return {
    keys: [MOVIES_CATALOGUE_KEY],
    heldNow: (key) => held.get(key),
    apply: (key, data) => {
      applied.push([key, data]);
      held.set(key, data);
    },
    canApply: () => true,
    whenQuiet: async () => undefined,
    read: async (_key, res) => res.json(),
    applied,
    ...overrides,
  };
}

beforeEach(() => {
  resetCatalogueRefreshForTests();
});

describe("la règle des quinze minutes", () => {
  it("jamais lu du réseau : pas dû (la lecture du lancement est l'affaire de SWR)", () => {
    expect(catalogueRefreshDue(MOVIES_CATALOGUE_KEY, T0 + 3 * 3600_000)).toBe(false);
  });

  it("dû à quinze minutes de la dernière lecture réussie, pas avant", () => {
    noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"' }), { items: [] }, T0);
    expect(catalogueRefreshDue(MOVIES_CATALOGUE_KEY, T0 + CATALOGUE_REFRESH_AFTER_MS - 1)).toBe(false);
    expect(catalogueRefreshDue(MOVIES_CATALOGUE_KEY, T0 + CATALOGUE_REFRESH_AFTER_MS)).toBe(true);
  });

  it("une réponse identique (même étiquette) date la lecture et rend l'objet déjà tenu", () => {
    const held = noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"' }), { items: [1] }, T0);
    const later = T0 + CATALOGUE_REFRESH_AFTER_MS + 1;
    expect(catalogueUnchanged(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"' }), later)).toBe(held);
    expect(catalogueRefreshDue(MOVIES_CATALOGUE_KEY, later + 1)).toBe(false);
    expect(catalogueUnchanged(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"b"' }), later)).toBeUndefined();
  });
});

describe("la relecture", () => {
  it("envoie l'étiquette en If-None-Match ; un 304 ne pose rien et date la lecture", async () => {
    vi.useFakeTimers({ now: T0 });
    try {
      noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"' }), { items: [] });
      vi.setSystemTime(T0 + CATALOGUE_REFRESH_AFTER_MS + 5);
      const fetch = vi.fn(async () => response(304, null, { etag: 'W/"a"' }));
      const unchanged = vi.fn();
      const run = io({ fetch: fetch as unknown as typeof globalThis.fetch, unchanged });
      expect(await refreshCatalogues(run)).toEqual(["unchanged"]);
      expect(fetch).toHaveBeenCalledWith(MOVIES_CATALOGUE_KEY, { headers: { "If-None-Match": 'W/"a"' } });
      expect(run.applied).toEqual([]);
      expect(unchanged).toHaveBeenCalledTimes(1);
      expect(catalogueRefreshDue(MOVIES_CATALOGUE_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("un 200 d'une autre étiquette pose le catalogue neuf, une fois l'interface au repos", async () => {
    noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"' }), { items: [1] }, T0);
    let quiet: () => void = () => undefined;
    const fetch = vi.fn(async () => response(200, { items: [1, 2] }, { etag: 'W/"b"' }));
    const run = io({ fetch: fetch as unknown as typeof globalThis.fetch, whenQuiet: () => new Promise<void>((resolve) => (quiet = resolve)) });
    const done = refreshCatalogues(run);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    // Pas sous un geste.
    await Promise.resolve();
    expect(run.applied).toEqual([]);
    quiet();
    expect(await done).toEqual(["applied"]);
    expect(run.applied).toEqual([[MOVIES_CATALOGUE_KEY, { items: [1, 2] }]]);
  });

  it("une seule relecture en vol : un second appel rend la même promesse, sans requête de plus", async () => {
    noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"' }), { items: [] }, T0);
    noteCatalogueRead(SERIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"s"' }), { items: [] }, T0);
    let release: () => void = () => undefined;
    const inFlight: string[] = [];
    let concurrent = 0;
    const fetch = vi.fn(async (key: string) => {
      inFlight.push(key);
      concurrent = Math.max(concurrent, inFlight.length);
      await new Promise<void>((resolve) => (release = resolve));
      inFlight.splice(inFlight.indexOf(key), 1);
      return response(304, null);
    });
    const run = io({ keys: [MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY], fetch: fetch as unknown as typeof globalThis.fetch });
    const first = refreshCatalogues(run);
    const second = refreshCatalogues(run);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    release();
    expect(await first).toEqual(["unchanged", "unchanged"]);
    // Les deux catalogues l'un après l'autre : jamais deux requêtes ensemble.
    expect(concurrent).toBe(1);
  });

  it("rien ne part quand la page ne peut pas recevoir (cachée, film en cours)", async () => {
    noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"' }), { items: [] }, T0);
    const fetch = vi.fn();
    expect(await refreshCatalogues(io({ fetch, canApply: () => false }))).toEqual(["dropped"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("un film ouvert pendant la requête : la réponse n'est pas posée", async () => {
    noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"' }), { items: [] }, T0);
    let open = true;
    const fetch = vi.fn(async () => {
      open = false;
      return response(200, { items: [9] }, { etag: 'W/"b"' });
    });
    const run = io({ fetch: fetch as unknown as typeof globalThis.fetch, canApply: () => open });
    expect(await refreshCatalogues(run)).toEqual(["dropped"]);
    expect(run.applied).toEqual([]);
    // Pas datée : le retour suivant réessaie.
    expect(catalogueRefreshDue(MOVIES_CATALOGUE_KEY, T0 + CATALOGUE_REFRESH_AFTER_MS)).toBe(true);
  });

  it("une lecture de SWR aboutie pendant le vol fait foi", async () => {
    noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"' }), { items: [] }, T0);
    const fetch = vi.fn(async () => {
      noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"c"' }), { items: [3] });
      return response(200, { items: [2] }, { etag: 'W/"b"' });
    });
    const run = io({ fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await refreshCatalogues(run)).toEqual(["superseded"]);
    expect(run.applied).toEqual([]);
  });
});

describe("une copie de secours (§92) ne remplace pas un catalogue plus récent", () => {
  const date = new Date(T0).toUTCString();

  it("plus ancienne que la dernière lecture : nos titres, ses marques", () => {
    const fresh = { items: [{ id: 1 }, { id: 2 }], rows: {} };
    noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"', date }), fresh, T0);
    const kept = { items: [{ id: 1 }, { id: 2 }, { id: 3 }], rows: {}, stale: true, jellyfinDown: true, savedAt: T0 - 60_000 };
    const held = noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"x"' }), kept, T0 + 1000) as typeof kept;
    // Les titres sont ceux qu'on tenait, par référence : la grille n'a rien à redessiner.
    expect(held.items).toBe(fresh.items);
    expect(held.stale).toBe(true);
    expect(held.jellyfinDown).toBe(true);
    // La relecture de 30 s de la panne ne fabrique pas un objet neuf à chaque fois.
    const again = noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"y"' }), { ...kept, savedAt: T0 - 30_000 }, T0 + 31_000);
    expect(again).toBe(held);
  });

  it("gardée après notre lecture (un autre appareil a vu plus neuf) : elle passe telle quelle", () => {
    noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"', date }), { items: [1] }, T0);
    const kept = { items: [1, 2], stale: true, savedAt: T0 + 3600_000 };
    expect(noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"x"' }), kept, T0 + 4000_000)).toBe(kept);
  });

  it("sans lecture vraie avant elle (lancement depuis l'appareil) : elle passe, comme avant", () => {
    const kept = { items: [1], stale: true, savedAt: T0 };
    expect(reconcileCatalogue(kept, null, null, null)).toBe(kept);
  });

  it("le retour de Jellyfin remplace la copie marquée", () => {
    noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"a"', date }), { items: [1] }, T0);
    noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"x"' }), { items: [1], stale: true, savedAt: T0 - 1 }, T0 + 1);
    const back = { items: [1, 2] };
    expect(noteCatalogueRead(MOVIES_CATALOGUE_KEY, response(200, {}, { etag: 'W/"b"' }), back, T0 + 2)).toBe(back);
  });
});
