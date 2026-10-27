import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

/**
 * Une installation « Jellyfin seulement » (14/10/2026, DECISIONS.md §89) : ni Radarr ni Sonarr
 * configurés. Avant, `cachedSeries()` partait vers l'adresse par défaut sans clé, levait, et la route du
 * catalogue répondait 500 — aucune série. La règle : **non configuré = liste vide**, sans rien demander,
 * et tout ce que Jellyfin a devient « Jellyfin seul ». Configuré mais en panne reste une panne (testé
 * dans `jellyfin-seul.test.ts`, « Radarr muet »).
 *
 * Aucune clé Radarr/Sonarr dans l'environnement de la suite : `serviceConfigured` répond non, et les
 * vraies `cachedMovies` / `cachedSeries` sont exercées ici.
 */

const arrCalls = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/clients/radarr", () => ({
  radarr: new Proxy({}, { get: (_t, name) => async () => { arrCalls.push(`radarr.${String(name)}`); throw new Error("Radarr ne doit pas être interrogé"); } }),
}));
vi.mock("@/lib/clients/sonarr", () => ({
  sonarr: new Proxy({}, { get: (_t, name) => async () => { arrCalls.push(`sonarr.${String(name)}`); throw new Error("Sonarr ne doit pas être interrogé"); } }),
}));

const jf = (Id: string, Name: string, Path: string, ProviderIds: Record<string, string> = {}) =>
  ({ Id, Name, Path, ProviderIds, DateCreated: "2026-10-01T00:00:00Z", Genres: ["Drama"] }) as JellyfinItem;

vi.mock("@/lib/server-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server-cache")>()),
  cachedJellyfinMoviesAdmin: async () => [jf("m-1", "Le Samouraï", "/media/movies/Le Samouraï (1967)/f.mkv", { Tmdb: "5511" }), jf("m-2", "Film de famille", "/media/movies/Famille/f.mkv")],
  cachedJellyfinSeriesAdmin: async () => [jf("s-1", "La casa de papel", "/media/tv/La Casa de Papel", { Tmdb: "71446" }), jf("s-vide", "Vide", "/media/tv/Vide")],
  cachedJellyfinEpisodeCount: async (id: string) => (id === "s-1" ? 41 : 0),
  cachedJellyfinFirstEpisodes: async () => [],
  cachedJellyfinSeasons: async () => [],
  cachedJellyfinRecentEpisodes: async () => [],
  cachedJellyfinPlayedAmong: async () => new Set<string>(),
}));
vi.mock("@/lib/title-art", () => ({ getTitleArt: async () => ({ posterByLang: {}, posterTextlessUrl: null }), logoForLocale: () => null, logoForScreen: () => null }));
vi.mock("@/lib/imdb-rating", () => ({ getImdbRating: async () => null }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => null }));

import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { catalogueMembers } from "@/lib/catalogueMembers";
import { serviceConfigured } from "@/lib/serviceConfigured";

beforeEach(() => {
  arrCalls.length = 0;
});

describe("une installation sans Radarr ni Sonarr", () => {
  it("n'est pas une panne : les listes sont vides, et personne n'est interrogé", async () => {
    expect(serviceConfigured("radarr")).toBe(false);
    expect(serviceConfigured("sonarr")).toBe(false);
    await expect(cachedMovies()).resolves.toEqual([]);
    await expect(cachedSeries()).resolves.toEqual([]);
    expect(arrCalls).toEqual([]);
  });

  it("tout ce que Jellyfin a devient « Jellyfin seul » — une série sans épisode reste dehors", async () => {
    const { jellyfinOnly, movies, series, byJellyfinId } = await catalogueMembers();
    expect(movies).toEqual([]);
    expect(series).toEqual([]);
    expect(jellyfinOnly.movies.map((t) => t.item.Id).sort()).toEqual(["m-1", "m-2"]);
    expect(jellyfinOnly.series.map((t) => t.item.Id)).toEqual(["s-1"]);
    expect(byJellyfinId.get("m-1")).toMatchObject({ type: "movie", source: "jellyfin", tmdbId: 5511 });
  });

  it("le catalogue des films et des séries s'ouvre", async () => {
    const req = () => new Request("https://cine.example/api/cinema/x");
    const movies = await (await import("@/app/api/cinema/movies/route")).GET(req());
    expect(movies.status).toBe(200);
    const m = await movies.json();
    expect(m.items.map((i: { jellyfinItemId: string }) => i.jellyfinItemId).sort()).toEqual(["m-1", "m-2"]);
    const series = await (await import("@/app/api/cinema/series/route")).GET(req());
    expect(series.status).toBe(200);
    const s = await series.json();
    expect(s.items.map((i: { jellyfinItemId: string; source?: string }) => [i.jellyfinItemId, i.source])).toEqual([["s-1", "jellyfin"]]);
    expect(arrCalls).toEqual([]);
  });

  it("le calendrier garde ses sorties TMDB sans rien demander à Radarr ni Sonarr", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
    const { GET } = await import("@/app/api/calendar/route");
    const url = new URL("https://cine.example/api/calendar?start=2026-10-01&end=2026-10-31");
    const res = await GET({ nextUrl: url } as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(arrCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("les historiques de la gestion sont vides, sans appel", async () => {
    const { GET } = await import("@/app/api/timeline/imports/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(arrCalls).toEqual([]);
  });
});
