import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Le sous-titre incrusté dans l'image d'une diffusion AirPlay (`castSubtitle.ts`, 26/10/2026) : demandé
// par la page, retrouvé par sa langue dans un autre fichier, et rien de changé sans lui.

const mockJellyfin = {
  getPlaybackInfo: vi.fn(),
  reportPlaybackStart: vi.fn(),
  getEpisodeTimestamps: vi.fn(),
  getItemNaming: vi.fn(),
};
vi.mock("@/lib/server-cache", () => ({ cachedMovies: async () => [] }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
vi.mock("@/lib/config", () => ({
  config: {
    get player() {
      return { enabled: true };
    },
    jellyfin: { url: "http://jf.test" },
    app: { sessionSecret: "secret-de-test-assez-long-pour-signer" },
  },
}));
const mockFetch = vi.fn(async (..._args: unknown[]) => ({ ok: true, text: async () => "#EXTM3U" }));

const validId = "a".repeat(32);

function req(body: unknown): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" ? { value: "t" } : undefined) },
    json: async () => body,
    headers: new Headers({ "x-forwarded-proto": "https", "x-forwarded-host": "cine.example" }),
  } as unknown as NextRequest;
}

type Call = { deviceProfile: { SubtitleProfiles: { Format: string; Method: string }[] }; subtitleStreamIndex?: number };
const call = (n = 0) => mockJellyfin.getPlaybackInfo.mock.calls[n][3] as Call;
const methods = (n = 0) => [...new Set(call(n).deviceProfile.SubtitleProfiles.map((p) => p.Method))];

const ANIME = {
  PlaySessionId: "play-1",
  MediaSources: [
    {
      Id: "src-1",
      TranscodingUrl: "/videos/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/master.m3u8?DeviceId=x",
      MediaStreams: [
        { Type: "Video", Index: 0, Codec: "hevc" },
        { Type: "Audio", Index: 1, Codec: "aac", Channels: 2, Language: "jpn" },
        { Type: "Subtitle", Index: 2, Language: "eng", IsTextSubtitleStream: true },
        { Type: "Subtitle", Index: 3, Language: "fre", IsTextSubtitleStream: true, IsForced: true },
        { Type: "Subtitle", Index: 4, Language: "fre", IsTextSubtitleStream: true },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok", jti: undefined });
  mockJellyfin.reportPlaybackStart.mockResolvedValue(undefined);
  mockJellyfin.getEpisodeTimestamps.mockResolvedValue(null);
  mockJellyfin.getItemNaming.mockResolvedValue(null);
  mockJellyfin.getPlaybackInfo.mockResolvedValue(ANIME);
});

describe("POST /api/jellyfin/playback/start — sous-titre incrusté pour AirPlay", () => {
  it("l'index demandé, avec un profil qui incruste, en une seule négociation", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(req({ itemId: validId, forCast: true, burnSubtitle: { index: 4, language: "fre", forced: false } }));
    expect(res.status).toBe(200);
    expect(mockJellyfin.getPlaybackInfo).toHaveBeenCalledTimes(1);
    expect(call().subtitleStreamIndex).toBe(4);
    expect(methods()).toEqual(["Encode"]);
    expect((await res.json()).burnedSubtitle).toBe(4);
  });

  it("un autre fichier (épisode suivant) : retrouvé par sa langue et son drapeau, puis renégocié", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(req({ itemId: validId, forCast: true, burnSubtitle: { language: "fre", forced: false } }));
    expect(mockJellyfin.getPlaybackInfo).toHaveBeenCalledTimes(2);
    expect(call(0).subtitleStreamIndex).toBeUndefined();
    expect(methods(0)).toEqual(["Hls"]);
    expect(call(1).subtitleStreamIndex).toBe(4);
    expect(methods(1)).toEqual(["Encode"]);
    expect((await res.json()).burnedSubtitle).toBe(4);
  });

  it("aucun sous-titre de cette langue : la diffusion d'avant, sans incrustation", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(req({ itemId: validId, forCast: true, burnSubtitle: { language: "spa", forced: false } }));
    expect(mockJellyfin.getPlaybackInfo).toHaveBeenCalledTimes(1);
    expect(methods()).toEqual(["Hls"]);
    expect((await res.json()).burnedSubtitle).toBeUndefined();
  });

  it("ignoré hors diffusion et pour un Chromecast", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    await POST(req({ itemId: validId, burnSubtitle: { index: 4, language: "fre", forced: false } }));
    expect(call(0).subtitleStreamIndex).toBeUndefined();
    expect(methods(0)).toEqual(["External", "Hls"]);
    await POST(req({ itemId: validId, castTarget: "chromecast", burnSubtitle: { index: 4, language: "fre", forced: false } }));
    expect(call(1).subtitleStreamIndex).toBeUndefined();
    expect(methods(1)).toEqual(["External", "Encode"]);
  });
});
