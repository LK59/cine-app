import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * La requête légère de la bannière du bureau (23/09/2026) : TMDB seul, gardé une semaine par titre
 * et par langue. Elle remplace, pour la bannière, la requête de la fiche complète, dont le plus
 * lent des six services faisait attendre le synopsis une seconde après le logo.
 */
const tmdb = { isEnabled: vi.fn(() => true), getMovie: vi.fn(), getTv: vi.fn() };
vi.mock("@/lib/clients/tmdb", () => ({ createTmdbClient: vi.fn(() => tmdb) }));
const cacheCalls: { key: string; ttl: number }[] = [];
vi.mock("@/lib/server-cache", () => ({
  withPersistentCache: async (key: string, ttl: number, fn: () => Promise<unknown>) => {
    cacheCalls.push({ key, ttl });
    return fn();
  },
}));

import { GET } from "@/app/api/cinema/hero/[type]/[tmdbId]/route";

const req = (lang = "fr") => ({ cookies: { get: (n: string) => (n === "cine-lang" ? { value: lang } : undefined) } }) as unknown as NextRequest;
const call = (type: string, tmdbId: string, lang?: string) => GET(req(lang), { params: Promise.resolve({ type, tmdbId }) });

beforeEach(() => {
  vi.clearAllMocks();
  cacheCalls.length = 0;
  tmdb.isEnabled.mockReturnValue(true);
});

describe("GET /api/cinema/hero/[type]/[tmdbId]", () => {
  it("rend le synopsis traduit et cinq noms, pour un film", async () => {
    tmdb.getMovie.mockResolvedValue({
      overview: "Un ancien Marine rentre au pays.",
      credits: { cast: Array.from({ length: 8 }, (_, i) => ({ id: i, name: `Acteur ${i}`, character: "" })) },
    });
    const res = await call("movie", "59440");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tmdb.overview).toBe("Un ancien Marine rentre au pays.");
    expect(body.tmdb.cast.map((c: { name: string }) => c.name)).toEqual(["Acteur 0", "Acteur 1", "Acteur 2", "Acteur 3", "Acteur 4"]);
    expect(tmdb.getMovie).toHaveBeenCalledWith(59440);
  });

  it("passe par la fiche TMDB de la série pour une série", async () => {
    tmdb.getTv.mockResolvedValue({ overview: "Une famille.", credits: { cast: [] } });
    const body = await (await call("series", "1399")).json();
    expect(body.tmdb.overview).toBe("Une famille.");
    expect(tmdb.getTv).toHaveBeenCalledWith(1399);
  });

  it("garde une semaine, par titre et par langue", async () => {
    tmdb.getMovie.mockResolvedValue({ overview: "x", credits: { cast: [] } });
    await call("movie", "1", "en");
    expect(cacheCalls[0].key).toMatch(/^hero:movie:1:en/);
    expect(cacheCalls[0].ttl).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("rend « pas de traduction » quand TMDB est éteint ou échoue — la bannière prend le catalogue", async () => {
    tmdb.isEnabled.mockReturnValue(false);
    expect(await (await call("movie", "1")).json()).toEqual({ tmdb: null });
    tmdb.isEnabled.mockReturnValue(true);
    tmdb.getMovie.mockRejectedValue(new Error("TMDB injoignable"));
    expect(await (await call("movie", "2")).json()).toEqual({ tmdb: null });
  });

  it.each([
    ["person", "1"],
    ["movie", "abc"],
    ["movie", "0"],
    ["movie", "-3"],
  ])("refuse %s/%s", async (type, id) => {
    expect((await call(type, id)).status).toBe(400);
    expect(tmdb.getMovie).not.toHaveBeenCalled();
  });
});
