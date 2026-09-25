// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { localPlayTarget, sheetOverview, sheetPlayFacts, sheetRuntimeMinutes, type ResumeFeedItem } from "@/lib/sheetFacts";
import type { CinemaNextUpItem } from "@/app/api/cinema/next-up/route";
import { prefetchLibraryItem, prefetchTitleSheet, resetTitleSheetPrefetch } from "@/lib/prefetch";
import { progressKey } from "@/lib/swr";

/**
 * Ce qu'une fiche montre avant que le réseau ait répondu (25/09/2026) — une décision, quatre
 * fiches. Ce qui compte : tout ce que l'appareil sait est dit d'emblée, et rien de ce qu'il ne sait
 * pas n'est affirmé — le bouton annonce « Reprendre » sans décider de la position.
 */

const MIN = 60 * 10_000_000;

const resume: ResumeFeedItem[] = [
  { id: "film-a", positionTicks: 30 * MIN, runtimeTicks: 120 * MIN, cinemaHref: "/radarr/1" },
  { id: "ep-7", positionTicks: 10 * MIN, runtimeTicks: 45 * MIN, cinemaHref: "/sonarr/9" },
];
const nextUp: CinemaNextUpItem[] = [
  { jellyfinItemId: "ep-3", title: "Série", thumbnailUrl: null, seasonNumber: 2, episodeNumber: 3, resumeTicks: 5 * MIN, runtimeTicks: 40 * MIN, sonarrId: 4 },
];

describe("localPlayTarget — ce que l'appareil sait déjà", () => {
  it("un film : sa ligne de « Reprendre »", () => {
    expect(localPlayTarget({ kind: "movie", jellyfinItemId: "film-a" }, resume, undefined)).toMatchObject({
      itemId: "film-a",
      resumeTicks: 30 * MIN,
      runtimeTicks: 120 * MIN,
    });
    expect(localPlayTarget({ kind: "movie", jellyfinItemId: "film-b" }, resume, undefined)).toBeNull();
  });

  it("une série : son épisode d'« À suivre », sinon celui de « Reprendre »", () => {
    expect(localPlayTarget({ kind: "series", jellyfinItemId: "s", sonarrId: 4 }, resume, nextUp)).toMatchObject({
      itemId: "ep-3",
      seasonNumber: 2,
      episodeNumber: 3,
    });
    expect(localPlayTarget({ kind: "series", jellyfinItemId: "s", sonarrId: 9 }, resume, nextUp)).toMatchObject({ itemId: "ep-7" });
    expect(localPlayTarget({ kind: "series", jellyfinItemId: "s", sonarrId: 5 }, resume, nextUp)).toBeNull();
    expect(localPlayTarget({ kind: "series", jellyfinItemId: "s", sonarrId: null }, resume, nextUp)).toBeNull();
  });

  it("ne sait rien tant que les flux ne sont pas là", () => {
    expect(localPlayTarget({ kind: "movie", jellyfinItemId: "film-a" }, undefined, undefined)).toBeNull();
  });
});

