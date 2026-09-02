import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

const mockResolveSession = vi.fn();
vi.mock("@/lib/session", () => ({ resolveSession: (...a: unknown[]) => mockResolveSession(...a) }));
const mockGetLocalTrailerPath = vi.fn();
vi.mock("@/lib/trailerDownload", () => ({ getLocalTrailerPath: (...a: unknown[]) => mockGetLocalTrailerPath(...a) }));

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cine-trailer-file-test-"));
const FILE_PATH = path.join(TMP_DIR, "movie-603.mp4");
const CONTENT = Buffer.from("0123456789"); // 10 bytes, easy to reason about ranges over

beforeAll(() => {
  fs.writeFileSync(FILE_PATH, CONTENT);
});
afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});
beforeEach(() => vi.clearAllMocks());

function fakeReq(range?: string): NextRequest {
  return {
    headers: { get: (name: string) => (name.toLowerCase() === "range" ? (range ?? null) : null) },
  } as unknown as NextRequest;
}

function params(mediaType: string, tmdbId: string) {
  return { params: Promise.resolve({ mediaType, tmdbId }) };
}

async function bodyText(res: Response): Promise<string> {
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

describe("GET /api/cinema/trailer-file/[mediaType]/[tmdbId]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockResolveSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/cinema/trailer-file/[mediaType]/[tmdbId]/route");
    const res = await GET(fakeReq(), params("movie", "603"));
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid mediaType", async () => {
    mockResolveSession.mockResolvedValue({ u: "louis" });
    const { GET } = await import("@/app/api/cinema/trailer-file/[mediaType]/[tmdbId]/route");
    const res = await GET(fakeReq(), params("show", "603"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-numeric tmdbId", async () => {
    mockResolveSession.mockResolvedValue({ u: "louis" });
    const { GET } = await import("@/app/api/cinema/trailer-file/[mediaType]/[tmdbId]/route");
    const res = await GET(fakeReq(), params("movie", "abc"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when no local file exists", async () => {
    mockResolveSession.mockResolvedValue({ u: "louis" });
    mockGetLocalTrailerPath.mockReturnValue(null);
    const { GET } = await import("@/app/api/cinema/trailer-file/[mediaType]/[tmdbId]/route");
    const res = await GET(fakeReq(), params("movie", "603"));
    expect(res.status).toBe(404);
  });

  it("serves the whole file with 200 + Accept-Ranges when no Range header is sent", async () => {
    mockResolveSession.mockResolvedValue({ u: "louis" });
    mockGetLocalTrailerPath.mockReturnValue(FILE_PATH);
    const { GET } = await import("@/app/api/cinema/trailer-file/[mediaType]/[tmdbId]/route");
    const res = await GET(fakeReq(), params("movie", "603"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(await bodyText(res)).toBe("0123456789");
  });

  it("serves a valid byte range with 206 + correct Content-Range/Content-Length", async () => {
    mockResolveSession.mockResolvedValue({ u: "louis" });
    mockGetLocalTrailerPath.mockReturnValue(FILE_PATH);
    const { GET } = await import("@/app/api/cinema/trailer-file/[mediaType]/[tmdbId]/route");
    const res = await GET(fakeReq("bytes=2-5"), params("movie", "603"));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(await bodyText(res)).toBe("2345");
  });

  it("clamps an out-of-bounds range end to the file size", async () => {
    mockResolveSession.mockResolvedValue({ u: "louis" });
    mockGetLocalTrailerPath.mockReturnValue(FILE_PATH);
    const { GET } = await import("@/app/api/cinema/trailer-file/[mediaType]/[tmdbId]/route");
    const res = await GET(fakeReq("bytes=8-999"), params("movie", "603"));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 8-9/10");
  });

  it("returns 416 for a range starting beyond the file size", async () => {
    mockResolveSession.mockResolvedValue({ u: "louis" });
    mockGetLocalTrailerPath.mockReturnValue(FILE_PATH);
    const { GET } = await import("@/app/api/cinema/trailer-file/[mediaType]/[tmdbId]/route");
    const res = await GET(fakeReq("bytes=1000-2000"), params("movie", "603"));
    expect(res.status).toBe(416);
  });
});
