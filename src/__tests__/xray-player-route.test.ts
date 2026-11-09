import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * Les acteurs à l'écran pour le lecteur (DECISIONS.md §138) : `GET /api/player/xray/[itemId]`.
 * Une absence attendue répond 200 avec `scenes: []` — jamais 404 (CLAUDE.md, CrowdSec) — ; un élément
 * caché à ce compte répond exactement comme un élément jamais analysé ; les scènes sont jointes à la
 * distribution ; un résultat d'une autre version du fichier n'est pas servi.
 */

const ITEM = "a".repeat(32);

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
const mockVisible = vi.fn();
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: (...a: unknown[]) => mockVisible(...a) }));

const svc = vi.hoisted(() => ({
  configured: true,
  /** À qui l'option est ouverte (`featureAudience.ts`) — la vraie règle, sur ce réglage. */
  audience: "tous" as "off" | "admins" | "tous",
  scenes: null as unknown,
  status: null as unknown,
  scenesError: null as Error | null,
}));
vi.mock("@/lib/clients/xray", () => ({
  xrayConfigured: () => svc.configured,
  xrayOpenTo: (s: { role?: string } | null) => (svc.audience === "tous" ? !!s : svc.audience === "admins" ? s?.role === "admin" : false),
  xray: {
    scenes: async () => {
      if (svc.scenesError) throw svc.scenesError;
      return svc.scenes;
    },
    itemStatus: async () => svc.status,
  },
}));
const target = vi.hoisted(() => ({ etag: "v1" }));
vi.mock("@/lib/xray/cast", () => ({
  analysisTarget: async () => ({ itemId: "a".repeat(32), type: "Episode", path: "/m.mkv", etag: target.etag, seriesId: null, tmdb: { kind: "episode", tvId: 1, season: 1, episode: 1 } }),
  castOf: async () => [{ personId: 7, name: "Lucas Till", character: "Angus MacGyver", order: 0, profilePath: "/lt.jpg" }],
  tmdbPhotoUrl: (p: string) => `https://image.tmdb.org/t/p/w185${p}`,
}));
const mockFacts = vi.fn();
vi.mock("@/lib/xray/person", () => ({ personFactsForPlayer: (...a: unknown[]) => mockFacts(...a) }));
const mockLogError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => mockLogError(...a) }));

function req(): NextRequest {
  return { cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}
async function get(itemId = ITEM) {
  const { GET } = await import("@/app/api/player/xray/[itemId]/route");
  const res = await GET(req(), { params: Promise.resolve({ itemId }) });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(svc, { configured: true, audience: "tous", scenes: null, status: null, scenesError: null });
  target.etag = "v1";
  mockVerify.mockResolvedValue({ u: "louis", jfId: "f".repeat(32), jti: "j", role: "user" });
  mockVisible.mockResolvedValue(null);
});

