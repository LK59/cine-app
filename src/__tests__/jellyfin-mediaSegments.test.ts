import { describe, it, expect, vi, afterEach } from "vitest";
import { config } from "@/lib/config";
import { jellyfin, timestampsFromSegments } from "@/lib/clients/jellyfin";

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

  it("ignore les autres types de segment", () => {
    expect(timestampsFromSegments([segment("Recap", 0, 60), segment("Commercial", 600, 700)])).toEqual({});
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
