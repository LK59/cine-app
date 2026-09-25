import { NextRequest, NextResponse } from "next/server";
// `appConfig` et non `config` : le bas de ce fichier exporte déjà une constante nommée
// `config`, qui est la configuration du proxy lui-même.
import { config as appConfig } from "@/lib/config";
import { SESSION_COOKIE, SESSION_MAX_AGE, refreshSessionToken, shouldRefresh } from "@/lib/auth";
import { SESSION_EXPIRED_HEADER } from "@/lib/sessionExpired";
import { isPublicPath } from "@/lib/publicPaths";
import { verifySessionFull } from "@/lib/session";
import { castPassFor } from "@/lib/castToken";
import { sessionDb } from "@/lib/db";
import { forgetJellyfinToken, jellyfinTokenAlive } from "@/lib/jellyfinToken";
import { revokeJellyfinDevices } from "@/lib/jellyfinRevoke";
import { logAuthEvent } from "@/lib/eventLogs";

// Next.js 16's Proxy (formerly "middleware") always runs on the Node.js runtime — unlike the old
// Edge-only middleware, so verifySessionFull's better-sqlite3-backed revocation check (a native
// module, impossible under Edge) is safe to call directly here. Previously this used the
// Edge-compatible verifySessionToken (signature + expiry only), which meant logout only cleared
// the cookie client-side and deleted the DB row, but every route that doesn't individually call
// verifySessionFull relied solely on this gate — so a revoked session (logged out, or
// force-expired) stayed fully usable against most of the app for up to its full 7-day lifetime.

// The slideshow page (/random, og:image preview + <img> tags) and the individual photo files it
// hotlinks (/[filename]) both need to work for an anonymous visitor (a public link to the gallery). The list
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
  // Retirer un titre de sa propre rangée « Reprendre » : la route n'oublie que la position, et que
  // celle du compte de la session (23/09/2026).
  "DELETE /api/jellyfin/resume",
  "POST /api/jellyfin/playback/start",
  "POST /api/player/log",
  // Une erreur du navigateur, remontée au journal du serveur : la route n'écrit que sur l'appelant
  // (son compte vient de la session) et ne lit rien en retour.
  "POST /api/client-error",
  // « Je suis là », une fois par minute : la route n'écrit que sur l'appelant, en mémoire, et ne
  // renvoie rien (vue en direct de l'administrateur).
  "POST /api/presence",
  // Ce que l'ouverture du cinéma a coûté (cache de l'appareil ou réseau) : la route n'écrit que
  // sur l'appelant, dans un journal, et ne renvoie rien.
  "POST /api/startup-timing",
  // « Signaler un problème » : créer le sien. Les routes vérifient que c'est bien le sien pour tout
  // le reste (modifier un brouillon, commenter, fermer, retirer une image).
  "POST /api/reports",
  "POST /api/jellyfin/playback/playing",
  "POST /api/jellyfin/playback/progress",
  "POST /api/jellyfin/playback/stop",
  "POST /api/jellyseerr/requests",
  // Watchlist is per-user: guests can manage their own list
  "POST /api/watchlist",
  "DELETE /api/watchlist",
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
  // La langue de l'app (23/09/2026). Refusée à un compte ordinaire sans que rien ne le dise —
  // `fetch` ne lève pas sur un 403 —, puis le rechargement relisait l'ancienne langue et la
  // réécrivait : la page revenait en français. La route n'écrit que la préférence de l'appelant.
  "PUT /api/user/preferences",
  // Trouvées à la revue précédant la bascule, et du même tonneau que les quatre précédentes : le
  // panneau « Compte » montre à tout le monde un interrupteur de notifications et un bouton
  // « déconnecter mes autres appareils », et les deux répondaient 403 à un compte ordinaire. Les
  // trois routes n'agissent que sur l'appelant — la souscription est rangée sous son nom, les
  // sessions supprimées sont les siennes — donc les ouvrir n'ouvre rien d'autre.
  "POST /api/push/subscribe",
  "DELETE /api/push/subscribe",
  // Ce que chacun veut recevoir, depuis le panneau Compte du cinéma (21/09/2026). La route n'écrit
  // que sous le nom de l'appelant, et seulement les annonces qu'un spectateur peut recevoir.
  "PUT /api/notifications/settings",
  // L'essai d'envoi, passé de la gestion au panneau Compte (23/09/2026) : il n'écrit à personne
  // d'autre qu'aux appareils de l'appelant.
  "POST /api/push/test",
  // « J'ai fini l'accueil » : n'éteint que le marqueur de l'appelant.
  "POST /api/onboarding",
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
  // Ses propres signalements — la route refuse ceux des autres (`reportFor`, `canSetStatus`).
  /^(PUT|DELETE) \/api\/reports\/\d+$/,
  /^POST \/api\/reports\/\d+\/(messages|status)$/,
  /^DELETE \/api\/reports\/\d+\/images\/\d+$/,
];

