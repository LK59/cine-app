import { NextRequest, NextResponse } from "next/server";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { enrichRequests } from "@/lib/jellyseerr-enrich";
import { withErrorHandling } from "@/lib/api-helpers";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { withCache } from "@/lib/server-cache";

const USERS_TTL = 5 * 60_000; // 5 min — user list rarely changes

async function getJellyseerrUsers() {
  return withCache("jellyseerr:users", USERS_TTL, () => jellyseerr.getUsers());
}

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

export async function GET(req: NextRequest) {
  const filter = (req.nextUrl.searchParams.get("filter") as "pending" | "approved" | "all") || "pending";
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  if (session?.role === "guest" && session.jfUser) {
    return withErrorHandling(async () => {
      const jellyseerrUserId = await resolveJellyseerrUserId(session.jfUser!);
      if (!jellyseerrUserId) return { results: [], pageInfo: { results: 0 } };
      const data = await jellyseerr.getRequestsByUser(jellyseerrUserId);
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

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  const jellyseerrUserId = session?.jfUser
    ? await resolveJellyseerrUserId(session.jfUser)
    : undefined;

  return withErrorHandling(() => jellyseerr.createRequest(mediaType, mediaId, jellyseerrUserId));
}
