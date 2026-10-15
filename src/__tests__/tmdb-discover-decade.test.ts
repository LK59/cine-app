import { describe, it, expect, vi } from "vitest";

// La découverte TMDB bornée à une décennie (DECISIONS.md §99) : c'est l'adresse qui fait le filtre.
const mockFetchJson = vi.fn((..._args: unknown[]) => Promise.resolve({ results: [] }));
vi.mock("@/lib/http", () => ({ fetchJson: (...args: unknown[]) => mockFetchJson(...args) }));
vi.mock("@/lib/config", () => ({ config: { tmdb: { apiKey: "k" } } }));

describe("tmdb.discover — décennie", () => {
  it("un film : date de sortie dans [1980-01-01, 1989-12-31] ; une série : première diffusion", async () => {
    const { createTmdbClient } = await import("@/lib/clients/tmdb");
    const client = createTmdbClient("en-US");
    await client.discover({ mediaType: "movie", genreId: 27, decade: 1980 });
    await client.discover({ mediaType: "tv", decade: 1990 });
    await client.discover({ mediaType: "movie", genreId: 27 });
    const [movieUrl, tvUrl, plainUrl] = mockFetchJson.mock.calls.map(([u]) => new URL(String(u)));
    expect(movieUrl.searchParams.get("primary_release_date.gte")).toBe("1980-01-01");
    expect(movieUrl.searchParams.get("primary_release_date.lte")).toBe("1989-12-31");
    expect(tvUrl.searchParams.get("first_air_date.gte")).toBe("1990-01-01");
    expect(tvUrl.searchParams.get("first_air_date.lte")).toBe("1999-12-31");
    expect([...plainUrl.searchParams.keys()].some((k) => k.includes("date"))).toBe(false);
  });
});