function isAllowedForEveryone(method: string, pathname: string): boolean {
  const signature = `${method} ${pathname}`;
  return GUEST_ALLOWED_MUTATIONS.has(signature) || GUEST_ALLOWED_PATTERNS.some((re) => re.test(signature));
}

/**
 * Les lectures réservées à l'administrateur.
 *
 * La règle générale laisse tout GET à un compte ordinaire. Ces quatre-là ne *lisent* pas : elles
 * déclenchent chez Radarr, Sonarr ou Bazarr une recherche interactive auprès des indexeurs et des
 * fournisseurs de sous-titres — des minutes de travail, des quotas consommés, et des noms de
 * sorties que seule la gestion affiche. Aucun écran du cinéma ne les appelle (25/09/2026).
 *
 * `/api/activity`, lui, lit bien : l'historique de Radarr et Sonarr — ce qui a été récupéré,
 * importé, supprimé, et d'où. Seule la page d'état de la gestion l'affiche ; un compte ordinaire
 * n'a aucune raison de le lire (même jour).
 */
const ADMIN_ONLY_READS: RegExp[] = [
  /^\/api\/activity\/?$/,
  /^\/api\/radarr\/movies\/[^/]+\/releases\/?$/,
  /^\/api\/sonarr\/series\/[^/]+\/releases\/?$/,
  /^\/api\/bazarr\/(movies|episodes)\/[^/]+\/subtitles\/?$/,
];

function isAdminOnlyRead(pathname: string): boolean {
  return ADMIN_ONLY_READS.some((re) => re.test(pathname));
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
  // L'activité des comptes a quitté la gestion pour un panneau du cinéma (24/09/2026).
  "/activite": "/#activite=1",
};

/**
 * L'écran de connexion, quand on est déjà connecté.
 *
 * `/login` est publique — elle doit l'être — et repartait donc sans que rien ne regarde la
 * session : y arriver avec une session valide affichait un formulaire de connexion à quelqu'un de
 * connecté. C'est ce qu'on voyait en revenant de la page d'état des services, et ça se lit comme
 * une déconnexion.
 *
 * Une session locale ne va pas à la racine mais à la gestion, pour la raison que l'écran de
 * connexion donne déjà lui-même : elle ne porte aucune identité Jellyfin, donc le lecteur qu'elle
 * ouvrirait aurait un bouton « Lire » qui répond 401.
 *
 * La vérification est gardée : la page de connexion est la porte d'entrée, et le jour où la base
 * ne répond plus, une garde qui lève à sa place la remplacerait par une erreur. On laisse alors
 * passer — le formulaire est toujours la bonne réponse à qui n'a pas de session utilisable.
 */
async function signedInElsewhere(req: NextRequest): Promise<NextResponse | null> {
  try {
    const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
    if (!session) return null;
    return NextResponse.redirect(new URL(session.jfId ? "/" : "/gestion", req.url));
  } catch {
    return null;
  }
}

/**
 * Gardée : une vérification qui lève sur le chemin de chaque page remplacerait la page par une
 * erreur. Dans le doute, on laisse passer — c'est l'ancien comportement.
 */
