import { jellyseerr, type JellyseerrRequest } from "@/lib/clients/jellyseerr";
import type { SessionPayload } from "@/lib/auth";

// Jellyseerr's own Request.status enum (distinct from the Media-level status used elsewhere in
// this app — e.g. MediaStatus on mediaInfo): 1=pending approval, 2=approved, 3=declined.
const REQUEST_PENDING = 1;

// Resolves the caller's own Jellyseerr numeric id via their session cookie — needed to scope "my
// own requests" for a non-admin user. Listing every user's requests (like an admin can) is
// itself gated on this fork, so there's no other way to find "mine" for an ordinary account.
async function resolveOwnJellyseerrId(session: SessionPayload | null): Promise<number | null> {
  if (!session?.jsCookie) return null;
  const me = await jellyseerr.getMe(session.jsCookie).catch(() => null);
  return me?.id ?? null;
}

// Admin: the instance-wide count of requests still needing a decision — what they're actually
// there to manage. Everyone else: only their own still-pending requests, matching what they can
// see of their own account anyway (and Jellyseerr's own permission model, which doesn't let an
// ordinary account list anyone else's requests).
export async function getJellyseerrPendingCount(session: SessionPayload | null): Promise<number> {
  if (session?.role === "admin") {
    const pending = await jellyseerr.getRequests("pending", session.jsCookie);
    return pending.pageInfo?.results ?? pending.results.length;
  }
  const ownId = await resolveOwnJellyseerrId(session);
  if (ownId == null) return 0;
  const mine = await jellyseerr.getRequestsByUser(ownId, session?.jsCookie);
  return mine.results.filter((r) => r.status === REQUEST_PENDING).length;
}

// Same admin/self split for the activity feed — an ordinary user seeing a stream of everyone
// else's requests (with their display names attached) was never really appropriate, matches the
// scoping already applied to the dedicated "my requests" list on /jellyseerr.
export async function getJellyseerrActivityItems(
  session: SessionPayload | null,
  limit: number
): Promise<JellyseerrRequest[]> {
  if (session?.role === "admin") {
    const all = await jellyseerr.getRequests("all", session.jsCookie).catch(() => ({ results: [] }));
    return all.results.slice(0, limit);
  }
  const ownId = await resolveOwnJellyseerrId(session);
  if (ownId == null) return [];
  const mine = await jellyseerr.getRequestsByUser(ownId, session?.jsCookie).catch(() => ({ results: [] }));
  return mine.results.slice(0, limit);
}
