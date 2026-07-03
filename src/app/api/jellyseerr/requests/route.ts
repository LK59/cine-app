import { NextRequest, NextResponse } from "next/server";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { enrichRequests } from "@/lib/jellyseerr-enrich";
import { withErrorHandling } from "@/lib/api-helpers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const filter = (req.nextUrl.searchParams.get("filter") as "pending" | "approved" | "all") || "pending";
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);

  if (session?.role === "guest" && session.jfUser) {
    return withErrorHandling(async () => {
      const usersData = await jellyseerr.getUsers();
      const match = usersData.results.find(
        (u) => u.jellyfinUsername?.toLowerCase() === session.jfUser!.toLowerCase()
      );
      if (!match) return { results: [], pageInfo: { results: 0 } };
      const data = await jellyseerr.getRequestsByUser(match.id);
      return { ...data, results: await enrichRequests(data.results) };
    });
  }

  return withErrorHandling(async () => {
    const data = await jellyseerr.getRequests(filter);
    return { ...data, results: await enrichRequests(data.results) };
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const mediaType = body?.mediaType as "movie" | "tv" | undefined;
  const mediaId = body?.mediaId as number | undefined;

  if (!mediaType || !mediaId) {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }

  return withErrorHandling(() => jellyseerr.createRequest(mediaType, mediaId));
}
