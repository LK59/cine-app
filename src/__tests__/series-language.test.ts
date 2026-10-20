import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { EMPTY_SERIES_LANGUAGE, nextSeriesLanguage, recordSeriesLanguageChoice, seriesPreferredLanguage } from "@/lib/seriesLanguage";
import { getDb } from "@/lib/db";

// La langue du son retenue par série (20/10/2026, règle de Louis) : deux épisodes différents passés
// à la main vers la même langue la retiennent ; deux vers une autre la remplacent.

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockUserData = vi.fn();
const mockUserConfig = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getItemUserData: (...a: unknown[]) => mockUserData(...a),
    getUserConfiguration: (...a: unknown[]) => mockUserConfig(...a),
  },
}));

const EP1 = "a".repeat(32);
const EP2 = "b".repeat(32);
const EP3 = "c".repeat(32);
const SERIES = "s".repeat(31) + "1";

function req(body?: unknown): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" ? { value: "t" } : undefined) },
    json: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  getDb().prepare("DELETE FROM series_audio_language").run();
  mockVerifySessionFull.mockResolvedValue({ u: "augustine", jfId: "jf-1", jfToken: "jt" });
  mockUserData.mockResolvedValue({ Type: "Episode", SeriesId: SERIES, UserData: { PlaybackPositionTicks: 0 } });
  mockUserConfig.mockResolvedValue({ Configuration: { AudioLanguagePreference: "eng", PlayDefaultAudioTrack: false } });
});

describe("la règle", () => {
  it("un seul épisode ne retient rien", () => {
    const s = nextSeriesLanguage(EMPTY_SERIES_LANGUAGE, EP1, "fra");
    expect(s).toEqual({ preferred: null, candidate: "fra", candidateEpisodes: [EP1] });
  });

  it("deux changements dans le même épisode comptent pour un", () => {
    const s = nextSeriesLanguage(nextSeriesLanguage(EMPTY_SERIES_LANGUAGE, EP1, "fra"), EP1, "fra");
    expect(s.preferred).toBeNull();
  });

  it("deux épisodes différents vers la même langue la retiennent", () => {
    const s = nextSeriesLanguage(nextSeriesLanguage(EMPTY_SERIES_LANGUAGE, EP1, "fra"), EP2, "fra");
    expect(s).toEqual({ preferred: "fra", candidate: null, candidateEpisodes: [] });
  });

  it("un changement vers une autre langue entre deux repart de zéro", () => {
    let s = nextSeriesLanguage(EMPTY_SERIES_LANGUAGE, EP1, "fra");
    s = nextSeriesLanguage(s, EP2, "spa");
    s = nextSeriesLanguage(s, EP3, "fra");
    expect(s).toEqual({ preferred: null, candidate: "fra", candidateEpisodes: [EP3] });
  });

  it("réversible : deux épisodes vers une autre langue la remplacent, un seul ne suffit pas", () => {
    const fr = { preferred: "fra", candidate: null, candidateEpisodes: [] };
    const once = nextSeriesLanguage(fr, EP1, "eng");
    expect(once.preferred).toBe("fra");
    expect(nextSeriesLanguage(once, EP2, "eng").preferred).toBe("eng");
  });

  it("revenir à la langue retenue efface le changement en cours", () => {
    const s = nextSeriesLanguage({ preferred: "fra", candidate: "eng", candidateEpisodes: [EP1] }, EP2, "fra");
    expect(s).toEqual({ preferred: "fra", candidate: null, candidateEpisodes: [] });
  });
});

describe("rangée par compte et par série", () => {
  it("retenue pour ce compte seulement", () => {
    recordSeriesLanguageChoice("augustine", SERIES, EP1, "fra");
    recordSeriesLanguageChoice("augustine", SERIES, EP2, "fra");
    expect(seriesPreferredLanguage("augustine", SERIES)).toBe("fra");
    expect(seriesPreferredLanguage("louis", SERIES)).toBeNull();
  });
});

describe("POST /api/player/series-language", () => {
  const post = async (body: unknown) => (await import("@/app/api/player/series-language/route")).POST(req(body));

  it("refusé sans compte", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    expect((await post({ itemId: EP1, language: "fra" })).status).toBe(403);
  });

  it("refuse une langue ou un élément mal formés", async () => {
    expect((await post({ itemId: "x", language: "fra" })).status).toBe(400);
    expect((await post({ itemId: EP1, language: "français; DROP" })).status).toBe(400);
  });

  it("un film ne retient rien", async () => {
    mockUserData.mockResolvedValue({ Type: "Movie" });
    const body = await (await post({ itemId: EP1, language: "fra" })).json();
    expect(body.series).toBe(false);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM series_audio_language").get()).toEqual({ n: 0 });
  });

  it("deux épisodes : la série prend le français, sous le compte de la session", async () => {
    await post({ itemId: EP1, language: "fra" });
    mockUserData.mockResolvedValue({ Type: "Episode", SeriesId: SERIES });
    const body = await (await post({ itemId: EP2, language: "FRA" })).json();
    expect(body).toMatchObject({ series: true, preferred: "fra" });
    expect(seriesPreferredLanguage("augustine", SERIES)).toBe("fra");
  });
});

describe("à l'ouverture (playback-state)", () => {
  const get = async (itemId = EP3) =>
    (await (await import("@/app/api/jellyfin/playback-state/[itemId]/route")).GET(req(), { params: Promise.resolve({ itemId }) })).json();

  it("un épisode s'ouvre dans la langue retenue pour sa série, à la place de celle du compte", async () => {
    recordSeriesLanguageChoice("augustine", SERIES, EP1, "fra");
    recordSeriesLanguageChoice("augustine", SERIES, EP2, "fra");
    const body = await get();
    expect(body.preferences.audioLanguage).toBe("fra");
    expect(body.preferences.playDefaultAudioTrack).toBe(false);
  });

  it("une autre série, un film, ou rien de retenu : la préférence du compte, comme avant", async () => {
    recordSeriesLanguageChoice("augustine", SERIES, EP1, "fra");
    expect((await get()).preferences.audioLanguage).toBe("eng");
    recordSeriesLanguageChoice("augustine", SERIES, EP2, "fra");
    mockUserData.mockResolvedValue({ Type: "Episode", SeriesId: "z".repeat(32), UserData: {} });
    expect((await get()).preferences.audioLanguage).toBe("eng");
    mockUserData.mockResolvedValue({ Type: "Movie", UserData: {} });
    expect((await get()).preferences.audioLanguage).toBe("eng");
  });
});
