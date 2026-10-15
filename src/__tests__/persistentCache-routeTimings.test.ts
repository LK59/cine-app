import { describe, it, expect } from "vitest";
import { routeTimingsOf } from "@/lib/persistentCache";

/** Une entrée de `PerformanceResourceTiming`, réduite à ce que `routeTimingsOf` lit. */
function entry(name: string, startTime: number, responseStart: number, responseEnd: number, extra: Partial<PerformanceResourceTiming> = {}) {
  return { name, startTime, responseStart, responseEnd, encodedBodySize: 0, serverTiming: [], ...extra } as unknown as PerformanceResourceTiming;
}

/**
 * Les requêtes de l'ouverture vues par le navigateur (15/10/2026) : départ, attente du premier
 * octet, travail du serveur, lecture — ce que `networkMs` seul ne séparait pas.
 */
describe("routeTimingsOf", () => {
  it("sépare le départ, l'attente, la route et la lecture, par route", () => {
    const timings = routeTimingsOf(
      [
        entry("https://cine.example/api/cinema/movies", 410.4, 1650.2, 1890.9, {
          encodedBodySize: 121_000,
          serverTiming: [{ name: "app", duration: 312.6, description: "" }] as unknown as PerformanceServerTiming[],
        }),
        entry("https://cine.example/api/jellyfin/resume", 900, 1100, 1110),
      ],
      null
    );
    expect(timings).toEqual({
      movies: { startMs: 410, waitMs: 1240, readMs: 241, appMs: 313, kB: 118 },
      resume: { startMs: 900, waitMs: 200, readMs: 10 },
    });
  });

  it("garde la première requête d'une route : c'est elle que l'ouverture attendait", () => {
    const timings = routeTimingsOf(
      [entry("/api/cinema/series", 400, 900, 950), entry("/api/cinema/series?x=1", 5000, 5100, 5120)],
      null
    );
    expect(timings.series.startMs).toBe(400);
  });

  it("écarte une requête finie après un passage en arrière-plan, et les adresses étrangères", () => {
    const timings = routeTimingsOf(
      [entry("/api/cinema/next-up", 300, 2000, 9000), entry("/api/cinema/hero/movies", 100, 200, 300), entry("/api/cinema/movies-old", 1, 2, 3)],
      4000
    );
    expect(timings).toEqual({});
  });

  it("une réponse opaque (sans premier octet connu) garde au moins son départ", () => {
    expect(routeTimingsOf([entry("/api/cinema/movies", 120, 0, 0)], null)).toEqual({ movies: { startMs: 120 } });
  });
});
