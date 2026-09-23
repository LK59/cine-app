import { NextRequest, NextResponse } from "next/server";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { enrichRequests } from "@/lib/jellyseerr-enrich";
import { withErrorHandling } from "@/lib/api-helpers";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { pendingRequestDb } from "@/lib/db";
import { resolveJellyseerrIdentity } from "@/lib/jellyseerrIdentity";

export async function GET(req: NextRequest) {
  const filter = (req.nextUrl.searchParams.get("filter") as "pending" | "approved" | "all") || "pending";
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  if (session && session.role !== "admin" && session.jfUser) {
    return withErrorHandling(async () => {
      // Who "mine" is — see `jellyseerrIdentity.ts`.
      const { userId, cookie } = await resolveJellyseerrIdentity(session);
      if (userId == null) return { results: [], pageInfo: { results: 0 } };
      const data = await jellyseerr.getRequestsByUser(userId, cookie);
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

  // Au nom de qui — see `jellyseerrIdentity.ts`. The local-admin login has no identity at all,
  // and its requests go out under the key's owner, which is that same administrator.
  const identity = session ? await resolveJellyseerrIdentity(session) : { userId: null };

  return withErrorHandling(async () => {
    const result = await jellyseerr.createRequest(
      mediaType,
      mediaId,
      identity.cookie ? undefined : identity.userId ?? undefined,
      identity.cookie,
      seasons,
    );
    trackForAvailability();
    return result;
  });
}
