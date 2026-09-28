import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockGetConfig = vi.fn();
const mockUpdateConfig = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getUserConfiguration: (...a: unknown[]) => mockGetConfig(...a),
    updateUserConfiguration: (...a: unknown[]) => mockUpdateConfig(...a),
  },
}));

function post(body: unknown): Promise<Response> {
  const req = {
    cookies: { get: () => ({ value: "t" }) },
    json: async () => body,
  } as unknown as NextRequest;
  return import("@/app/api/player/account/preferences/route").then(({ POST }) => POST(req));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
  mockGetConfig.mockResolvedValue({
    Configuration: { AudioLanguagePreference: null, SubtitleMode: "Smart", PlayDefaultAudioTrack: true, HidePlayedInLatest: true },
  });
  mockUpdateConfig.mockResolvedValue(undefined);
});

/**
 * Les préférences de lecture du compte, écrites chez Jellyfin (28/09/2026 : la piste par défaut).
 */
describe("POST /api/player/account/preferences", () => {
  it("choisir une langue audio désactive « lire la piste par défaut », qui l'emportait sur elle", async () => {
    // Un compte réglé sur l'anglais s'ouvrait en français, et le spectateur corrigeait à la main.
    const res = await post({ audioLanguage: "eng" });
    expect(res.status).toBe(200);
    const [, , next] = mockUpdateConfig.mock.calls[0];
    expect(next).toMatchObject({ AudioLanguagePreference: "eng", PlayDefaultAudioTrack: false });
    // Le reste de la configuration repart tel quel — Jellyfin la remplace en entier.
    expect(next).toMatchObject({ SubtitleMode: "Smart", HidePlayedInLatest: true });
  });

  it("sans langue audio, l'option reste comme le compte l'a laissée", async () => {
    await post({ audioLanguage: null, subtitleMode: "Always" });
    const [, , next] = mockUpdateConfig.mock.calls[0];
    expect(next).toMatchObject({ PlayDefaultAudioTrack: true, SubtitleMode: "Always", AudioLanguagePreference: null });
    await post({ subtitleLanguage: "fra" });
    expect(mockUpdateConfig.mock.calls[1][2]).toMatchObject({ PlayDefaultAudioTrack: true });
  });
});
