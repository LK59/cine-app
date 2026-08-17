import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { enrichRequests } from "@/lib/jellyseerr-enrich";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  try {
    // Admin without Jellyfin: return all pending
    if (!session?.jfUser) {
      if (session?.role === "admin") {
        const data = await jellyseerr.getRequests("all", session?.jsCookie);
        const enriched = await enrichRequests(data.results);
        return NextResponse.json({ results: enriched });
      }
      return NextResponse.json({ results: [] });
    }

    // Own id via the session's own cookie when available — doesn't require admin-gated access
    // to the full user list, just a valid session for whoever is asking about themselves.
    let jsUserId: number | undefined;
    if (session.jsCookie) {
      jsUserId = (await jellyseerr.getMe(session.jsCookie).catch(() => null))?.id;
    }
    if (!jsUserId) {
      const usersData = await jellyseerr.getUsers(session.jsCookie).catch(() => ({ results: [] }));
      jsUserId = usersData.results.find(
        (u) => u.jellyfinUsername?.toLowerCase() === session.jfUser!.toLowerCase()
      )?.id;
    }

    if (!jsUserId) return NextResponse.json({ results: [] });

    const data = await jellyseerr.getRequestsByUser(jsUserId, session.jsCookie);
    const enriched = await enrichRequests(data.results);
    return NextResponse.json({ results: enriched });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
