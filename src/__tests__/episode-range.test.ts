import { describe, expect, it } from "vitest";
import { arrangeEpisodes, episodeNumberLabel, episodeTitles } from "@/lib/episodeDisplay";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

// Une série rangée en compilations (« S01E01-E04 ») se lisait « 1, 5, 9… » dans la liste (19/11/2026).
describe("fichiers multi-épisodes", () => {
  const item = (n: number, end: number | undefined, name: string) =>
    ({ Id: `e${n}`, Name: name, ParentIndexNumber: 1, IndexNumber: n, ...(end ? { IndexNumberEnd: end } : {}), Path: `/media/tv/S/S01E${String(n).padStart(2, "0")}.mkv` }) as JellyfinItem;

  it("porte la fin de plage et l'affiche « 1–4 »", () => {
    const [a, b] = arrangeEpisodes([item(1, 4, "Un / Deux / Trois / Quatre"), item(5, undefined, "Cinq")], "S", "fr");
    expect(a.episodeNumberEnd).toBe(4);
    expect(episodeNumberLabel(a)).toBe("1–4");
    expect(episodeTitles(a)).toEqual(["Un", "Deux", "Trois", "Quatre"]);
    expect(b.episodeNumberEnd).toBeUndefined();
    expect(episodeNumberLabel(b)).toBe("5");
    expect(episodeTitles(b)).toEqual(["Cinq"]);
  });

  it("ignore une fin qui n'est pas après le début", () => {
    const [a] = arrangeEpisodes([item(3, 3, "Trois")], "S", "fr");
    expect(a.episodeNumberEnd).toBeUndefined();
    expect(episodeNumberLabel({ episodeNumber: 3, episodeNumberEnd: 2 })).toBe("3");
  });

  it("garde un titre à barre oblique d'un épisode seul", () => {
    expect(episodeTitles({ title: "Avant / Après" })).toEqual(["Avant / Après"]);
  });
});
