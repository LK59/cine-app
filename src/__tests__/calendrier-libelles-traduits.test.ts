import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";

// La route du calendrier écrivait ses libellés en français (« Au cinéma », « Bientôt »,
// « Sortie digitale », « Sortie physique », « Série ») et l'écran les affichait tels quels :
// un compte en anglais, espagnol ou allemand lisait du français sous chaque titre. La route
// renvoie désormais un code, et l'écran le traduit.

const mockRadarr = { getCalendar: vi.fn() };
const mockSonarr = { getCalendar: vi.fn() };
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: mockSonarr }));
vi.mock("@/lib/config", () => ({ config: { tmdb: { apiKey: "key" } } }));
vi.mock("@/lib/images", () => ({ posterUrl: () => null }));
vi.mock("@/lib/server-cache", () => ({
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  TTL: { SHORT: 60_000 },
}));

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => ({
      results: String(url).includes("now_playing")
        ? [{ id: 7, title: "En salle", release_date: "2026-10-02", poster_path: null }]
        : [{ id: 8, title: "Prochain", release_date: "2026-10-09", poster_path: null }],
    }),
  })) as unknown as typeof fetch;
  mockRadarr.getCalendar.mockResolvedValue([
    { id: 1, tmdbId: 1, title: "Salle", inCinemas: "2026-10-01T00:00:00Z", images: [] },
    { id: 2, tmdbId: 2, title: "Numérique", digitalRelease: "2026-10-03T00:00:00Z", images: [] },
    { id: 3, tmdbId: 3, title: "Disque", physicalRelease: "2026-10-04T00:00:00Z", images: [] },
  ]);
  mockSonarr.getCalendar.mockResolvedValue([
    { id: 5, seriesId: 10, airDate: "2026-10-05", seasonNumber: 1, episodeNumber: 2, title: "Pilot", series: null },
  ]);
});

async function events() {
  const { GET } = await import("@/app/api/calendar/route");
  const res = await GET({ nextUrl: { searchParams: new URLSearchParams() } } as unknown as NextRequest);
  return (await res.json()).events as import("@/app/api/calendar/route").CalendarEvent[];
}

describe("calendrier : la route renvoie un code, l'écran le traduit", () => {
  it("la réponse ne contient plus aucun libellé français", async () => {
    const body = JSON.stringify(await events());
    for (const label of ["Au cinéma", "Bientôt", "Sortie digitale", "Sortie physique", "Série"]) {
      expect(body).not.toContain(label);
    }
  });

  it("chaque film porte le genre de sa sortie", async () => {
    const byId = Object.fromEntries((await events()).map((e) => [e.id, e.release]));
    expect(byId).toMatchObject({
      "radarr-1": "cinema", "radarr-2": "digital", "radarr-3": "physical",
      "tmdb-now_playing-7": "cinema", "tmdb-upcoming-8": "soon",
    });
  });

  it("en anglais, l'écran affiche les libellés anglais", async () => {
    const { calendarEventTitle, calendarEventDetail } = await import("@/lib/calendarLabels");
    const t = createT(en, fr, "en");
    const evs = await events();
    const detail = (id: string) => calendarEventDetail(evs.find((e) => e.id === id)!, t);
    expect(detail("radarr-1")).toBe("In cinemas");
    expect(detail("radarr-2")).toBe("Digital release");
    expect(detail("radarr-3")).toBe("Physical release");
    expect(detail("tmdb-upcoming-8")).toBe("Coming soon");
    // L'épisode garde son numéro et son titre, qui ne sont pas des libellés.
    expect(detail("sonarr-5")).toBe("S01E02 · Pilot");
    expect(calendarEventTitle(evs.find((e) => e.id === "sonarr-5")!, t)).toBe("Series");
    expect(calendarEventTitle(evs.find((e) => e.id === "radarr-2")!, t)).toBe("Numérique");
  });

  it("les clés existent dans les quatre langues", () => {
    for (const dict of [fr, en, es, de] as Record<string, any>[]) {
      for (const k of ["cinema", "soon", "digital", "physical"]) {
        expect(typeof dict.calendar.release[k]).toBe("string");
      }
    }
  });
});
