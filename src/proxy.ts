import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

// Next.js 16's Proxy (formerly "middleware") always runs on the Node.js runtime — unlike the old
// Edge-only middleware, so verifySessionFull's better-sqlite3-backed revocation check (a native
// module, impossible under Edge) is safe to call directly here. Previously this used the
// Edge-compatible verifySessionToken (signature + expiry only), which meant logout only cleared
// the cookie client-side and deleted the DB row, but every route that doesn't individually call
// verifySessionFull relied solely on this gate — so a revoked session (logged out, or
// force-expired) stayed fully usable against most of the app for up to its full 7-day lifetime.

const PUBLIC_PATHS = [
  "/login",
  "/status",
  "/api/auth/login",
  "/api/auth/jellyfin",
  "/api/status/public",
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

// The guest role is read-only everywhere except playback tracking, managing their own
// watchlist, requesting a movie/series through Jellyseerr (tracked/attributed — see
// /api/jellyseerr/requests), and logging out. Every other mutation (delete, quality/monitored
// changes, interactive/auto search, adding new content directly to Radarr/Sonarr, qBittorrent
// actions, Jellyseerr approve/decline, Bazarr subtitle download, Jackett test...) is blocked
// here, server-side, regardless of what the UI shows.
//
// "POST /api/radarr/movies" and "POST /api/sonarr/series" (direct library add, monitored,
// immediate auto-search — distinct from the Jellyseerr request flow above) used to be listed
// here. They were removed after finding their UI buttons were never gated by isReadOnly either:
// any guest could add arbitrary new content straight into Radarr/Sonarr, bypassing the whole
// per-user request/attribution system entirely. Both the buttons and this whitelist entry were
// the two halves of the same bug — see AddMovieModal/AddSeriesModal in radarr/page.tsx and
// sonarr/page.tsx.
const GUEST_ALLOWED_MUTATIONS = new Set([
  "POST /api/auth/logout",
  "POST /api/jellyfin/played",
  "POST /api/jellyfin/playback/start",
  "POST /api/player/log",
  "POST /api/jellyfin/playback/playing",
  "POST /api/jellyfin/playback/progress",
  "POST /api/jellyfin/playback/stop",
  "POST /api/jellyseerr/requests",
  // Watchlist is per-user: guests can manage their own list
  "POST /api/watchlist",
  "DELETE /api/watchlist",
  "PATCH /api/watchlist/item",
]);

/**
 * Le mode cinéma est devenu le lecteur, avec sa propre coquille et sa propre adresse. L'ancienne
 * reste valable — pour les liens partagés, les onglets ouverts et les raccourcis installés sur un
 * écran d'accueil.
 */
const MOVED_PATHS: Record<string, string> = {
  "/cinema": "/player",
};

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/")) ||
    pathname.startsWith("/_next") ||
    isPublicClaraPhoto(pathname)
  ) {
    return NextResponse.next();
  }

  // Les adresses qui ont déménagé, redirigées ici plutôt que par la page elle-même.
  //
  // `redirect()` dans un composant serveur imbriqué ne produit pas de 307 : la coquille du
  // tableau de bord a déjà commencé à être envoyée, et le navigateur reçoit une page complète
  // qui lui demande ensuite d'aller ailleurs — donc un éclair de barre latérale avant d'arriver
  // au lecteur. Ici, rien n'a encore été rendu.
  //
  // Le fragment est concaténé par acquit de conscience : un navigateur ne l'envoie jamais au
  // serveur, et le réapplique de lui-même quand la nouvelle adresse n'en porte pas. La ligne est
  // donc sans effet en pratique, et juste si quelque chose venait un jour à le transmettre.
  const moved = MOVED_PATHS[pathname];
  if (moved) return NextResponse.redirect(new URL(moved + req.nextUrl.hash, req.url), 308);

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (
    session.role !== "admin" &&
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
