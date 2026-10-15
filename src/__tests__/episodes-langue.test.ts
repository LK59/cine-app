import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

/**
 * Les épisodes dans la langue du compte (15/10/2026, passe de nuit, BUREAU-15, DECISIONS.md §100) :
 * un compte en anglais lisait *Chernobyl* « 2. Veuillez garder votre calme » sous « Season 1 ».
 */

const { seasons, tmdbCalls, serverConfig } = vi.hoisted(() => ({
  seasons: new Map<string, unknown>(),
  tmdbCalls: [] as string[],
  serverConfig: { value: { PreferredMetadataLanguage: "fr", MetadataCountryCode: "FR" } as Record<string, unknown> | Error },
}));
vi.mock("@/lib/clients/tmdb", async () => {
  const { HttpError } = await import("@/lib/http");
  return {
    createTmdbClient: (lang: string) => ({
      getTvSeason: vi.fn(async (id: number, s: number) => {
        tmdbCalls.push(`${lang}:${id}:${s}`);
        const data = seasons.get(`${lang}:${id}:${s}`);
        if (!data) throw new HttpError("404 Not Found", 404);
        return data;
      }),
    }),
  };
});

const mockEpisodes = vi.fn();
const mockLinks = vi.fn();
vi.mock("@/lib/server-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server-cache")>()),
  // Rien de gardé d'un test à l'autre : ni les saisons, ni la langue de la bibliothèque.
  withCache: async (_key: string, _t: number, fn: () => Promise<unknown>) => fn(),
  withPersistentCache: async (_key: string, _t: number, fn: () => Promise<unknown>) => fn(),
  cachedItemProviderIds: async () => ({ ProviderIds: { Tmdb: "87108" } }),
  cachedSeries: async () => [{ id: 7, tvdbId: 360893, tmdbId: 87108, title: "Chernobyl" }],
  cachedSonarrEpisodeTexts: async () => [],
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => ({ jfId: "u1" }) }));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getSeriesEpisodes: (...a: unknown[]) => mockEpisodes(...a),
    getNextUp: async () => null,
    getServerConfiguration: async () => {
      if (serverConfig.value instanceof Error) throw serverConfig.value;
      return serverConfig.value;
    },
  },
}));
vi.mock("@/lib/sonarrLink", () => ({ catalogueLinks: () => mockLinks() }));

const SERIES = "0123456789abcdef0123456789abcdef";
const params = { params: Promise.resolve({ jellyfinId: SERIES }) };
const reqIn = (lang: string) =>
  ({
    cookies: { get: () => ({ value: "t" }) },
    headers: { get: (name: string) => (name === "cookie" ? `cine-lang=${lang}` : null) },
  }) as unknown as NextRequest;

const item = (Id: string, Name: string, episode: number, Overview?: string) =>
  ({ Id, Name, Path: `/m/Chernobyl - S01E0${episode}.mkv`, ParentIndexNumber: 1, IndexNumber: episode, SeriesName: "Chernobyl", Overview }) as JellyfinItem;

const JELLYFIN_FR = [
  item("e1", "1:23:45", 1, "Le 26 avril 1986, une explosion retentit."),
  item("e2", "Veuillez garder votre calme", 2, "Ulana Khomyuk enquête."),
  item("e3", "Que la terre s'ouvre !", 3, "Les mineurs arrivent."),
];
const TMDB_FR = {
  episodes: [
    { episode_number: 1, name: "1:23:45", overview: "Le 26 avril 1986…" },
    { episode_number: 2, name: "Veuillez garder votre calme", overview: "Ulana…" },
    { episode_number: 3, name: "Que la terre s'ouvre !", overview: "Les mineurs…" },
  ],
};
const TMDB_EN = {
  episodes: [
    { episode_number: 1, name: "1:23:45", overview: "On April 26, 1986, an explosion." },
    { episode_number: 2, name: "Please Remain Calm", overview: "Ulana Khomyuk investigates." },
    // Pas encore traduit en anglais : le repli de Jellyfin.
    { episode_number: 3, name: "Episode 3", overview: "" },
  ],
};

async function titlesFor(lang: string) {
  const { GET } = await import("@/app/api/cinema/series/[jellyfinId]/episodes/route");
  const body = await (await GET(reqIn(lang), params)).json();
  return body.seasons[0].episodes.map((e: { title: string; overview: string | null }) => [e.title, e.overview]);
}

beforeEach(() => {
  vi.clearAllMocks();
  seasons.clear();
  tmdbCalls.length = 0;
  serverConfig.value = { PreferredMetadataLanguage: "fr", MetadataCountryCode: "FR" };
  mockLinks.mockResolvedValue(new Map([[SERIES, { type: "series", catalogueId: 7, tmdbId: 87108, source: "sonarr" }]]));
  mockEpisodes.mockResolvedValue(JELLYFIN_FR.map((i) => ({ ...i })));
  seasons.set("fr-FR:87108:1", TMDB_FR);
  seasons.set("en-US:87108:1", TMDB_EN);
});

describe("GET /api/cinema/series/[id]/episodes — la langue du compte", () => {
  it("compte en anglais : titres et résumés de TMDB en anglais, Jellyfin là où TMDB n'a rien", async () => {
    expect(await titlesFor("en")).toEqual([
      ["1:23:45", "On April 26, 1986, an explosion."],
      ["Please Remain Calm", "Ulana Khomyuk investigates."],
      ["Que la terre s'ouvre !", "Les mineurs arrivent."],
    ]);
    // Une requête par saison et par langue, pas une par épisode.
    expect(tmdbCalls.sort()).toEqual(["en-US:87108:1", "fr-FR:87108:1"]);
  });

  it("compte dans la langue de la bibliothèque : le texte de Jellyfin, sans un appel de plus", async () => {
    expect(await titlesFor("fr")).toEqual(JELLYFIN_FR.map((i) => [i.Name, i.Overview]));
    expect(tmdbCalls).toEqual([]);
  });

  it("numérotation différente chez TMDB (ses titres ne sont pas ceux du disque) : rien n'est traduit", async () => {
    seasons.set("fr-FR:87108:1", { episodes: [{ episode_number: 1, name: "Autre chose" }, { episode_number: 2, name: "Encore autre" }, { episode_number: 3, name: "Rien à voir" }] });
    expect(await titlesFor("de")).toEqual(JELLYFIN_FR.map((i) => [i.Name, i.Overview]));
  });

  it("langue de la bibliothèque inconnue (Jellyfin muet) : rien n'est traduit", async () => {
    serverConfig.value = new Error("panne");
    expect(await titlesFor("es")).toEqual(JELLYFIN_FR.map((i) => [i.Name, i.Overview]));
  });
});
