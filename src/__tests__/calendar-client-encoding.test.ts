import { describe, it, expect, vi, beforeEach } from "vitest";

// Les bornes du calendrier venaient telles quelles de la requête du navigateur et étaient
// collées dans l'URL de l'appel fait avec la clé d'API : un `&` y ajoutait n'importe quel
// paramètre (26/09/2026). Les dates ordinaires, elles, doivent arriver identiques.

vi.mock("@/lib/config", () => ({
  config: {
    radarr: { url: "http://radarr.local", apiKey: "k" },
    sonarr: { url: "http://sonarr.local", apiKey: "k" },
  },
}));
const mockFetchJson = vi.fn(async (..._args: unknown[]) => []);
vi.mock("@/lib/http", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
  HttpError: class extends Error {},
}));

beforeEach(() => mockFetchJson.mockClear());

describe("getCalendar de Radarr et Sonarr", () => {
  it("encode les bornes : un `&` ne devient pas un paramètre", async () => {
    const { radarr } = await import("@/lib/clients/radarr");
    const { sonarr } = await import("@/lib/clients/sonarr");
    await radarr.getCalendar("2026-01-01&unmonitored=false", "2026-02-01");
    await sonarr.getCalendar("2026-01-01", "2026-02-01&includeSeries=false");
    for (const [url] of mockFetchJson.mock.calls) {
      const params = new URL(String(url)).searchParams;
      expect(params.getAll("unmonitored")).toEqual(["true"]);
      expect(params.getAll("includeSeries").length).toBeLessThanOrEqual(1);
    }
    expect(new URL(String(mockFetchJson.mock.calls[0][0])).searchParams.get("start")).toBe("2026-01-01&unmonitored=false");
  });

  it("laisse les dates réelles lisibles à l'identique par l'amont", async () => {
    const { radarr } = await import("@/lib/clients/radarr");
    await radarr.getCalendar("2026-09-01T00:00:00.000Z", "2026-10-01");
    const params = new URL(String(mockFetchJson.mock.calls[0][0])).searchParams;
    expect(params.get("start")).toBe("2026-09-01T00:00:00.000Z");
    expect(params.get("end")).toBe("2026-10-01");
  });
});
