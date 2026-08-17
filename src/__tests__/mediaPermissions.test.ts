import { describe, it, expect } from "vitest";
import { canAutoSearchMovie, canAutoSearchSeason } from "@/lib/mediaPermissions";

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
