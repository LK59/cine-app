// Les titres réservés (tag « prive », DECISIONS.md §54) restent cachés à la recherche, à la découverte
// et aux fiches quand Jellyfin est injoignable après un redémarrage de cine-app (§92, relecture du
// 14/10/2026) : `hiddenTmdbKeysFor` lisait les listes Jellyfin de l'administrateur, et sans elles
// rendait un ensemble vide — le titre réapparaissait. Il garde désormais sur disque l'index des titres
// étiquetés et n'attend pas un hôte figé plus de 1,5 s. Un tag que l'index ne connaît pas ne cache
// rien de plus (choix de Louis, 14/10/2026 : le catalogue d'abord — la première règle cachait toute la
// bibliothèque).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jellyfin.test:8096", apiKey: "k" }, accounts: { newBlockedTags: "prive" } } }));
const lists = vi.hoisted(() => ({
  movies: (): Promise<unknown[]> => Promise.resolve([]),
  series: (): Promise<unknown[]> => Promise.resolve([]),
}));
vi.mock("@/lib/server-cache", () => ({
  cachedJellyfinMoviesAdmin: () => lists.movies(),
  cachedJellyfinSeriesAdmin: () => lists.series(),
}));
vi.mock("@/lib/sonarrLink", () => ({ catalogueLinks: async () => new Map() }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => null }));

import { forgetBlockedTags, forgetTaggedIndex, hiddenTmdbKeysFor } from "@/lib/blockedTags";
import { kvCacheDb } from "@/lib/db";

const restricted = "a".repeat(32);
const open = "b".repeat(32);
const fresh = "c".repeat(32);
const secret = "d".repeat(32);

const policies: Record<string, string[]> = { [restricted]: ["Prive"], [open]: [], [secret]: ["Secret"] };
const userResponse = (url: string) => {
  const id = Object.keys(policies).find((k) => url.includes(k));
  return new Response(JSON.stringify({ Policy: { BlockedTags: id ? policies[id] : [] } }), { status: 200, headers: { "content-type": "application/json" } });
};
const down = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));

const library = [
  { Id: "jf-1", Tags: ["Prive", "murder"], ProviderIds: { Tmdb: "100" } },
  { Id: "jf-2", Tags: ["murder"], ProviderIds: { Tmdb: "200" } },
];

let now = Date.now();
beforeEach(() => {
  now += 10 * 60_000; // au-delà des deux minutes des tags gardés en mémoire
  forgetBlockedTags();
  forgetTaggedIndex();
});
afterEach(() => vi.unstubAllGlobals());

function jellyfinUp() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => userResponse(String(url))));
  lists.movies = async () => library;
  lists.series = async () => [];
}
function jellyfinDown() {
  vi.stubGlobal("fetch", vi.fn(down));
  lists.movies = down;
  lists.series = down;
}

describe("hiddenTmdbKeysFor — redémarrage pendant une panne de Jellyfin", () => {
  it("Jellyfin vivant : le titre « prive » caché au compte restreint, pas au compte sans blocage", async () => {
    jellyfinUp();
    expect([...(await hiddenTmdbKeysFor(restricted, now))]).toEqual(["movie:100"]);
    expect((await hiddenTmdbKeysFor(open, now)).size).toBe(0);
    // L'index gardé ne retient que les tags bloqués de quelqu'un, pas les mots-clés de TMDB.
    const disk = kvCacheDb.get("blocked-tags:tmdb-index")?.value as { tags: Record<string, string[]> };
    expect(disk.tags).toEqual({ prive: ["movie:100"] });
  });

  it("redémarré, Jellyfin injoignable : toujours caché au compte restreint, visible au compte sans blocage", async () => {
    jellyfinDown();
    expect([...(await hiddenTmdbKeysFor(restricted, now))]).toEqual(["movie:100"]);
    expect((await hiddenTmdbKeysFor(open, now)).size).toBe(0);
  });

  it("un compte jamais vu : les tags posés d'office, couverts par l'index", async () => {
    jellyfinDown();
    expect([...(await hiddenTmdbKeysFor(fresh, now))]).toEqual(["movie:100"]);
  });

  it("un tag que l'index ne connaît pas : rien de plus n'est caché, la bibliothèque reste visible", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => userResponse(String(url))));
    lists.movies = down;
    lists.series = down;
    expect((await hiddenTmdbKeysFor(secret, now)).size).toBe(0);
  });

  it("aucun index sur disque : rien de caché, ni au compte restreint ni au compte libre", async () => {
    kvCacheDb.set("blocked-tags:tmdb-index", null, now);
    forgetTaggedIndex();
    jellyfinDown();
    expect((await hiddenTmdbKeysFor(restricted, now)).size).toBe(0);
    expect((await hiddenTmdbKeysFor(open, now)).size).toBe(0);
  });

  it("un compte restreint garde son titre réservé caché quand l'index le connaît, et lui seul", async () => {
    jellyfinUp();
    await hiddenTmdbKeysFor(restricted, now);
    forgetBlockedTags();
    forgetTaggedIndex();
    jellyfinDown();
    expect([...(await hiddenTmdbKeysFor(restricted, now + 10 * 60_000))]).toEqual(["movie:100"]);
  });

  it("un hôte figé : la réponse vient de l'index en ~1,5 s, pas après les délais de Jellyfin", async () => {
    jellyfinUp();
    await hiddenTmdbKeysFor(restricted, now); // l'index se refait
    forgetBlockedTags();
    forgetTaggedIndex();
    const hang = () => new Promise<never>(() => {});
    vi.stubGlobal("fetch", vi.fn(hang));
    lists.movies = hang;
    lists.series = hang;
    const started = Date.now();
    expect([...(await hiddenTmdbKeysFor(restricted, now + 10 * 60_000))]).toEqual(["movie:100"]);
    expect(Date.now() - started).toBeLessThan(2500);
  });
});
