import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// DECISIONS.md §64 — la négociation d'une diffusion Chromecast : son profil, son adresse signée, et
// rien de changé pour AirPlay ni pour la page.

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

type Profile = {
  TranscodingProfiles: { VideoCodec: string; AudioCodec: string }[];
  SubtitleProfiles: { Format: string; Method: string }[];
};
const profileOfCall = (n = 0) => (mockJellyfin.getPlaybackInfo.mock.calls[n][3] as { deviceProfile: Profile }).deviceProfile;

const WITH_PGS = {
  PlaySessionId: "play-1",
  MediaSources: [
    {
      Id: "src-1",
      TranscodingUrl: "/videos/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/master.m3u8?DeviceId=x",
      MediaStreams: [
        { Type: "Video", Index: 0, Codec: "hevc" },
        { Type: "Audio", Index: 1, Codec: "eac3", Channels: 6 },
        { Type: "Subtitle", Index: 2, Language: "fre", IsTextSubtitleStream: false },
        { Type: "Subtitle", Index: 3, Language: "eng", IsTextSubtitleStream: true },
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
  mockJellyfin.getPlaybackInfo.mockResolvedValue(WITH_PGS);
});

describe("POST /api/jellyfin/playback/start — castTarget « chromecast »", () => {
  it("négocie avec le profil du Chromecast, quels que soient les codecs que la page dit lire", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(req({ itemId: validId, castTarget: "chromecast", codecSupport: { video: { "mp4/hevc": true }, audio: { truehd: true } } }));
    expect(res.status).toBe(200);
    const profile = profileOfCall();
    expect(profile.TranscodingProfiles[0].VideoCodec).toBe("h264");
    expect(profile.TranscodingProfiles[0].AudioCodec).toBe("aac,ac3,eac3");
    expect(profile.SubtitleProfiles[0]).toEqual({ Format: "vtt", Method: "External" });
  });

  it("rend une adresse absolue et signée — le récepteur va la chercher sans cookie", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const body = await (await POST(req({ itemId: validId, castTarget: "chromecast" }))).json();
    expect(body.castUrl).toMatch(new RegExp(`^https://cine\\.example/api/jellyfin/stream/${validId}/master\\.m3u8\\?DeviceId=x&castToken=`));
    const { CAST_TOKEN_PARAM, verifyCastToken } = await import("@/lib/castToken");
    expect(await verifyCastToken(new URL(body.castUrl).searchParams.get(CAST_TOKEN_PARAM), validId)).toBe("louis");
  });

  it("ne refuse pas un sous-titre en images : il sera incrusté, au contraire d'AirPlay", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(req({ itemId: validId, castTarget: "chromecast", subtitleStreamIndex: 2 }));
    expect(res.status).toBe(200);
  });

  it("dit de chaque sous-titre s'il est en texte — et seulement pour un Chromecast", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const cast = await (await POST(req({ itemId: validId, castTarget: "chromecast" }))).json();
    expect(cast.subtitleTracks.map((s: { index: number; isText: unknown }) => [s.index, s.isText])).toEqual([
      [2, false],
      [3, true],
    ]);
    const page = await (await POST(req({ itemId: validId }))).json();
    for (const st of page.subtitleTracks) expect(st).not.toHaveProperty("isText");
  });

  it("une autre valeur est ignorée : profil de la page, sans diffusion", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    await POST(req({ itemId: validId, castTarget: "airplay", codecSupport: { video: { "mp4/hevc": true }, audio: { aac: true } } }));
    expect(profileOfCall().TranscodingProfiles[0].VideoCodec).toBe("hevc");
    expect(profileOfCall().SubtitleProfiles).toEqual([
      { Format: "vtt", Method: "External" },
      { Format: "vtt", Method: "Hls" },
    ]);
  });
});

describe("AirPlay (forCast sans castTarget) ne change pas", () => {
  it("garde le profil de la page avec les sous-titres dans le flux", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    await POST(req({ itemId: validId, forCast: true, codecSupport: { video: { "mp4/hevc": true }, audio: { eac3: true } } }));
    expect(profileOfCall().TranscodingProfiles[0].VideoCodec).toBe("hevc");
    expect(profileOfCall().TranscodingProfiles[0].AudioCodec).toBe("eac3");
    expect(profileOfCall().SubtitleProfiles).toEqual([{ Format: "vtt", Method: "Hls" }]);
  });

  it("refuse toujours un sous-titre en images (409 cast-refused)", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(req({ itemId: validId, forCast: true, subtitleStreamIndex: 2 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "cast-refused", code: "image-subtitle" });
  });
});
