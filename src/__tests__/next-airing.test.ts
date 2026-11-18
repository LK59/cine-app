import { describe, it, expect } from "vitest";
import { nextAiring, nextAiringWhen } from "@/lib/nextAiring";
import type { MissingSeason } from "@/app/api/player/series/[sonarrId]/missing/route";

/** « Prochain épisode jeudi » (18/11/2026) : le premier épisode pas encore diffusé, à date annoncée. */
const ep = (s: number, e: number, airDate: string | null, released: boolean) =>
  ({ id: s * 100 + e, seasonNumber: s, episodeNumber: e, title: "", airDate, released, downloading: null }) as MissingSeason["episodes"][number];
const NOW = new Date(2026, 10, 18, 14, 0).getTime(); // mercredi 18/11/2026, 14 h

describe("nextAiring", () => {
  it("le plus proche à venir ; ni un diffusé pas encore arrivé, ni une date absente ou passée", () => {
    const seasons: MissingSeason[] = [
      { seasonNumber: 3, requestable: true, episodes: [ep(3, 5, "2026-11-17T08:00:00Z", true), ep(3, 7, "2026-12-02T08:00:00Z", false), ep(3, 6, "2026-11-25T08:00:00Z", false)] },
      { seasonNumber: 4, requestable: false, episodes: [ep(4, 1, null, false)] },
    ];
    expect(nextAiring(seasons, NOW)).toMatchObject({ seasonNumber: 3, episodeNumber: 6 });
    expect(nextAiring([{ seasonNumber: 4, requestable: false, episodes: [ep(4, 1, null, false)] }], NOW)).toBeNull();
    expect(nextAiring([], NOW)).toBeNull();
  });
});

describe("nextAiringWhen", () => {
  const at = (d: number) => new Date(2026, 10, 18 + d, 9, 0).getTime();
  it("aujourd'hui, demain, le jour dans la semaine, sinon la date", () => {
    expect(nextAiringWhen(at(0), NOW, "fr")).toEqual({ kind: "today" });
    expect(nextAiringWhen(at(1), NOW, "fr")).toEqual({ kind: "tomorrow" });
    expect(nextAiringWhen(at(1) - 10 * 3600_000, NOW, "fr")).toEqual({ kind: "today" });
    expect(nextAiringWhen(at(2), NOW, "fr")).toEqual({ kind: "weekday", text: "vendredi" });
    expect(nextAiringWhen(at(14), NOW, "fr")).toEqual({ kind: "date", text: "2 décembre" });
    expect(nextAiringWhen(new Date(2027, 0, 5).getTime(), NOW, "fr")).toEqual({ kind: "date", text: "5 janvier 2027" });
  });
});
