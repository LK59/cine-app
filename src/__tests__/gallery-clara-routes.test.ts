import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockFs = {
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  readFileSync: vi.fn(),
};
vi.mock("fs", () => ({ default: mockFs, ...mockFs }));

function fakeReq(params: Record<string, string> = {}): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/gallery/clara", () => {
  it("lists only image files, sorted", async () => {
    mockFs.readdirSync.mockReturnValue(["b.jpg", "a.png", "notes.txt", "c.webp"]);
    const { GET } = await import("@/app/api/gallery/clara/route");
    const res = await GET();
    const body = await res.json();
    expect(body.files).toEqual(["a.png", "b.jpg", "c.webp"]);
  });

  it("returns an empty list instead of throwing when the directory doesn't exist", async () => {
    mockFs.readdirSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const { GET } = await import("@/app/api/gallery/clara/route");
    const res = await GET();
    expect((await res.json()).files).toEqual([]);
  });
});

describe("GET /api/gallery/clara/[filename]", () => {
  it("returns 403 when the filename tries to traverse out of the gallery dir", async () => {
    const { GET } = await import("@/app/api/gallery/clara/[filename]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ filename: "../../etc/passwd" }) });
    expect(res.status).toBe(403);
  });

  it("returns 404 when the file doesn't exist", async () => {
    mockFs.existsSync.mockReturnValue(false);
    const { GET } = await import("@/app/api/gallery/clara/[filename]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ filename: "photo.jpg" }) });
    expect(res.status).toBe(404);
  });

  it("serves the full image with the correct content-type for its extension", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(Buffer.from("data"));
    const { GET } = await import("@/app/api/gallery/clara/[filename]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ filename: "photo.png" }) });
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

describe("GET /api/gallery/clara/random", () => {
  it("returns 404 when the gallery is empty", async () => {
    mockFs.readdirSync.mockReturnValue([]);
    const { GET } = await import("@/app/api/gallery/clara/random/route");
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("excludes the banner/favicon files from the random pool", async () => {
    mockFs.readdirSync.mockReturnValue(["clarabanner.jpg", "favicon.jpeg", "photo1.jpg"]);
    const { GET } = await import("@/app/api/gallery/clara/random/route");
    const res = await GET();
    const html = await res.text();
    expect(html).toContain("photo1.jpg");
    // The two <img> src attributes should both point at photo1.jpg since it's the only eligible file.
    expect((html.match(/photo1\.jpg/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
