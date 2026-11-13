import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionPayload } from "@/lib/auth";

/**
 * « Mes demandes » ne lisait que les 50 demandes les plus récentes du compte (13/11/2026) : au-delà, une
 * demande toujours en traitement disparaissait de l'écran — onze ce jour-là, chez quatre comptes.
 */

const getRequestsByUser = vi.fn();
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: { getRequestsByUser: (...a: unknown[]) => getRequestsByUser(...a) } }));
vi.mock("@/lib/jellyseerrIdentity", () => ({ resolveJellyseerrIdentity: async () => ({ userId: 3, cookie: undefined }) }));
vi.mock("@/lib/server-cache", () => ({
  cachedMovieInfo: async () => ({ title: "Film", releaseDate: "2020-01-01" }),
  cachedTvInfo: async () => ({ name: "Série", firstAirDate: "2020-01-01" }),
}));
vi.mock("@/lib/playerLibrary", () => ({ playableLibrary: async () => ({}), playableId: () => null }));

const at = (i: number) => new Date(Date.UTC(2026, 10, 1) - i * 86_400_000).toISOString();
/** `i` : rang chez Jellyseerr (les plus récentes d'abord). */
function request(i: number, status: number, mediaStatus: number) {
  return { id: 1000 - i, status, createdAt: at(i), updatedAt: at(i), type: "movie", media: { tmdbId: 5000 + i, mediaType: "movie", status: mediaStatus } };
}

beforeEach(() => getRequestsByUser.mockReset());

describe("getPlayerRequests", () => {
  it("garde une demande en cours au-delà des cinquante plus récentes", async () => {
    const recent = Array.from({ length: 50 }, (_, i) => request(i, 2, 5));
    // Jellyseerr rend ce que `take` demande, 50 quand il n'est pas dit (la page d'avant).
    getRequestsByUser.mockImplementation(async (_id: number, _cookie: unknown, take = 50) => ({
      results: [...recent, request(50, 2, 3), request(51, 2, 5), request(52, 3, 1)].slice(0, take),
    }));
    const { getPlayerRequests } = await import("@/lib/playerRequests");
    const list = await getPlayerRequests({ u: "lucas", role: "user", jti: "j" } as SessionPayload);
    const ids = new Set(list.map((r) => r.id));
    // L'ancienne demande encore en traitement est là, et en tête (« ce qu'on attend d'abord »).
    expect(ids.has(950)).toBe(true);
    expect(list[0].id).toBe(950);
    // Les closes d'au-delà restent dehors : arrivée, refusée.
    expect(ids.has(949)).toBe(false);
    expect(ids.has(948)).toBe(false);
    expect(list).toHaveLength(51);
  });
});

describe("requestsToShow", () => {
  it("garde les plus récentes quel que soit leur état", async () => {
    const { requestsToShow } = await import("@/lib/playerRequests");
    const all = [request(0, 3, 1), request(1, 2, 5), request(2, 2, 3), request(3, 2, 4)];
    expect(requestsToShow(all as never, 2).map((r) => r.id)).toEqual([1000, 999, 998]);
  });
});
