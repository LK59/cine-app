import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";

const { url, apiKey } = config.jellyseerr;
const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };

// This fork (seerr-team/seerr, confirmed live against this instance — even /api/v1/settings/main
// and /api/v1/user 403 with the master key alone) restricts several endpoints to a genuine
// session cookie; the admin X-Api-Key is no longer sufficient by itself for user-attributed
// actions like creating a request. `cookie`, when provided, is the raw connect.sid value
// obtained via login() at cine-app sign-in time (see /api/auth/jellyfin) and takes priority over
// the API key. Falling back to the API key when no cookie is available (local-admin login, which
// has no Jellyfin identity to authenticate to Jellyseerr with, or a failed Jellyseerr login at
// sign-in time) keeps the previous best-effort behavior instead of a hard failure.
function authHeaders(cookie?: string): Record<string, string> {
  if (cookie) return { Cookie: `connect.sid=${cookie}`, "Content-Type": "application/json" };
  return headers;
}

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
  // Authenticates AS the given Jellyfin user against Jellyseerr's own Jellyfin-SSO login
  // (Jellyseerr auto-provisions/links an account the first time a Jellyfin user logs in there,
  // same as logging into its own web UI) — returns the raw connect.sid cookie value (already
  // URL-encoded exactly as Set-Cookie sent it; reused verbatim, never re-encoded/decoded) or
  // null on failure. Best-effort: callers must not let a Jellyseerr outage block a cine-app
  // login, since cine-app's own auth is against Jellyfin, not Jellyseerr.
  login: async (username: string, password: string): Promise<string | null> => {
    try {
      const res = await fetch(`${url}/api/v1/auth/jellyfin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) return null;
      const setCookies =
        typeof res.headers.getSetCookie === "function"
          ? res.headers.getSetCookie()
          : [res.headers.get("set-cookie") ?? ""];
      for (const c of setCookies) {
        const match = c.match(/connect\.sid=([^;]+)/);
        if (match) return match[1];
      }
      return null;
    } catch {
      return null;
    }
  },
  // The currently-authenticated user's own Jellyseerr profile (via the session cookie) —
  // preferred over getUsers() for "what's my own Jellyseerr id" since listing all users is
  // itself admin-gated and would fail for an ordinary user's own cookie.
  getMe: (cookie: string) =>
    fetchJson<JellyseerrUser>(`${url}/api/v1/auth/me`, { headers: authHeaders(cookie) }),
  getStatus: () => fetchJson<{ version: string }>(`${url}/api/v1/status`, { headers }),
  getRequests: (filter: "pending" | "approved" | "all" = "pending", cookie?: string) =>
    fetchJson<{ results: JellyseerrRequest[]; pageInfo: { results: number } }>(
      `${url}/api/v1/request?filter=${filter}&take=25&sort=added`,
      { headers: authHeaders(cookie) }
    ),
  getRequestsByUser: (userId: number, cookie?: string) =>
    fetchJson<{ results: JellyseerrRequest[]; pageInfo: { results: number } }>(
      `${url}/api/v1/request?filter=all&requestedBy=${userId}&take=50&sort=added`,
      { headers: authHeaders(cookie) }
    ),
  getUsers: (cookie?: string) =>
    fetchJson<{ results: JellyseerrUser[] }>(
      `${url}/api/v1/user?take=200&skip=0`,
      { headers: authHeaders(cookie) }
    ),
  approveRequest: (id: number, cookie?: string) =>
    fetchJson<void>(`${url}/api/v1/request/${id}/approve`, { method: "POST", headers: authHeaders(cookie) }),
  declineRequest: (id: number, cookie?: string) =>
    fetchJson<void>(`${url}/api/v1/request/${id}/decline`, { method: "POST", headers: authHeaders(cookie) }),
  // No `userId` when a cookie is supplied — the session already identifies the requester to
  // Jellyseerr, so passing one would be redundant (and userId-as-another-user is itself the
  // admin-only "request on behalf of" path this whole change moves away from).
  // `seasons` is what a TV request was missing entirely before (root cause of the "Cannot read
  // properties of undefined (reading 'filter')" crash reported live) — Jellyseerr's own request
  // handler processes it as an array of season numbers for a `mediaType: "tv"` request; omitted
  // entirely for movies, which have no such concept.
  createRequest: (
    mediaType: "movie" | "tv",
    mediaId: number,
    userId?: number,
    cookie?: string,
    seasons?: number[]
  ) =>
    fetchJson<{ id: number }>(`${url}/api/v1/request`, {
      method: "POST",
      headers: authHeaders(cookie),
      body: JSON.stringify({
        mediaType,
        mediaId,
        ...(seasons ? { seasons } : {}),
        ...(cookie ? {} : userId != null ? { userId } : {}),
      }),
    }),
  getMovieMedia: (tmdbId: number, cookie?: string) =>
    fetchJson<{ title?: string; posterPath?: string | null; mediaInfo?: { status: number } }>(
      `${url}/api/v1/movie/${tmdbId}`, { headers: authHeaders(cookie) }
    ),
  // `seasons` (TMDB-sourced: number/name/episodeCount per season) and `mediaInfo.seasons`
  // (Jellyseerr's own per-season request/availability status, same MediaStatus enum as the
  // overall `mediaInfo.status`) are both present on the real response — verified live against
  // this instance — but were previously untyped/unused since nothing needed per-season detail.
  getTvMedia: (tmdbId: number, cookie?: string) =>
    fetchJson<{
      name?: string;
      posterPath?: string | null;
      seasons?: { seasonNumber: number; name?: string; episodeCount?: number }[];
      mediaInfo?: { status: number; seasons?: { seasonNumber: number; status: number }[] };
    }>(`${url}/api/v1/tv/${tmdbId}`, { headers: authHeaders(cookie) }),
};
