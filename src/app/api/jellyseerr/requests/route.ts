import { NextRequest, NextResponse } from "next/server";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { enrichRequests } from "@/lib/jellyseerr-enrich";
import { withErrorHandling } from "@/lib/api-helpers";
import { SESSION_COOKIE, type SessionPayload } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { withCache } from "@/lib/server-cache";
import { pendingRequestDb } from "@/lib/db";

const USERS_TTL = 5 * 60_000; // 5 min — user list rarely changes

async function getJellyseerrUsers(cookie?: string) {
  return withCache("jellyseerr:users", USERS_TTL, () => jellyseerr.getUsers(cookie));
}

// Legacy fallback (no session cookie — local-admin login, or the Jellyseerr login at sign-in
// failed): resolves via the master API key's own user list, which this Jellyseerr fork may or
// may not still permit depending on the calling key's own account permissions.
async function resolveJellyseerrUserId(jfUser: string): Promise<number | undefined> {
  try {
    const usersData = await getJellyseerrUsers();
    return usersData.results.find(
      (u) => u.jellyfinUsername?.toLowerCase() === jfUser.toLowerCase()
    )?.id;
  } catch {
    return undefined;
  }
}

// Own id via the session's own cookie — doesn't require the admin-gated full user list, just a
// valid session for whoever is asking about themselves.
async function resolveOwnUserId(session: SessionPayload): Promise<number | undefined> {
  if (session.jsCookie) {
    const me = await jellyseerr.getMe(session.jsCookie).catch(() => null);
    if (me?.id) return me.id;
  }
  return session.jfUser ? resolveJellyseerrUserId(session.jfUser) : undefined;
}

export async function GET(req: NextRequest) {
  const filter = (req.nextUrl.searchParams.get("filter") as "pending" | "approved" | "all") || "pending";
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  if (session && session.role !== "admin" && session.jfUser) {
    return withErrorHandling(async () => {
      const jellyseerrUserId = await resolveOwnUserId(session);
      if (!jellyseerrUserId) return { results: [], pageInfo: { results: 0 } };
      const data = await jellyseerr.getRequestsByUser(jellyseerrUserId, session.jsCookie);
      return { ...data, results: await enrichRequests(data.results) };
    });
  }

  return withErrorHandling(async () => {
    const data = await jellyseerr.getRequests(filter, session?.jsCookie);
    return { ...data, results: await enrichRequests(data.results) };
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const mediaType = body?.mediaType as "movie" | "tv" | undefined;
  const mediaId = body?.mediaId as number | undefined;
  // Required for "tv" — Jellyseerr's own request handler crashes without it (root cause of the
  // "Cannot read properties of undefined (reading 'filter')" 500 reported live: a tv request was
  // being sent with no seasons field at all). Never sent for "movie", which has no such concept.
  const seasons = Array.isArray(body?.seasons) ? (body.seasons as number[]) : undefined;

  if (!mediaType || !mediaId) {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }
  if (mediaType === "tv" && (!seasons || seasons.length === 0)) {
    return NextResponse.json({ error: "Sélectionne au moins une saison" }, { status: 400 });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  // Recorded once the request actually succeeds below — this is what lets
  // checkRequestAvailability() later notify exactly this person (and only them) once it's ready,
  // without ever having to ask Jellyseerr itself "whose request was this" again.
  function trackForAvailability() {
    if (!session?.u) return;
    pendingRequestDb.add(session.u, mediaType === "tv" ? "series" : "movie", mediaId!, seasons ?? null);
  }

  // With a session cookie, Jellyseerr already knows who's asking — no userId override needed
  // (that override was itself the admin-only "request on behalf of" path this fork now blocks
  // for anything but a genuinely authenticated session).
  if (session?.jsCookie) {
    return withErrorHandling(async () => {
      const result = await jellyseerr.createRequest(mediaType, mediaId, undefined, session.jsCookie, seasons);
      trackForAvailability();
      return result;
    });
  }

  const jellyseerrUserId = session?.jfUser
    ? await resolveJellyseerrUserId(session.jfUser)
    : undefined;

  return withErrorHandling(async () => {
    const result = await jellyseerr.createRequest(mediaType, mediaId, jellyseerrUserId, undefined, seasons);
    trackForAvailability();
    return result;
  });
}
