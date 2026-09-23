import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { enrichRequests } from "@/lib/jellyseerr-enrich";
import { resolveJellyseerrIdentity } from "@/lib/jellyseerrIdentity";

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

    // Who "mine" is — see `jellyseerrIdentity.ts`.
    const { userId, cookie } = await resolveJellyseerrIdentity(session);
    if (userId == null) return NextResponse.json({ results: [] });

    const data = await jellyseerr.getRequestsByUser(userId, cookie);
    const enriched = await enrichRequests(data.results);
    return NextResponse.json({ results: enriched });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
