import { describe, it, expect } from "vitest";
import { isRecentlyAdded, recentlyAddedRail, top10Rail, uniqueById } from "@/lib/cinemaRails";
import { similarInLibrary } from "@/lib/cinemaSimilar";

const NOW = Date.parse("2026-09-02T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("isRecentlyAdded", () => {
  it("covers the last 30 days and nothing older", () => {
    expect(isRecentlyAdded(daysAgo(1), NOW)).toBe(true);
    expect(isRecentlyAdded(daysAgo(29), NOW)).toBe(true);
    expect(isRecentlyAdded(daysAgo(31), NOW)).toBe(false);
  });

  it("treats a missing date and Radarr's 'never' sentinel as not recent", () => {
    expect(isRecentlyAdded(null, NOW)).toBe(false);
    expect(isRecentlyAdded("0001-01-01T00:00:00Z", NOW)).toBe(false);
  });
});

describe("recentlyAddedRail", () => {
  it("orders newest first and drops undated items", () => {
    const rail = recentlyAddedRail([
      { imdbRating: null, addedAt: daysAgo(10) },
      { imdbRating: null, addedAt: null },
      { imdbRating: null, addedAt: daysAgo(2) },
      { imdbRating: null, addedAt: "0001-01-01T00:00:00Z" },
    ]);
    expect(rail.map((r) => r.addedAt)).toEqual([daysAgo(2), daysAgo(10)]);
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ imdbRating: null, addedAt: daysAgo(i) }));
    expect(recentlyAddedRail(many)).toHaveLength(20);
    expect(recentlyAddedRail(many, 5)).toHaveLength(5);
  });
});

describe("top10Rail", () => {
  it("ranks by rating, caps at ten, and leaves unrated titles out", () => {
    const items = [
      { imdbRating: "7.0", addedAt: daysAgo(1) },
      { imdbRating: null, addedAt: daysAgo(1) },
      { imdbRating: "9.1", addedAt: daysAgo(1) },
      { imdbRating: "8.0", addedAt: daysAgo(1) },
    ];
    expect(top10Rail(items).map((i) => i.imdbRating)).toEqual(["9.1", "8.0", "7.0"]);

    const twelve = Array.from({ length: 12 }, (_, i) => ({ imdbRating: String(9 - i * 0.1), addedAt: daysAgo(1) }));
    expect(top10Rail(twelve)).toHaveLength(10);
  });

  it("breaks a rating tie with the most recently added", () => {
    const rail = top10Rail([
      { imdbRating: "8.0", addedAt: daysAgo(20) },
      { imdbRating: "8.0", addedAt: daysAgo(2) },
    ]);
    expect(rail[0].addedAt).toBe(daysAgo(2));
  });
});

describe("uniqueById", () => {
  it("de-duplicates the same title appearing under several genres", () => {
    const a = { id: 1 };
    const b = { id: 2 };
    expect(uniqueById([a, b, a], (x) => x.id)).toEqual([a, b]);
  });
});

describe("similarInLibrary", () => {
  const subject = { genres: ["Action", "Thriller"], year: 2014, imdbRating: "7.4" };
  const library = [
    { id: 1, genres: ["Action", "Thriller"], year: 2015, imdbRating: "8.1" },
    { id: 2, genres: ["Action"], year: 2019, imdbRating: "9.0" },
    { id: 3, genres: ["Romance"], year: 2010, imdbRating: "9.9" },
    { id: 99, genres: ["Action", "Thriller"], year: 2014, imdbRating: "7.4" },
  ];

  it("ranks by shared genres first, then rating, and excludes the subject itself", () => {
    const out = similarInLibrary(subject, library, (c) => c.id === 99);
    expect(out.map((o) => o.id)).toEqual([1, 2]);
  });

  it("returns nothing when the subject has no genres", () => {
    expect(similarInLibrary({ genres: [], year: 2000, imdbRating: null }, library, () => false)).toEqual([]);
  });

  it("respects the limit", () => {
    expect(similarInLibrary(subject, library, () => false, 1)).toHaveLength(1);
  });
});
