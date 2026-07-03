import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { enrichRequests } from "@/lib/jellyseerr-enrich";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);

  try {
    // Admin without Jellyfin: return all pending
    if (!session?.jfUser) {
      if (session?.role === "admin") {
        const data = await jellyseerr.getRequests("all");
        const enriched = await enrichRequests(data.results);
        return NextResponse.json({ results: enriched });
      }
      return NextResponse.json({ results: [] });
    }

    // Match Jellyfin username to Jellyseerr user
    const usersData = await jellyseerr.getUsers().catch(() => ({ results: [] }));
    const jsUser = usersData.results.find(
      (u) => u.jellyfinUsername?.toLowerCase() === session.jfUser!.toLowerCase()
    );

    if (!jsUser) return NextResponse.json({ results: [] });

    const data = await jellyseerr.getRequestsByUser(jsUser.id);
    const enriched = await enrichRequests(data.results);
    return NextResponse.json({ results: enriched });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
