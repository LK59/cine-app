import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

/**
 * *The Arena* (05/10/2026) : Jellyfin avait identifié le dossier comme une autre série — sans
 * identifiant TVDB, un titre qui ne ressemblait plus. La série sortait du catalogue, mais la
 * recherche la disait « dans la bibliothèque », et l'ouvrir ne faisait rien.
 */
const sonarr = vi.fn();
const radarr = vi.fn();
const jfSeries = vi.fn();
const jfMovies = vi.fn();
vi.mock("@/lib/server-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-cache")>();
  return {
    ...actual,
    cachedSeries: () => sonarr(),
    cachedMovies: () => radarr(),
    cachedJellyfinSeriesAdmin: () => jfSeries(),
    cachedJellyfinMoviesAdmin: () => jfMovies(),
  };
});

import { findJellyfinSeriesByTvdb, findJellyfinMovieByTmdb, folderKey } from "@/lib/server-cache";
import { catalogueMembers } from "@/lib/catalogueMembers";
import { playableLibrary } from "@/lib/playerLibrary";

const arenaJf = { Id: "jf1", Name: "The World's Greatest Arena", ProductionYear: 2026, ProviderIds: { Tmdb: "325983" }, Path: "/media/tv/The Arena (2026)" } as JellyfinItem;
const arena = { id: 170, title: "The Arena (2026)", year: 2026, tvdbId: 482048, tmdbId: 331669, path: "/tv/The Arena (2026)", statistics: { episodeFileCount: 5 } };

beforeEach(() => {
  vi.clearAllMocks();
  radarr.mockResolvedValue([]);
  jfMovies.mockResolvedValue([]);
});

describe("le rapprochement par dossier", () => {
  it("retrouve une série que Jellyfin a mal identifiée, par le nom de son dossier", () => {
    expect(findJellyfinSeriesByTvdb([arenaJf], arena.tvdbId, arena.title, arena.year)).toBeNull();
    expect(findJellyfinSeriesByTvdb([arenaJf], arena.tvdbId, arena.title, arena.year, arena.path)?.Id).toBe("jf1");
  });

  it("ne choisit pas quand deux éléments partagent le nom du dossier", () => {
    const twin = { ...arenaJf, Id: "jf2", Path: "/autre/The Arena (2026)" } as JellyfinItem;
    expect(findJellyfinSeriesByTvdb([arenaJf, twin], 1, "Sans rapport", 1990, arena.path)).toBeNull();
  });

  it("prend le dossier qui contient le fichier d'un film", () => {
    const film = { Id: "m1", Name: "Autre chose", Path: "/media/movies/Heat (1995)/Heat.mkv" } as JellyfinItem;
    expect(findJellyfinMovieByTmdb([film], 949, "Heat", 1995, null, "/movies/Heat (1995)")?.Id).toBe("m1");
    expect(folderKey("/movies/Heat (1995)/")).toBe("heat (1995)");
  });
});

describe("ce qui est dans la bibliothèque", () => {
  it("compte une série rapprochée par son dossier", async () => {
    sonarr.mockResolvedValue([arena]);
    jfSeries.mockResolvedValue([arenaJf]);
    expect((await catalogueMembers()).series.map((s) => s.id)).toEqual([170]);
    expect((await playableLibrary()).series.get(331669)?.id).toBe(170);
  });

  it("ne donne pas d'identifiant de bibliothèque à un titre que Jellyfin n'a pas — il s'ouvrira sur sa fiche TMDB", async () => {
    sonarr.mockResolvedValue([{ ...arena, path: "/tv/Ailleurs" }]);
    jfSeries.mockResolvedValue([{ ...arenaJf, Path: "/media/tv/Autre dossier" }]);
    expect((await playableLibrary()).series.has(331669)).toBe(false);
  });

  it("garde la règle d'avant si Jellyfin ne répond pas", async () => {
    sonarr.mockResolvedValue([arena]);
    jfSeries.mockRejectedValue(new Error("Jellyfin injoignable"));
    expect((await catalogueMembers()).series.map((s) => s.id)).toEqual([170]);
  });
});
