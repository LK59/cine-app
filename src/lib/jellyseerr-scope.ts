import { jellyseerr, type JellyseerrRequest } from "@/lib/clients/jellyseerr";
import type { SessionPayload } from "@/lib/auth";
import { resolveJellyseerrIdentity, type JellyseerrIdentity } from "@/lib/jellyseerrIdentity";

// Jellyseerr's own Request.status enum (distinct from the Media-level status used elsewhere in
// this app — e.g. MediaStatus on mediaInfo): 1=pending approval, 2=approved, 3=declined.
const REQUEST_PENDING = 1;

// Who "mine" is — see `jellyseerrIdentity.ts`. This used to need the session cookie, and read
// "nothing" for anyone whose session had none.
async function ownIdentity(session: SessionPayload | null): Promise<JellyseerrIdentity> {
  return session ? resolveJellyseerrIdentity(session) : { userId: null };
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
  const { userId, cookie } = await ownIdentity(session);
  if (userId == null) return 0;
  const mine = await jellyseerr.getRequestsByUser(userId, cookie);
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
  const { userId, cookie } = await ownIdentity(session);
  if (userId == null) return [];
  const mine = await jellyseerr.getRequestsByUser(userId, cookie).catch(() => ({ results: [] }));
  return mine.results.slice(0, limit);
}