describe("sheetPlayFacts — le bouton de lecture", () => {
  const local = localPlayTarget({ kind: "movie", jellyfinItemId: "film-a" }, resume, undefined);

  it("annonce la reprise locale sans en affirmer la position", () => {
    const facts = sheetPlayFacts("Film", undefined, local);
    expect(facts).toMatchObject({ resumeTicks: 30 * MIN, runtimeTicks: 120 * MIN, hasResume: true });
    // C'est ce qui fait laisser `resumeAt` absent : le serveur tranche — CLAUDE.md.
    expect(facts.resumeKnown).toBe(false);
  });

  it("« Lire » sans rien affirmer quand l'appareil ne sait rien", () => {
    expect(sheetPlayFacts("Film", undefined, null)).toMatchObject({ hasResume: false, resumeKnown: false, targetId: null });
  });

  it("Jellyfin l'emporte dès qu'il a répondu — y compris pour dire « aucune reprise »", () => {
    const facts = sheetPlayFacts("Film", { kind: "movie", known: true, resumeTicks: 0, runtimeTicks: 120 * MIN }, local);
    expect(facts).toMatchObject({ hasResume: false, resumeKnown: true });
    const moved = sheetPlayFacts("Film", { kind: "movie", known: true, resumeTicks: 50 * MIN, runtimeTicks: 120 * MIN }, local);
    expect(moved).toMatchObject({ resumeTicks: 50 * MIN, resumeKnown: true });
  });

  it("une réponse où Jellyfin s'est tu (`known: false`) ne vaut pas « jamais commencé »", () => {
    const facts = sheetPlayFacts("Film", { kind: "movie", known: false, resumeTicks: null, runtimeTicks: null }, local);
    expect(facts).toMatchObject({ hasResume: true, resumeKnown: false });
  });

  it("une série : l'épisode du serveur, son titre et son rang, dès que la liste est là", () => {
    const localEp = localPlayTarget({ kind: "series", jellyfinItemId: "s", sonarrId: 4 }, resume, nextUp);
    const before = sheetPlayFacts("Série", undefined, localEp);
    expect(before).toMatchObject({ targetId: "ep-3", title: "Série", seasonNumber: 2, episodeNumber: 3, resumeKnown: false });
    const after = sheetPlayFacts(
      "Série",
      { kind: "series", known: true, episode: { itemId: "ep-4", title: "Épisode 4", resumeTicks: 0, seasonNumber: 2, episodeNumber: 4 } },
      localEp
    );
    expect(after).toMatchObject({ targetId: "ep-4", title: "Épisode 4", episodeNumber: 4, hasResume: false, resumeKnown: true });
    // Rien à lire : la liste l'a dit.
    expect(sheetPlayFacts("Série", { kind: "series", known: true, episode: null }, localEp)).toMatchObject({ targetId: null, resumeKnown: true });
  });
});

describe("la durée et le synopsis", () => {
  it("la durée du catalogue d'abord, TMDB seulement à défaut", () => {
    expect(sheetRuntimeMinutes(118, 121)).toBe(118);
    expect(sheetRuntimeMinutes(null, 121)).toBe(121);
    expect(sheetRuntimeMinutes(0, 0)).toBeNull();
  });

  // Le synopsis changeait de texte sous les yeux à l'arrivée de TMDB.
  it("le synopsis du catalogue ne cède jamais la place à celui de TMDB", () => {
    expect(sheetOverview("Catalogue", "TMDB")).toBe("Catalogue");
    expect(sheetOverview("", "TMDB")).toBe("TMDB");
    expect(sheetOverview("  ", null)).toBe("");
  });
});

describe("prefetchTitleSheet — l'appui sur une affiche", () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  beforeEach(() => {
    resetTitleSheetPrefetch();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const urls = () => fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));

  it("demande la description et l'état Jellyfin d'un film, une seule fois", async () => {
    prefetchTitleSheet({ kind: "movie", radarrId: 12, jellyfinItemId: "jf-12" });
    prefetchTitleSheet({ kind: "movie", radarrId: 12, jellyfinItemId: "jf-12" });
    await Promise.resolve();
    expect(urls().sort()).toEqual(["/api/radarr/movies/12/info", progressKey("jf-12")].sort());
  });

  it("une série : sa description et sa liste d'épisodes", () => {
    prefetchLibraryItem({ sonarrId: 4, jellyfinItemId: "jf-s" });
    expect(urls().sort()).toEqual(["/api/cinema/series/jf-s/episodes", "/api/sonarr/series/4/info"]);
  });

  it("rien pour une affiche hors bibliothèque", () => {
    prefetchLibraryItem({ radarrId: 3, jellyfinItemId: null });
    prefetchLibraryItem({ tmdbId: 3 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
