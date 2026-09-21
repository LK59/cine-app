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

// L'option, lue au démarrage depuis le 22/09/2026 (elle était figée dans l'image). Ouverte pour
// les tests qui examinent la galerie elle-même ; les derniers la ferment.
const gallery = { clara: true };
vi.mock("@/lib/config", () => ({ config: { gallery } }));

function fakeReq(params: Record<string, string> = {}, headers: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(params), protocol: "http:", host: "cine-app:3000" },
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  gallery.clara = true;
});

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
    const res = await GET(fakeReq());
    expect(res.status).toBe(404);
  });

  it("excludes the banner/favicon files from the random pool", async () => {
    mockFs.readdirSync.mockReturnValue(["clarabanner.jpg", "favicon.jpeg", "photo1.jpg"]);
    const { GET } = await import("@/app/api/gallery/clara/random/route");
    const res = await GET(fakeReq());
    const html = await res.text();
    expect(html).toContain("photo1.jpg");
    // The two <img> src attributes should both point at photo1.jpg since it's the only eligible file.
    expect((html.match(/photo1\.jpg/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("la galerie, option d'une seule installation", () => {
  it("écrit ses adresses absolues sous le nom public de l'installation, pas sous un domaine fixe", async () => {
    // Elles étaient écrites en dur avec le domaine de l'installation de référence : ailleurs, les
    // aperçus de lien et les photos pointaient chez elle.
    mockFs.readdirSync.mockReturnValue(["photo1.jpg"]);
    const { GET } = await import("@/app/api/gallery/clara/random/route");
    const res = await GET(fakeReq({}, { "x-forwarded-proto": "https", "x-forwarded-host": "films.example.org" }));
    const html = await res.text();
    expect(html).toContain("https://films.example.org/api/gallery/clara/photo1.jpg");
    expect(html).not.toContain("kakol");
  });

  it("ne sert rien quand l'option est fermée — ni liste, ni photo, ni diaporama", async () => {
    gallery.clara = false;
    mockFs.readdirSync.mockReturnValue(["photo1.jpg"]);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(Buffer.from("data"));
    const list = await (await import("@/app/api/gallery/clara/route")).GET();
    const file = await (await import("@/app/api/gallery/clara/[filename]/route")).GET(fakeReq(), {
      params: Promise.resolve({ filename: "photo1.jpg" }),
    });
    const random = await (await import("@/app/api/gallery/clara/random/route")).GET(fakeReq());
    expect([list.status, file.status, random.status]).toEqual([404, 404, 404]);
  });
});

