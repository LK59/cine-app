import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => ({ jfId: "u1" }) }));
const mockEpisodes = vi.fn();
const mockNextUp = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getSeriesEpisodes: (...a: unknown[]) => mockEpisodes(...a),
    getNextUp: (...a: unknown[]) => mockNextUp(...a),
  },
}));

const req = { cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
const SERIES = "0123456789abcdef0123456789abcdef";
const params = { params: Promise.resolve({ jellyfinId: SERIES }) };

function ep(id: string, season: number, episode: number, played: boolean) {
  return { Id: id, Name: `Épisode ${episode}`, ParentIndexNumber: season, IndexNumber: episode, RunTimeTicks: 25_000_000_000, UserData: { Played: played } };
}

beforeEach(() => vi.clearAllMocks());

/**
 * Une série marquée vue en entier : Jellyfin ne propose plus rien « à suivre », et le bouton Lire
 * des fiches disparaissait avec (22/09/2026). La route propose alors de la relancer au début.
 */
describe("GET /api/cinema/series/[id]/episodes — l'épisode à lire", () => {
  it("repart du premier épisode, au début, quand tout a été vu", async () => {
    mockEpisodes.mockResolvedValue([ep("s0e1", 0, 1, false), ep("s2e1", 2, 1, true), ep("s1e2", 1, 2, true), ep("s1e1", 1, 1, true)]);
    mockNextUp.mockResolvedValue(null);
    const { GET } = await import("@/app/api/cinema/series/[jellyfinId]/episodes/route");
    const body = await (await GET(req, params)).json();
    // Les spéciaux (saison 0) ne comptent pas : S1 E1, depuis le début, en revisionnage.
    expect(body.nextEpisode).toMatchObject({ itemId: "s1e1", seasonNumber: 1, episodeNumber: 1, resumeTicks: 0, rewatch: true });
  });

  it("garde l'« à suivre » de Jellyfin quand il y en a un", async () => {
    mockEpisodes.mockResolvedValue([ep("s1e1", 1, 1, true), ep("s1e2", 1, 2, false)]);
    mockNextUp.mockResolvedValue(ep("s1e2", 1, 2, false));
    const { GET } = await import("@/app/api/cinema/series/[jellyfinId]/episodes/route");
    const body = await (await GET(req, params)).json();
    expect(body.nextEpisode).toMatchObject({ itemId: "s1e2" });
    expect(body.nextEpisode.rewatch).toBeUndefined();
  });

  it("ne renvoie pas au début quelqu'un en cours de série quand Jellyfin ne répond pas", async () => {
    mockEpisodes.mockResolvedValue([ep("s1e1", 1, 1, true), ep("s3e1", 3, 1, false)]);
    mockNextUp.mockRejectedValue(new Error("panne"));
    const { GET } = await import("@/app/api/cinema/series/[jellyfinId]/episodes/route");
    const body = await (await GET(req, params)).json();
    expect(body.nextEpisode).toBeNull();
  });
});