describe("GET /api/player/xray/[itemId]", () => {
  it("réglée sur `admins` : `off` pour un compte ordinaire, sans rien lire ; les scènes pour un administrateur", async () => {
    svc.audience = "admins";
    svc.scenes = { itemId: ITEM, etag: "v1", model: "m", version: 1, complete: true, analyzedUntil: 10, scenes: [] };
    const user = await get();
    expect(user.body).toMatchObject({ status: "off", scenes: [] });
    expect(mockVisible).not.toHaveBeenCalled();
    mockVerify.mockResolvedValue({ u: "louis", jfId: "f".repeat(32), jti: "j", role: "admin" });
    expect((await get()).body.status).not.toBe("off");
  });

  it("joint les scènes à la distribution, en réponse privée", async () => {
    svc.scenes = {
      itemId: ITEM,
      etag: "v1",
      model: "buffalo_l",
      version: 1,
      complete: false,
      analyzedUntil: 900,
      scenes: [{ start: 750, end: 850.4, people: [{ personId: 7, screenTime: 41.2, confidence: 0.82 }, { personId: 99, screenTime: 3, confidence: 0.6 }] }],
    };
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toEqual({
      status: "running",
      complete: false,
      analyzedUntil: 900,
      scenes: [
        {
          start: 750,
          end: 850.4,
          people: [
            { personId: 7, name: "Lucas Till", character: "Angus MacGyver", photo: "https://image.tmdb.org/t/p/w185/lt.jpg", screenTime: 41.2, confidence: 0.82 },
            { personId: 99, name: null, character: null, photo: null, screenTime: 3, confidence: 0.6 },
          ],
        },
      ],
    });
  });

  it("rien d'analysé : 200, scenes vides, jamais 404", async () => {
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "none", complete: false, analyzedUntil: 0, scenes: [] });
  });

  it("en file : le dit, sans scènes", async () => {
    svc.status = { itemId: ITEM, etag: "v1", status: "queued", progress: 0, analyzedUntil: 0, error: null };
    expect((await get()).body).toMatchObject({ status: "queued", scenes: [] });
  });

  it("option coupée : 200 `off`, sans rien demander au service", async () => {
    svc.configured = false;
    svc.scenesError = new Error("ne doit pas être appelé");
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "off", scenes: [] });
  });

  it("un élément caché à ce compte répond comme un élément jamais analysé", async () => {
    mockVisible.mockResolvedValue(new NextResponse(null, { status: 404 }));
    svc.scenes = { etag: "v1", complete: true, analyzedUntil: 10, scenes: [{ start: 0, end: 1, people: [] }] };
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "none", complete: false, analyzedUntil: 0, scenes: [] });
  });

  it("un résultat d'une autre version du fichier n'est pas servi", async () => {
    target.etag = "v2";
    svc.scenes = { etag: "v1", complete: true, analyzedUntil: 10, scenes: [{ start: 0, end: 1, people: [] }] };
    expect((await get()).body).toMatchObject({ status: "stale", scenes: [] });
  });

  it("service injoignable : 200 `unavailable`, l'erreur au journal du serveur", async () => {
    svc.scenesError = new Error("ECONNREFUSED");
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "unavailable", scenes: [] });
    expect(mockLogError).toHaveBeenCalledWith("xray/scenes", expect.any(Error), expect.anything());
  });

  it("refuse un identifiant mal formé et une absence de session", async () => {
    expect((await get("../x")).res.status).toBe(400);
    mockVerify.mockResolvedValue(null);
    expect((await get()).res.status).toBe(401);
  });
});

describe("GET /api/player/xray/[itemId]?person= — un lien de partage (10.28.1)", () => {
  const withPerson = (): NextRequest =>
    ({ cookies: { get: () => ({ value: "t" }) }, nextUrl: new URL(`http://x/api/player/xray/${ITEM}?person=7`) }) as unknown as NextRequest;
  const facts = { status: "ok", personId: 7, birthday: "1990-08-10", placeOfBirth: "Fort Hood", bio: "Acteur.", library: [{ tmdbId: 1, mediaType: "movie", title: "Bumblebee", year: 2018, poster: null }] };
  async function person() {
    const { GET } = await import("@/app/api/player/xray/[itemId]/route");
    const res = await GET(withPerson(), { params: Promise.resolve({ itemId: ITEM }) });
    return (await res.json()) as Record<string, unknown>;
  }
  it("le panneau d'une personne : faits et courte biographie, jamais « Dans votre bibliothèque »", async () => {
    mockFacts.mockImplementation(async () => structuredClone(facts));
    mockVerify.mockResolvedValue({ u: "partage-1", jfId: "e".repeat(32), jti: "j", role: "share", sh: "s1" });
    const body = await person();
    expect(body).toMatchObject({ status: "ok", birthday: "1990-08-10", bio: "Acteur." });
    expect(body).not.toHaveProperty("library");
    expect(mockFacts).toHaveBeenCalledWith(ITEM, 7, "fr", "e".repeat(32), { library: false });
  });
  it("un compte du foyer garde ses autres titres", async () => {
    mockFacts.mockImplementation(async () => structuredClone(facts));
    const body = await person();
    expect((body.library as unknown[]).length).toBe(1);
    expect(mockFacts).toHaveBeenCalledWith(ITEM, 7, "fr", "f".repeat(32), { library: true });
  });
});
