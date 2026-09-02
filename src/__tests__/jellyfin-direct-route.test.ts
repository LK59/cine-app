import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
vi.mock("@/lib/config", () => ({ config: { player: { enabled: true } } }));
const mockGetSources = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: { getItemMediaSources: (...a: unknown[]) => mockGetSources(...a) },
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
  mockPrefs.mockReturnValue({ enabled: true, hdr: false });
  mockGetSources.mockResolvedValue(mediaSource());
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
  it("lets an HDR file through even with tone mapping switched off", async () => {
    mockGetSources.mockResolvedValue(mediaSource({ rangeType: "HDR10" }));
    const body = await (await get()).json();
    expect(body.refusedReason).toBeNull();
    expect(body.video.isHdr).toBe(true);
    // Carried down, not applied: it only holds if playback ends up on the canvas.
    expect(body.canvasHdrRefusal).toContain("HDR10");
  });

  it("raises no canvas objection once the viewer has allowed tone mapping", async () => {
    mockPrefs.mockReturnValue({ enabled: true, hdr: true });
    mockGetSources.mockResolvedValue(mediaSource({ rangeType: "HDR10" }));
    const body = await (await get()).json();
    expect(body.canvasHdrRefusal).toBeNull();
  });

  it("still objects to Dolby Vision without an HDR10 base, which has nothing to convert from", async () => {
    mockPrefs.mockReturnValue({ enabled: true, hdr: true });
    mockGetSources.mockResolvedValue(mediaSource({ rangeType: "DOVI" }));
    const body = await (await get()).json();
    expect(body.refusedReason).toBeNull(); // the native path may still manage it
    expect(body.canvasHdrRefusal).toContain("Dolby Vision");
  });

  it("turns away a caller who has not switched the experimental player on", async () => {
    mockPrefs.mockReturnValue({ enabled: false, hdr: false });
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
