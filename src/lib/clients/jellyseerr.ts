import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";

const { url, apiKey } = config.jellyseerr;
const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };

export interface JellyseerrRequest {
  id: number;
  status: number;
  media: { title?: string; tmdbId?: number; mediaType: string; posterPath?: string };
  type: string;
  createdAt: string;
  requestedBy: { id?: number; displayName?: string; username?: string };
}

export interface JellyseerrUser {
  id: number;
  displayName: string;
  jellyfinUsername?: string;
}

export const jellyseerr = {
  getStatus: () => fetchJson<{ version: string }>(`${url}/api/v1/status`, { headers }),
  getRequests: (filter: "pending" | "approved" | "all" = "pending") =>
    fetchJson<{ results: JellyseerrRequest[]; pageInfo: { results: number } }>(
      `${url}/api/v1/request?filter=${filter}&take=25&sort=added`,
      { headers }
    ),
  getRequestsByUser: (userId: number) =>
    fetchJson<{ results: JellyseerrRequest[]; pageInfo: { results: number } }>(
      `${url}/api/v1/request?filter=all&requestedBy=${userId}&take=50&sort=added`,
      { headers }
    ),
  getUsers: () =>
    fetchJson<{ results: JellyseerrUser[] }>(
      `${url}/api/v1/user?take=200&skip=0`,
      { headers }
    ),
  approveRequest: (id: number) =>
    fetchJson<void>(`${url}/api/v1/request/${id}/approve`, { method: "POST", headers }),
  declineRequest: (id: number) =>
    fetchJson<void>(`${url}/api/v1/request/${id}/decline`, { method: "POST", headers }),
  createRequest: (mediaType: "movie" | "tv", mediaId: number) =>
    fetchJson<{ id: number }>(`${url}/api/v1/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaType, mediaId }),
    }),
  getMovieMedia: (tmdbId: number) =>
    fetchJson<{ title?: string; posterPath?: string | null; mediaInfo?: { status: number } }>(
      `${url}/api/v1/movie/${tmdbId}`, { headers }
    ),
  getTvMedia: (tmdbId: number) =>
    fetchJson<{ name?: string; posterPath?: string | null; mediaInfo?: { status: number } }>(
      `${url}/api/v1/tv/${tmdbId}`, { headers }
    ),
};
