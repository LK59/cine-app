import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockJellyfin = {
  getPlaybackInfo: vi.fn(),
  reportPlaybackStart: vi.fn(),
  getEpisodeTimestamps: vi.fn(),
};
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
let playerEnabled = true;
vi.mock("@/lib/config", () => ({
  config: {
    get player() { return { enabled: playerEnabled }; },
    jellyfin: { url: "http://jf.test" },
  },
}));

// The route pre-warms Jellyfin's transcode by fetching the manifest itself; stubbed so no test
// reaches the network, and so the pre-warm can be asserted on directly.
const mockFetch = vi.fn(async (..._args: unknown[]) => ({ ok: true, text: async () => "#EXTM3U" }));

function fakeReq(body?: unknown, cookie = "t"): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
    json: async () => body ?? null,
  } as unknown as NextRequest;
}

const validId = "a".repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  playerEnabled = true;
  mockJellyfin.reportPlaybackStart.mockResolvedValue(undefined);
  mockJellyfin.getEpisodeTimestamps.mockResolvedValue(null);
});

describe("POST /api/jellyfin/playback/start", () => {
  it("returns 404 when the in-app player is disabled", async () => {
    playerEnabled = false;
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({}));
    expect(res.status).toBe(404);
  });

  it("asks for Jellyfin reauth when the session has no jfToken", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: validId }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("jellyfin_reauth_required");
  });

  it("rejects a malformed itemId", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: "not-hex!" }));
    expect(res.status).toBe(400);
  });

  it("re-roots Jellyfin's TranscodingUrl under our own stream proxy, matching the id generically", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.getPlaybackInfo.mockResolvedValue({
      PlaySessionId: "play-1",
      MediaSources: [{
        Id: "src-1",
        // Jellyfin writes the id in dashed UUID form here, different from our bare-hex itemId.
        TranscodingUrl: "/videos/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/master.m3u8?DeviceId=x",
        MediaStreams: [],
      }],
    });
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: validId }));
    const body = await res.json();
    expect(body.manifestUrl).toBe(`/api/jellyfin/stream/${validId}/master.m3u8?DeviceId=x`);
  });

  it("returns 502 when Jellyfin returns no MediaSource/TranscodingUrl", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.getPlaybackInfo.mockResolvedValue({ PlaySessionId: "s", MediaSources: [] });
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: validId }));
    expect(res.status).toBe(502);
  });

  it("maps subtitle and audio tracks from MediaStreams", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.getPlaybackInfo.mockResolvedValue({
      PlaySessionId: "s",
      MediaSources: [{
        Id: "src-1",
        TranscodingUrl: "/videos/x/master.m3u8",
        MediaStreams: [
          { Type: "Subtitle", Index: 2, Language: "fre", DisplayTitle: "French", IsDefault: true },
          { Type: "Audio", Index: 1, Language: "eng", DisplayTitle: "English" },
        ],
      }],
    });
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: validId }));
    const body = await res.json();
    expect(body.subtitleTracks[0]).toMatchObject({ index: 2, language: "fre", isDefault: true });
    expect(body.audioTracks[0]).toMatchObject({ index: 1, language: "eng" });
  });

  it("returns null introSkip/creditsStart when timestamps aren't available (movie or unanalyzed episode)", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.getPlaybackInfo.mockResolvedValue({
      PlaySessionId: "s", MediaSources: [{ Id: "src-1", TranscodingUrl: "/videos/x/m.m3u8", MediaStreams: [] }],
    });
    mockJellyfin.getEpisodeTimestamps.mockResolvedValue(null);
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: validId }));
    const body = await res.json();
    expect(body.introSkip).toBeNull();
    expect(body.creditsStart).toBeNull();
  });

  it("converts a 401 HttpError from Jellyfin into a reauth-required response", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    const { HttpError } = await import("@/lib/http");
    mockJellyfin.getPlaybackInfo.mockRejectedValue(new HttpError("expired", 401));
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: validId }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("jellyfin_reauth_required");
  });

  it("does not fail playback when reportPlaybackStart itself fails (best-effort)", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.getPlaybackInfo.mockResolvedValue({
      PlaySessionId: "s", MediaSources: [{ Id: "src-1", TranscodingUrl: "/videos/x/m.m3u8", MediaStreams: [] }],
    });
    mockJellyfin.reportPlaybackStart.mockRejectedValue(new Error("report failed"));
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: validId }));
    expect(res.status).toBe(200);
  });

  it("builds a static stream URL and reports DirectPlay when SupportsDirectPlay is true", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.getPlaybackInfo.mockResolvedValue({
      PlaySessionId: "s",
      MediaSources: [{
        Id: "src-1",
        Container: "mp4",
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        MediaStreams: [{ Type: "Video", Index: 0, Codec: "h264" }],
      }],
    });
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: validId }));
    const body = await res.json();
    expect(body.isDirectPlay).toBe(true);
    expect(body.manifestUrl).toBe(`/api/jellyfin/stream/${validId}/stream.mp4?static=true&mediaSourceId=src-1`);
    expect(body.playbackInfo.playMethod).toBe("DirectPlay");
    expect(mockJellyfin.reportPlaybackStart).toHaveBeenCalledWith("jf-1", validId, "tok", "s", "src-1", "DirectPlay");
  });

  it("labels playMethod Transcode when the source's own video codec isn't in the accepted VideoCodec list — a real re-encode, regardless of the reason text", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.getPlaybackInfo.mockResolvedValue({
      PlaySessionId: "s",
      MediaSources: [{
        Id: "src-1",
        TranscodingUrl: "/videos/x/master.m3u8?VideoCodec=h264&TranscodeReasons=AudioCodecNotSupported",
        MediaStreams: [{ Type: "Video", Index: 0, Codec: "hevc" }],
      }],
    });
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: validId }));
    const body = await res.json();
    // hevc (the source's real codec) isn't in the accepted "h264" list -> a genuine re-encode,
    // even though the reason text alone (AudioCodecNotSupported) would suggest otherwise. This
    // is exactly the real-world case found live: two browsers negotiating the same file, same
    // kind of reason text, but one got a real video copy and the other a full re-encode.
    expect(body.playbackInfo.playMethod).toBe("Transcode");
    expect(mockJellyfin.reportPlaybackStart).toHaveBeenCalledWith("jf-1", validId, "tok", "s", "src-1", "Transcode");
  });

  it("excludes disableAudioCodecs from the negotiated DeviceProfile even when the browser claims support", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.getPlaybackInfo.mockResolvedValue({
      PlaySessionId: "s",
      MediaSources: [{ Id: "src-1", TranscodingUrl: "/videos/x/master.m3u8?VideoCodec=hevc", MediaStreams: [] }],
    });
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    await POST(
      fakeReq({
        itemId: validId,
        // The browser claims eac3 support (canPlayType overreports — the real-world case being
        // an iPhone whose native HLS pipeline rejects ec-3 despite a truthy canPlayType), and
        // the client's fallback ladder asks for it to be excluded after a failed attempt.
        codecSupport: { video: { "mp4/hevc": true }, audio: { aac: true, eac3: true } },
        disableAudioCodecs: ["eac3"],
      })
    );
    const profile = mockJellyfin.getPlaybackInfo.mock.calls[0][3].deviceProfile;
    expect(profile.TranscodingProfiles[0].AudioCodec).toBe("aac");
    expect(profile.DirectPlayProfiles[0].AudioCodec).toBe("aac");
  });

  it("labels playMethod DirectStream when the source's own video codec IS in the accepted VideoCodec list — a real copy, no re-encode", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.getPlaybackInfo.mockResolvedValue({
      PlaySessionId: "s",
      MediaSources: [{
        Id: "src-1",
        TranscodingUrl: "/videos/x/master.m3u8?VideoCodec=h264,hevc&TranscodeReasons=AudioCodecNotSupported",
        MediaStreams: [{ Type: "Video", Index: 0, Codec: "hevc" }],
      }],
    });
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: validId }));
    const body = await res.json();
    expect(body.playbackInfo.playMethod).toBe("DirectStream");
    expect(body.playbackInfo.transcodeReasons).toEqual(["AudioCodecNotSupported"]);
  });

  // The pre-warm exists to absorb ffmpeg's startup for Safari's native HLS pipeline, which gives
  // up on a slow first manifest. hls.js retries patiently and gains nothing from waiting here.
  function transcodingSource() {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.getPlaybackInfo.mockResolvedValue({
      PlaySessionId: "play-1",
      MediaSources: [{ Id: "src-1", TranscodingUrl: "/videos/aaaa/master.m3u8?x=1", MediaStreams: [] }],
    });
  }

  it("pre-warms the transcode for a native-HLS client", async () => {
    transcodingSource();
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    await POST(fakeReq({ itemId: validId, nativeHls: true }));
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(String(mockFetch.mock.calls[0][0])).toContain("/videos/aaaa/master.m3u8");
  });

  it("still pre-warms when the client doesn't say (an older client)", async () => {
    transcodingSource();
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    await POST(fakeReq({ itemId: validId }));
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("skips the pre-warm for an hls.js client, so the response isn't held behind ffmpeg", async () => {
    transcodingSource();
    const { POST } = await import("@/app/api/jellyfin/playback/start/route");
    const res = await POST(fakeReq({ itemId: validId, nativeHls: false }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
