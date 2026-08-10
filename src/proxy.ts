import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/jellyfin",
  "/api/health",
  "/api/config/public",
  "/api/push/vapid-key",
];

// The slideshow page (/random, og:image preview + <img> tags) and the individual photo files it
// hotlinks (/[filename]) both need to work for an anonymous visitor of clara.kakol.fr. The list
// endpoint (/api/gallery/clara, no trailing segment) is deliberately excluded: it's what lets
// someone enumerate the whole gallery in one call, and is only used by the in-app authenticated
// person page.
function isPublicClaraPhoto(pathname: string): boolean {
  return pathname !== "/api/gallery/clara" && pathname.startsWith("/api/gallery/clara/");
}

// The guest role is read-only everywhere except requesting a new movie/series
// (the Radarr/Sonarr "add" endpoints) and logging out. Every other mutation
// (delete, quality/monitored changes, interactive search & grab, qBittorrent
// actions, Jellyseerr approve/decline, Bazarr subtitle download, Jackett
// test...) is blocked here, server-side, regardless of what the UI shows.
const GUEST_ALLOWED_MUTATIONS = new Set([
  "POST /api/radarr/movies",
  "POST /api/sonarr/series",
  "POST /api/auth/logout",
  "POST /api/jellyfin/played",
  "POST /api/jellyseerr/requests",
  // Watchlist is per-user: guests can manage their own list
  "POST /api/watchlist",
  "DELETE /api/watchlist",
  "PATCH /api/watchlist/item",
]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/")) ||
    pathname.startsWith("/_next") ||
    isPublicClaraPhoto(pathname)
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (
    session.role === "guest" &&
    pathname.startsWith("/api/") &&
    req.method !== "GET" &&
    !GUEST_ALLOWED_MUTATIONS.has(`${req.method} ${pathname}`)
  ) {
    return NextResponse.json({ error: "Action réservée à l'administrateur" }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icon-192.png|icon-512.png|icon.svg|apple-touch-icon.png|favicon-32.png).*)",
  ],
};
