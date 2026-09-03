import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
vi.mock("@/lib/config", () => ({ config: { player: { enabled: true } } }));
const mockGetSources = vi.fn();
const mockTimestamps = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getItemMediaSources: (...a: unknown[]) => mockGetSources(...a),
    getEpisodeTimestamps: (...a: unknown[]) => mockTimestamps(...a),
  },
}));
const mockPrefs = vi.fn();
vi.mock("@/lib/db", () => ({ userPrefsDb: { getExperimentalPlayer: (...a: unknown[]) => mockPrefs(...a) } }));

const validId = "c".repeat(32);

function fakeReq(): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" ? { value: "t" } : undefined) },
  } as unknown as NextRequest;
}

function mediaSource(over: { container?: string; rangeType?: string | null; codec?: string } = {}) {
  return {
    MediaSources: [
      {
        Id: "src-1",
        Container: over.container ?? "mkv",
        Size: 1024,
        RunTimeTicks: 36_000_000_000,
        MediaStreams: [
          {
            Type: "Video",
            Codec: over.codec ?? "hevc",
            Width: 3840,
            Height: 2160,
            BitDepth: 10,
            VideoRangeType: over.rangeType === undefined ? "SDR" : over.rangeType,
          },
          { Type: "Audio", Index: 1, Codec: "eac3", Language: "fre", Channels: 6, IsDefault: true },
        ],
      },
    ],
  };
}

async function get() {
  const { GET } = await import("@/app/api/jellyfin/direct/[itemId]/route");
  return GET(fakeReq(), { params: Promise.resolve({ itemId: validId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", id: 7 });
  mockPrefs.mockReturnValue({ enabled: true });
  mockGetSources.mockResolvedValue(mediaSource());
  mockTimestamps.mockResolvedValue(null);
});

describe("GET /api/jellyfin/direct/[itemId]", () => {
  it("describes a plain SDR Matroska file without refusing anything", async () => {
    const body = await (await get()).json();
    expect(body.refusedReason).toBeNull();
    expect(body.canvasHdrRefusal).toBeNull();
    expect(body.container).toBe("mkv");
    expect(body.video).toMatchObject({ codec: "hevc", width: 3840, bitDepth: 10, isHdr: false });
    expect(body.streamUrl).toContain("static=true");
  });

  // The demuxer reads Matroska and nothing else, on either pipeline, so this refusal is absolute.
  it("refuses a container no pipeline can read, naming it", async () => {
    mockGetSources.mockResolvedValue(mediaSource({ container: "mp4" }));
    const body = await (await get()).json();
    expect(body.refusedReason).toContain("mp4");
    expect(body.refusedReason).toContain("Matroska");
  });

  // The change that matters: repackaging carries HDR signalling through untouched and the display
  // handles it. Refusing the file outright here would block the one path that plays it properly.
  it("raises no objection to an HDR file it can convert", async () => {
    // There is nothing to consent to any more. Converting on the GPU was a setting because it
    // was once the only way HDR played at all; the native path shows it untouched, and on the
    // fallback the conversion is what happens instead of nothing.
    mockGetSources.mockResolvedValue(mediaSource({ rangeType: "HDR10" }));
    const body = await (await get()).json();
    expect(body.refusedReason).toBeNull();
    expect(body.video.isHdr).toBe(true);
    expect(body.canvasHdrRefusal).toBeNull();
  });

  it("still objects to Dolby Vision without an HDR10 base, which has nothing to convert from", async () => {
    mockPrefs.mockReturnValue({ enabled: true });
    mockGetSources.mockResolvedValue(mediaSource({ rangeType: "DOVI" }));
    const body = await (await get()).json();
    expect(body.refusedReason).toBeNull(); // the native path may still manage it
    expect(body.canvasHdrRefusal).toContain("Dolby Vision");
  });

  it("passes on Jellyfin's intro and credits markers when it has analysed the episode", async () => {
    mockTimestamps.mockResolvedValue({
      Introduction: { Valid: true, Start: 62, End: 95 },
      Credits: { Valid: true, Start: 2500 },
    });
    const body = await (await get()).json();
    expect(body.introSkip).toEqual({ start: 62, end: 95 });
    expect(body.creditsStart).toBe(2500);
  });

  it("carries on without them for a film, or an episode nobody has analysed", async () => {
    // The timestamps endpoint 404s in both cases, which is not a reason to refuse playback —
    // it only means no skip-intro button and no next-up prompt for this one.
    mockTimestamps.mockRejectedValue(new Error("404"));
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.introSkip).toBeNull();
    expect(body.creditsStart).toBeNull();
  });

  it("ignores markers Jellyfin itself marks as unreliable", async () => {
    mockTimestamps.mockResolvedValue({
      Introduction: { Valid: false, Start: 10, End: 40 },
      Credits: { Valid: false, Start: 100 },
    });
    const body = await (await get()).json();
    expect(body.introSkip).toBeNull();
    expect(body.creditsStart).toBeNull();
  });

  it("turns away a caller who has not switched the experimental player on", async () => {
    mockPrefs.mockReturnValue({ enabled: false });
    expect((await get()).status).toBe(403);
  });

  it("refuses a malformed id, an unauthenticated caller, and a missing file", async () => {
    const { GET } = await import("@/app/api/jellyfin/direct/[itemId]/route");
    expect((await GET(fakeReq(), { params: Promise.resolve({ itemId: "nope" }) })).status).toBe(400);

    mockVerifySessionFull.mockResolvedValue(null);
    expect((await get()).status).toBe(401);

    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", id: 7 });
    mockGetSources.mockResolvedValue({ MediaSources: [] });
    expect((await get()).status).toBe(404);
  });
});
