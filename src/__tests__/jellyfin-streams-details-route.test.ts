import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { FileStreamsResponse } from "@/app/api/jellyfin/streams/[itemId]/route";

/**
 * La route des pistes d'un fichier, étendue pour la fenêtre « Détails » d'un film (DECISIONS.md §152,
 * 13/11/2026) : débit, profondeur, dynamique, profil Dolby Vision, profil des pistes son (Atmos),
 * sous-titres forcés / malentendants / externes / générés — tous en champs ajoutés, la réponse que lit la
 * page de gestion restant la même.
 */

vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
const mockGetSources = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getItemMediaSources: (...a: unknown[]) => mockGetSources(...a) } }));
const mockFilms = vi.fn(async () => [] as { tmdbId: number; originalLanguage?: { id: number; name: string } }[]);
vi.mock("@/lib/server-cache", () => ({ cachedMovies: () => mockFilms() }));
// Les sous-titres générés (§69) : doublés, la base des tâches a sa propre suite.
const mockGenerated = vi.fn(() => ({ ours: new Set<number>(), fallbacks: [] as { language: string; url: string }[] }));
vi.mock("@/lib/subtitleGen/direct", () => ({ generatedForDirect: () => mockGenerated() }));

const ID = "a".repeat(32);

function req(query = ""): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" ? { value: "t" } : undefined) },
    nextUrl: new URL(`http://localhost/api/jellyfin/streams/${ID}${query}`),
  } as unknown as NextRequest;
}

async function call(query = "") {
  const { GET } = await import("@/app/api/jellyfin/streams/[itemId]/route");
  return GET(req(query), { params: Promise.resolve({ itemId: ID }) });
}

/** Un film comme ceux de la bibliothèque : 4K Dolby Vision profil 8, TrueHD Atmos, AC-3, quatre sous-titres. */
function richFile(over: Record<string, unknown> = {}) {
  return {
    MediaSources: [
      {
        Id: "src",
        Container: "mkv",
        Bitrate: 52_400_000,
        MediaStreams: [
          { Type: "Video", Index: 0, Codec: "hevc", Width: 3840, Height: 1600, BitDepth: 10, VideoRange: "HDR", VideoRangeType: "DOVIWithHDR10", DvProfile: 8 },
          { Type: "Audio", Index: 1, Codec: "truehd", Language: "eng", Title: "English", Profile: "Dolby TrueHD + Dolby Atmos", Channels: 8, IsDefault: true },
          { Type: "Audio", Index: 2, Codec: "ac3", Language: "fre", Title: "VFF", Channels: 6 },
          { Type: "Subtitle", Index: 3, Codec: "subrip", Language: "fre", Title: "Forced", IsForced: true },
          { Type: "Subtitle", Index: 4, Codec: "subrip", Language: "eng", Title: "SDH", IsHearingImpaired: true },
          { Type: "Subtitle", Index: 5, Codec: "subrip", Language: "fre", IsExternal: true },
          { Type: "Subtitle", Index: 6, Codec: "subrip", Language: "eng", IsExternal: true },
        ],
        ...over,
      },
    ],
  };
}

beforeEach(() => {
  vi.resetModules();
  mockVerify.mockResolvedValue({ u: "louis", role: "user", jfId: "jf-1" });
  mockGetSources.mockReset();
  mockGenerated.mockImplementation(() => ({ ours: new Set<number>(), fallbacks: [] }));
  mockFilms.mockResolvedValue([]);
});

