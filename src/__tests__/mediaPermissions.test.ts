import { describe, it, expect } from "vitest";
import { canAutoSearchMovie, canAutoSearchSeason, canAutoSearchSeries } from "@/lib/mediaPermissions";

describe("canAutoSearchMovie", () => {
  it("admin always sees the button, file or not", () => {
    expect(canAutoSearchMovie(false, true)).toBe(true);
    expect(canAutoSearchMovie(false, false)).toBe(true);
  });

  it("guest sees it only when the movie has no file yet", () => {
    expect(canAutoSearchMovie(true, false)).toBe(true);
  });

  it("guest never sees it once the file exists", () => {
    expect(canAutoSearchMovie(true, true)).toBe(false);
  });
});

describe("canAutoSearchSeason", () => {
  it("admin always sees the button, complete season or not", () => {
    expect(canAutoSearchSeason(false, 10, 10)).toBe(true);
    expect(canAutoSearchSeason(false, 0, 10)).toBe(true);
  });

  it("guest sees it while at least one episode is missing", () => {
    expect(canAutoSearchSeason(true, 9, 10)).toBe(true);
    expect(canAutoSearchSeason(true, 0, 10)).toBe(true);
  });

  it("guest never sees it once every episode has a file", () => {
    expect(canAutoSearchSeason(true, 10, 10)).toBe(false);
  });

  it("guest never sees it for a season with no known episodes (nothing to search for)", () => {
    expect(canAutoSearchSeason(true, 0, 0)).toBe(false);
  });
});

describe("canAutoSearchSeries", () => {
  it("admin always sees it, complete series or not", () => {
    expect(canAutoSearchSeries(false, 60, 60)).toBe(true);
    expect(canAutoSearchSeries(false, 0, 60)).toBe(true);
  });

  it("guest sees it while at least one episode is missing", () => {
    expect(canAutoSearchSeries(true, 59, 60)).toBe(true);
  });

  it("guest never sees it once the series is complete", () => {
    expect(canAutoSearchSeries(true, 60, 60)).toBe(false);
  });

  /**
   * Une saison sans épisodes connus n'a rien à chercher ; une *série* sans épisodes connus,
   * si — c'est une série que Sonarr vient d'ajouter et n'a pas encore inventoriée.
   */
  it("guest still sees it on a series Sonarr has not inventoried yet", () => {
    expect(canAutoSearchSeries(true, 0, 0)).toBe(true);
  });
});
