import { describe, it, expect, vi, afterEach } from "vitest";
import { config } from "@/lib/config";
import { jellyfin, timestampsFromSegments } from "@/lib/clients/jellyfin";
import { playerMarkers } from "@/lib/episodeMarkers";

/**
 * Le générique et l'introduction, lus où Jellyfin 12 les range.
 *
 * `/Episode/{id}/Timestamps` — l'ancien greffon — répond 404 sur tous les épisodes de ce serveur :
 * ni « Passer l'intro », ni carte « Épisode suivant » avant la dernière image. Les repères vivent
 * dans `/MediaSegments/{id}` (relevé le 23/09/2026).
 */
const TICKS = 10_000_000;
const segment = (Type: string, start: number, end: number) => ({ Type, StartTicks: start * TICKS, EndTicks: end * TICKS });

describe("timestampsFromSegments", () => {
  it("ramène l'intro et le générique en secondes", () => {
    expect(timestampsFromSegments([segment("Intro", 30, 90), segment("Outro", 1500, 1560)])).toEqual({
      Introduction: { Start: 30, End: 90, Valid: true },
      Credits: { Start: 1500, End: 1560, Valid: true },
    });
  });

  it("écarte ce qui est trop court pour être un générique", () => {
    // « Intro 3 s – 3 s » existe bel et bien.
    expect(timestampsFromSegments([segment("Intro", 3, 3), segment("Outro", 1500, 1502)])).toEqual({});
  });

  it("ne prend pas pour générique de fin un segment qui commence dans la première minute", () => {
    // Vu sur une série courte : un faux générique à 3 s à côté du vrai, à 115 s.
    const t = timestampsFromSegments([segment("Outro", 3, 129), segment("Outro", 115, 129)]);
    expect(t.Credits?.Start).toBe(115);
  });

  it("lit le récap, et ignore les autres types de segment", () => {
    expect(timestampsFromSegments([segment("Recap", 0, 60), segment("Commercial", 600, 700), segment("Preview", 1500, 1530)])).toEqual({
      Recap: { Start: 0, End: 60, Valid: true },
    });
  });
});

/**
 * Les cas réels du 11/10/2026 (DECISIONS.md §65) : deux greffons écrivent leurs segments, d'où des
 * doublons ; et un faux « Outro » en milieu d'épisode faisait venir la carte « Épisode suivant »
 * des minutes trop tôt, puisqu'on prenait le premier.
 */
describe("timestampsFromSegments — doublons et faux génériques (Jellyfin de production)", () => {
  it("Shōgun S01E06 : le générique qui finit le plus tard, pas le premier", () => {
    const t = timestampsFromSegments([
      segment("Recap", 6, 61),
      segment("Recap", 6, 61),
      segment("Intro", 324, 414),
      segment("Intro", 324, 414),
      segment("Outro", 3147, 3172),
      segment("Outro", 3290, 3390),
      segment("Outro", 3290, 3390),
    ]);
    expect(t).toEqual({
      Introduction: { Start: 324, End: 414, Valid: true },
      Recap: { Start: 6, End: 61, Valid: true },
      Credits: { Start: 3290, End: 3390, Valid: true },
    });
  });

  it("Shōgun S01E07 : deux génériques qui se chevauchent n'en font qu'un, depuis le premier début", () => {
    const t = timestampsFromSegments([segment("Outro", 3159, 3271), segment("Outro", 3174, 3271)]);
    expect(t.Credits).toEqual({ Start: 3159, End: 3271, Valid: true });
  });

  it("Mentalist : ni le faux générique à 3 min, ni les cinq minutes en plein milieu", () => {
    const t = timestampsFromSegments([segment("Outro", 170, 178), segment("Outro", 914, 1231), segment("Outro", 2491, 2523.2)]);
    expect(t.Credits?.Start).toBe(2491);
  });

  it("Trying : un « Outro » de 14 s à 1386 s pour un épisode de 1727 s n'est pas le générique", () => {
    expect(timestampsFromSegments([segment("Outro", 1386.2, 1400.1), segment("Outro", 1672.1, 1726.9)]).Credits?.Start).toBe(1672.1);
  });

  it("un générique d'anime coupé d'un écran noir (moins de 20 s) reste un seul passage", () => {
    // Seven Deadly Sins : fin de chanson à 1432 s, suite à 1451 s.
    const t = timestampsFromSegments([segment("Outro", 1342, 1432.1), segment("Outro", 1451.5, 1471.6)]);
    expect(t.Credits).toEqual({ Start: 1342, End: 1471.6, Valid: true });
  });

  it("Fais pas ci, fais pas ça : le doublon d'une seconde collé au générique ne le déplace pas", () => {
    expect(timestampsFromSegments([segment("Outro", 3092.9, 3146.2), segment("Outro", 3140, 3146.2)]).Credits?.Start).toBe(3092.9);
  });

  it("Bref : le faux générique qui commence à 8 s n'entraîne pas le vrai qu'il chevauche", () => {
    expect(timestampsFromSegments([segment("Outro", 8.3, 107.8), segment("Outro", 93.4, 107.8)]).Credits?.Start).toBe(93.4);
  });

  it("l'intro : la première, doublons fusionnés", () => {
    // The Seven Deadly Sins S03E10 : deux greffons, deux débuts, une même chanson.
    const t = timestampsFromSegments([segment("Intro", 63.5, 195.2), segment("Intro", 99.9, 195.9), segment("Intro", 1200, 1260)]);
    expect(t.Introduction).toEqual({ Start: 63.5, End: 195.9, Valid: true });
  });
});

describe("playerMarkers — ce que les deux routes de lecture donnent au lecteur", () => {
  it("intro, récap et générique, ou rien", () => {
    expect(
      playerMarkers({
        Introduction: { Start: 30, End: 90, Valid: true },
        Recap: { Start: 0, End: 25, Valid: true },
        Credits: { Start: 1500, End: 1560, Valid: true },
      })
    ).toEqual({ introSkip: { start: 30, end: 90 }, recapSkip: { start: 0, end: 25 }, creditsStart: 1500 });
    expect(playerMarkers(null)).toEqual({ introSkip: null, recapSkip: null, creditsStart: null });
    expect(playerMarkers({ Introduction: { Start: 30, End: 90, Valid: false } }).introSkip).toBeNull();
  });
});

describe("jellyfin.getEpisodeTimestamps", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const json = (body: unknown, status = 200) =>
    ({
      ok: status < 400,
      status,
      statusText: String(status),
      headers: { get: () => "application/json" },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  it("lit les segments de Jellyfin 12", async () => {
    global.fetch = vi.fn().mockResolvedValue(json({ Items: [segment("Outro", 1500, 1560)] }));
    const t = await jellyfin.getEpisodeTimestamps("feedfacefeedfacefeedfacefeedface");
    expect(t?.Credits?.Start).toBe(1500);
    expect(global.fetch).toHaveBeenCalledWith(`${config.jellyfin.url}/MediaSegments/feedfacefeedfacefeedfacefeedface`, expect.anything());
  });

  it("retombe sur l'ancien greffon quand les segments manquent", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ Credits: { Start: 1400, End: 1450, Valid: true } }));
    const t = await jellyfin.getEpisodeTimestamps("feedfacefeedfacefeedfacefeedface");
    expect(t?.Credits?.Start).toBe(1400);
  });
});
