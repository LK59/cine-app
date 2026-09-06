import { NextRequest, NextResponse } from "next/server";
// `appConfig` et non `config` : le bas de ce fichier exporte déjà une constante nommée
// `config`, qui est la configuration du proxy lui-même.
import { config as appConfig } from "@/lib/config";
import { SESSION_COOKIE, SESSION_MAX_AGE, refreshSessionToken, shouldRefresh } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { sessionDb } from "@/lib/db";

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
  // Le lecteur : ce que chacun fait sur son propre compte et sur ses propres listes.
  //
  // Ces routes ont été écrites après cette liste et n'y avaient pas été ajoutées : côté
  // utilisateur, « Demander », le cœur des favoris, la langue des sous-titres et le changement de
  // mot de passe répondaient tous 403. Invisible en administrateur, c'est-à-dire invisible pour
  // celui qui teste.
  "POST /api/player/requests",
  "POST /api/jellyfin/favorite",
  "POST /api/player/account/preferences",
  "POST /api/player/account/password",
  // Trouvées à la revue précédant la bascule, et du même tonneau que les quatre précédentes : le
  // panneau « Compte » montre à tout le monde un interrupteur de notifications et un bouton
  // « déconnecter mes autres appareils », et les deux répondaient 403 à un compte ordinaire. Les
  // trois routes n'agissent que sur l'appelant — la souscription est rangée sous son nom, les
  // sessions supprimées sont les siennes — donc les ouvrir n'ouvre rien d'autre.
  "POST /api/push/subscribe",
  "DELETE /api/push/subscribe",
  "DELETE /api/auth/sessions",
]);

/**
 * Les mêmes, quand l'adresse porte un identifiant.
 *
 * Un ensemble de chaînes ne peut pas les décrire : annuler la demande n° 328 s'écrit
 * `DELETE /api/player/requests/328`. Ces motifs restent volontairement étroits — un identifiant
 * numérique, rien d'autre — pour qu'ils ne s'élargissent pas tout seuls à un sous-chemin voisin.
 */
const GUEST_ALLOWED_PATTERNS: RegExp[] = [
  // Retirer sa propre demande — côté Jellyseerr seulement, jamais côté Radarr.
  /^DELETE \/api\/player\/requests\/\d+$/,
  // Demander un épisode ou une saison qui manque : une recherche Sonarr, et rien d'autre.
  /^POST \/api\/player\/series\/\d+\/search$/,
];

function isAllowedForEveryone(method: string, pathname: string): boolean {
  const signature = `${method} ${pathname}`;
  return GUEST_ALLOWED_MUTATIONS.has(signature) || GUEST_ALLOWED_PATTERNS.some((re) => re.test(signature));
}

/**
 * Les adresses que le lecteur a portées avant d'être la racine.
 *
 * Il a été `/cinema`, puis `/player`, et il est maintenant l'application elle-même : c'est sur lui
 * qu'on arrive en tapant l'adresse, et la gestion a la sienne (`/gestion`). Les deux anciennes
 * restent valables et redirigent — pour les liens partagés, les onglets restés ouverts, les
 * favoris, et surtout les raccourcis déjà installés sur un écran d'accueil, qui pointent vers ce
 * que le manifeste disait le jour de l'installation.
 *
 * Une redirection permanente (308) plutôt qu'un simple lien : les navigateurs la retiennent, donc
 * un raccourci installé finit par pointer directement au bon endroit sans passer par nous.
 */
const MOVED_PATHS: Record<string, string> = {
  "/cinema": "/",
  "/player": "/",
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
    !isAllowedForEveryone(req.method, pathname)
  ) {
    return NextResponse.json({ error: "Action réservée à l'administrateur" }, { status: 403 });
  }

  const res = NextResponse.next();

  /**
   * La session se prolonge tant qu'on s'en sert.
   *
   * Le jeton portait une date d'expiration fixée à la connexion : tout le monde était déconnecté
   * sept jours plus tard, qu'on ait ouvert l'application tous les soirs ou jamais. Le cookie est
   * donc réémis au-delà d'un jour d'ancienneté — avec le *même* `jti`, pour que ce soit la même
   * session qui continue et non une de plus dans la liste.
   *
   * `touch` n'écrit qu'au-delà d'une heure : `last_seen_at` était posé à la création et jamais
   * ensuite, et c'est pourtant lui qui décide du ménage.
   */
  if (shouldRefresh(session)) {
    res.cookies.set(SESSION_COOKIE, await refreshSessionToken(session), {
      httpOnly: true,
      sameSite: "lax",
      secure: appConfig.app.cookieSecure,
      maxAge: SESSION_MAX_AGE,
      path: "/",
    });
  }
  sessionDb.touch(session.jti);

  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icon-192.png|icon-512.png|icon.svg|apple-touch-icon.png|favicon-32.png).*)",
  ],
};
