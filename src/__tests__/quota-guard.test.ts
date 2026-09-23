import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Les quotas des services externes (23/09/2026) : la vue d'ensemble de la gestion vérifiait la
 * clé OMDb toutes les quinze secondes (mille requêtes par jour en quatre heures d'onglet ouvert),
 * le contrôle d'état interrogeait MDBList chaque minute (1 440 par jour pour un quota de 1 000),
 * et un refus d'OMDb était redemandé à chaque ouverture du catalogue des séries.
 */

const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("@/lib/http", () => ({ fetchJson }));
vi.mock("@/lib/config", () => ({ config: { omdb: { apiKey: "k" } } }));

import { atMostEvery, resetQuotaGuard, HOUR_MS, FAILURE_MS } from "@/lib/quotaGuard";
import { omdb, resetOmdbPause } from "@/lib/clients/omdb";
import { spreadTtl } from "@/lib/cacheSpread";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resetQuotaGuard();
  resetOmdbPause();
});

describe("atMostEvery", () => {
  it("ne rappelle pas un service avant l'heure", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => "ok");
    await atMostEvery("k", fn);
    await atMostEvery("k", fn);
    vi.advanceTimersByTime(HOUR_MS - 1);
    await atMostEvery("k", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await atMostEvery("k", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // Un échec redemandé toutes les quinze secondes est exactement ce qui épuise un quota.
  it("garde aussi un échec, mais moins longtemps", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      throw new Error("401");
    });
    await expect(atMostEvery("k", fn)).rejects.toThrow("401");
    await expect(atMostEvery("k", fn)).rejects.toThrow("401");
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FAILURE_MS);
    await expect(atMostEvery("k", fn)).rejects.toThrow("401");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("un résultat jugé mauvais compte comme un échec", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => ({ success: false }));
    await atMostEvery("k", fn, { isOk: (r) => r.success });
    vi.advanceTimersByTime(FAILURE_MS);
    await atMostEvery("k", fn, { isOk: (r) => r.success });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("la pause d'OMDb", () => {
  it("se tait une heure après un refus, sans rappeler OMDb", async () => {
    vi.useFakeTimers();
    fetchJson.mockRejectedValueOnce(new Error("401 Request limit reached!"));
    await expect(omdb.getRating("tt1")).rejects.toThrow("limit");
    await expect(omdb.getRating("tt2")).rejects.toThrow("pause");
    expect(fetchJson).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3600_000);
    fetchJson.mockResolvedValueOnce({ Response: "True", imdbRating: "8.1", imdbVotes: "1" });
    await expect(omdb.getRating("tt3")).resolves.toMatchObject({ imdbRating: "8.1" });
  });
});

describe("spreadTtl", () => {
  it("étale les échéances sur le dernier septième, sans jamais allonger", () => {
    const week = 7 * 24 * 3600_000;
    const ttls = Array.from({ length: 200 }, (_, i) => spreadTtl(`tmdb:art:v2:movie:${i}`, week));
    expect(Math.min(...ttls)).toBeGreaterThanOrEqual(week * 0.85);
    expect(Math.max(...ttls)).toBeLessThanOrEqual(week);
    // Étalées pour de vrai : pas toutes à la même heure.
    expect(new Set(ttls.map((t) => Math.floor(t / 3600_000))).size).toBeGreaterThan(10);
  });

  it("donne toujours la même échéance à la même clé", () => {
    expect(spreadTtl("imdb:rating:series:1399", 1000)).toBe(spreadTtl("imdb:rating:series:1399", 1000));
  });
});