describe("GET /api/jellyfin/streams/[itemId] — la fenêtre « Détails » (§152)", () => {
  it("lit le fichier avec le compte Jellyfin de la session", async () => {
    mockGetSources.mockResolvedValue(richFile());
    await call();
    expect(mockGetSources).toHaveBeenCalledWith("jf-1", ID);
  });

  it("donne le débit, la profondeur, la dynamique et le profil Dolby Vision", async () => {
    mockGetSources.mockResolvedValue(richFile());
    const body = (await (await call()).json()) as FileStreamsResponse;
    expect(body.bitrate).toBe(52_400_000);
    expect(body.video).toMatchObject({ codec: "HEVC", width: 3840, height: 1600, bitDepth: 10, dynamicRange: "Dolby Vision", dvProfile: 8 });
    // Le champ d'avant ne bouge pas : la page de gestion le lit.
    expect(body.video?.rangeType).toBe("DOVIWithHDR10");
  });

  it("garde le profil d'une piste son tel que Jellyfin l'a lu — l'Atmos déclaré, sans rien en conclure", async () => {
    mockGetSources.mockResolvedValue(richFile());
    const body = (await (await call()).json()) as FileStreamsResponse;
    expect(body.audio).toHaveLength(2);
    expect(body.audio[0]).toMatchObject({ index: 1, name: "English", profile: "Dolby TrueHD + Dolby Atmos", isDefault: true, channels: 8 });
    expect(body.audio[1]).toMatchObject({ index: 2, name: "VFF", profile: null, atmos: false, isDefault: false });
  });

  it("dit forcé, malentendants, externe et généré pour chaque sous-titre", async () => {
    mockGenerated.mockImplementation(() => ({ ours: new Set([6]), fallbacks: [] }));
    mockGetSources.mockResolvedValue(richFile());
    const body = (await (await call()).json()) as FileStreamsResponse;
    expect(body.subtitles.map((s) => [s.index, s.forced, s.hearingImpaired, s.external, s.generated ?? false])).toEqual([
      [3, true, false, false, false],
      [4, false, true, false, false],
      [5, false, false, true, false],
      [6, false, false, true, true],
    ]);
  });

  it("rend un débit absent comme inconnu, sans rien inventer", async () => {
    mockGetSources.mockResolvedValue(richFile({ Bitrate: undefined }));
    const body = (await (await call()).json()) as FileStreamsResponse;
    expect(body.bitrate).toBeNull();
  });

  it("nomme HDR10+, HLG et SDR ; une couche Dolby Vision invalide ne promet pas le Dolby Vision", async () => {
    for (const [rangeType, range, expected] of [
      ["HDR10Plus", "HDR", "HDR10+"],
      ["HLG", "HDR", "HLG"],
      ["SDR", "SDR", "SDR"],
      ["DOVIInvalid", "HDR", "HDR"],
    ] as const) {
      mockGetSources.mockResolvedValue({
        MediaSources: [{ Id: "s", MediaStreams: [{ Type: "Video", Index: 0, Codec: "hevc", VideoRangeType: rangeType, VideoRange: range }] }],
      });
      const body = (await (await call()).json()) as FileStreamsResponse;
      expect([rangeType, body.video?.dynamicRange]).toEqual([rangeType, expected]);
    }
  });

  it("ajoute la langue de tournage seulement quand l'appel nomme le film (?tmdb=)", async () => {
    mockGetSources.mockResolvedValue(richFile());
    mockFilms.mockResolvedValue([{ tmdbId: 530915, originalLanguage: { id: 1, name: "English" } }]);
    expect(((await (await call("?tmdb=530915")).json()) as FileStreamsResponse).originalLanguage).toBe("en");
    // Sans paramètre (la page de gestion), le champ n'existe pas : la réponse d'avant.
    expect("originalLanguage" in ((await (await call()).json()) as object)).toBe(false);
  });

  it("une erreur de Jellyfin reste une erreur propre, jamais une exception", async () => {
    mockGetSources.mockRejectedValue(new Error("Jellyfin injoignable"));
    const res = await call();
    expect(res.status).toBe(502);
  });

  it("le message brut de Jellyfin ne sort jamais dans la réponse (13/11/2026)", async () => {
    mockGetSources.mockRejectedValue(new Error("404 Not Found: http://jellyfin:8096/Items/abc"));
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Jellyfin injoignable" });
  });
});