async function tokenStillAccepted(session: Parameters<typeof jellyfinTokenAlive>[0]): Promise<boolean> {
  try {
    return await jellyfinTokenAlive(session);
  } catch {
    return true;
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === "/login") {
    return (await signedInElsewhere(req)) ?? NextResponse.next();
  }

  if (
    isPublicPath(pathname) ||
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

  /**
   * Le seul accès sans session de toute l'application, et il tient en une ligne ici.
   *
   * Un téléviseur qui diffuse ne reçoit pas le flux de la page : il reçoit une adresse et va le
   * chercher lui-même, sans notre cookie et sans moyen d'en avoir un. `castPassFor` décide, et
   * elle est écrite une seule fois — la route de flux pose exactement la même question, avec la
   * même fonction. Sa portée est dans son nom : un GET, le préfixe du flux, un titre nommé par la
   * signature elle-même. Tout le reste du site continue d'exiger une session.
   *
   * Placé après les chemins publics et les redirections, avant la vérification de session : un
   * laissez-passer ne doit jamais pouvoir contourner ce qui précède.
   */
  if (await castPassFor(req)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  if (!session) {
    if (pathname.startsWith("/api/")) {
      // L'en-tête, et non le seul code : une page ouverte doit pouvoir distinguer « ta session
      // a disparu » d'un 401 venu d'un service amont — voir noteUnauthorized.
      return NextResponse.json(
        { error: "unauthorized" },
        { status: 401, headers: { [SESSION_EXPIRED_HEADER]: "1" } }
      );
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
  if (session.role !== "admin" && isAdminOnlyRead(pathname)) {
    return NextResponse.json({ error: "Action réservée à l'administrateur" }, { status: 403 });
  }

  /**
   * Une session dont Jellyfin a révoqué le jeton se referme ici — au chargement d'une page, et
   * seulement là.
   *
   * Changer ou réinitialiser un mot de passe révoque tous les jetons du compte côté Jellyfin, et
   * rien ne le disait à la session de l'application, qui se prolonge à chaque visite : un compte a
   * ainsi regardé des films six jours durant sans qu'aucune position soit gardée (24/09/2026). La
   * question est posée au plus une fois par heure et par session (`jellyfinToken.ts`), et jamais
   * sur une route d'API : fermer la session là couperait aussi le flux d'un film en cours. Un film
   * déjà lancé garde sa position autrement (`playbackReport.ts`) ; la connexion est redemandée à la
   * prochaine page.
   */
  if (!pathname.startsWith("/api/") && session.jfToken && !(await tokenStillAccepted(session))) {
    // Son jeton est déjà refusé ; l'appareil, lui, reste inscrit chez Jellyfin : on le retire.
    void revokeJellyfinDevices([sessionDb.delete(session.jti)], "jeton refusé");
    logAuthEvent("token-refused", { user: session.jfUser ?? session.u });
    forgetJellyfinToken(session.jti);
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("reason", "jellyfin");
    loginUrl.searchParams.set("next", pathname);
    const expired = NextResponse.redirect(loginUrl);
    expired.cookies.delete(SESSION_COOKIE);
    return expired;
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

/**
 * Ce que le proxy ne regarde pas — et pourquoi cette liste est une famille, pas un tas.
 *
 * Tout ce qui est ici est **servi sans session**. Ce n'est pas une commodité : ce sont les
 * fichiers qu'un navigateur ou un système d'exploitation va chercher de lui-même, hors de toute
 * page, à des moments où il n'a aucune raison de présenter un cookie — l'icône d'un onglet, le
 * manifeste, le service worker, la page hors ligne, et les écrans de lancement qu'iOS capture au
 * moment où l'on pose l'application sur l'écran d'accueil.
 *
 * C'est ce dernier cas qui a coûté la journée du 20/09/2026 : `/splash/*` manquait à la liste,
 * donc iOS recevait une redirection vers `/login` à la place de chaque image, et affichait son
 * propre fond — celui qui suit le mode clair ou sombre du téléphone. Aucun journal, aucune erreur,
 * et trois réinstallations pour rien : une redirection n'est pas une panne, c'est une page.
 *
 * **Rien de confidentiel ne doit être servi depuis ces chemins**, et `/splash` est un dossier :
 * ce qu'on y dépose est public par construction.
 */
const ACTIFS_PUBLICS = [
  "_next/static",
  "_next/image",
  "favicon.ico",
  "favicon.svg",
  "favicon-32.png",
  "manifest.json",
  "sw.js",
  "offline.html",
  "icon-192.png",
  "icon-512.png",
  "icon.svg",
  "apple-touch-icon.png",
  "splash/",
];

/**
 * Écrit à la main, et non construit depuis le tableau ci-dessus : Next exige une **chaîne
 * littérale** ici — il lit ce fichier à la compilation, sans l'exécuter, et refuse tout ce qu'il
 * ne peut pas lire tel quel (« matcher[0] need to be static strings »). La tentative de
 * l'assembler a été refusée par la construction de l'image le 20/09/2026.
 *
 * Deux écritures d'une même liste, donc, ce qui est exactement ce que ce dépôt sait voir dériver.
 * Un test les compare caractère par caractère — c'est lui qui tient le lien, puisque le langage
 * ne peut pas.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|favicon.svg|favicon-32.png|manifest.json|sw.js|offline.html|icon-192.png|icon-512.png|icon.svg|apple-touch-icon.png|splash/).*)",
  ],
};
