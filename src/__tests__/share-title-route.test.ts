import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * `GET /api/share/title` (DECISIONS.md §112) : la carte du titre d'un lien, pour sa seule session, et
 * le décompte des lectures prises ailleurs. Le choix de la carte lui-même est testé plus bas, sur
 * `shareTitleEntry` : un seul titre, celui du lien, construit par les fonctions du catalogue.
 */

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

const MOVIE = "a".repeat(32);
const EXPIRES = Date.now() + 86_400_000;
const shares = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@/lib/share/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/share/store")>();
  return { ...real, sharesDb: { get: () => shares.current } };
});
const playing = vi.hoisted(() => ({ jtis: [] as string[], asked: [] as string[] }));
vi.mock("@/lib/activity/presence", () => ({
  playingSessionsOf: (user: string) => {
    playing.asked.push(user);
    return playing.jtis;
  },
}));
const entry = vi.hoisted(() => ({ value: null as unknown, calls: [] as unknown[][] }));
vi.mock("@/lib/share/title", () => ({
  shareTitleEntry: async (...args: unknown[]) => {
    entry.calls.push(args);
    if (entry.value instanceof Error) throw entry.value;
    return entry.value;
  },
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

const share = (over: Record<string, unknown> = {}) => ({
  id: "0123456789abcdef",
  code: "abcdefghjk",
  kind: "movie",
  itemId: MOVIE,
  radarrId: 12,
  sonarrId: null,
  expiresAt: EXPIRES,
  revokedAt: null,
  maxStreams: 3,
  jfUserId: "f".repeat(32),
  jfDeletedAt: null,
  ...over,
});
const shareSession = { u: "partage-01234567", jfUser: "partage-01234567", role: "share", sh: "0123456789abcdef", jti: "moi", exp: EXPIRES };

function req(): NextRequest {
  return { cookies: { get: () => ({ value: "t" }) }, headers: new Headers({ cookie: "cine-lang=en" }) } as unknown as NextRequest;
}
const get = async () => (await import("@/app/api/share/title/route")).GET(req());

beforeEach(() => {
  shares.current = share();
  playing.jtis = [];
  playing.asked = [];
  entry.value = { radarrId: 12, jellyfinItemId: MOVIE, title: "Le film" };
  entry.calls = [];
  mockVerify.mockResolvedValue(shareSession);
});

describe("GET /api/share/title", () => {
  it("rend la carte du titre du lien, sa fin et ses lectures — dans la langue de la page", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({
      kind: "movie",
      item: { radarrId: 12, jellyfinItemId: MOVIE, title: "Le film" },
      expiresAt: EXPIRES,
      maxStreams: 3,
      playingElsewhere: 0,
    });
    expect(entry.calls[0][0]).toMatchObject({ kind: "movie", itemId: MOVIE });
    expect(entry.calls[0][1]).toBe("en");
  });

  it("compte les autres appareils du lien qui jouent, pas celui qui demande", async () => {
    playing.jtis = ["moi", "tablette", "tele"];
    const body = await (await get()).json();
    expect(body.playingElsewhere).toBe(2);
    // La même clé que la garde des lectures (`shareStreamRefusal`) : le compte Jellyfin du lien.
    expect(playing.asked).toEqual(["partage-01234567"]);
  });

  it("refuse tout compte du foyer — administrateur compris — et toute requête sans session", async () => {
    for (const role of ["user", "admin"]) {
      mockVerify.mockResolvedValue({ u: "mathis", role, jti: "k", exp: EXPIRES });
      const res = await get();
      expect(res.status, role).toBe(403);
      expect((await res.json()).code).toBe("share-scope");
    }
    mockVerify.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(entry.calls).toEqual([]);
  });

  it("refuse un lien révoqué, passé ou inconnu, sans rien construire", async () => {
    for (const over of [{ revokedAt: Date.now() }, { expiresAt: Date.now() - 1 }, { jfDeletedAt: Date.now() }]) {
      shares.current = share(over);
      expect((await get()).status).toBe(403);
    }
    shares.current = null;
    expect((await get()).status).toBe(403);
    expect(entry.calls).toEqual([]);
  });

  it("un titre que le catalogue ne montre plus : 404 nommé", async () => {
    entry.value = null;
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("title_not_found");
  });

  it("une panne amont se nomme, elle ne sort pas en 500 nu", async () => {
    entry.value = new Error("Radarr injoignable");
    const res = await get();
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
