import { NextRequest, NextResponse } from "next/server";
import { setupDone } from "@/lib/settings/setup";
// `appConfig` et non `config` : le bas de ce fichier exporte déjà une constante nommée
// `config`, qui est la configuration du proxy lui-même.
import { config as appConfig } from "@/lib/config";
import { SESSION_COOKIE, SESSION_MAX_AGE, refreshSessionToken, reissueShareSessionToken, shouldRefresh } from "@/lib/auth";
import { shareGate } from "@/lib/share/gate";
import { sharesDb } from "@/lib/share/store";
import { SESSION_EXPIRED_HEADER } from "@/lib/sessionExpired";
import { isPublicPath } from "@/lib/publicPaths";
import { verifySessionFull } from "@/lib/session";
import { castPassFor, castPreflightFor } from "@/lib/castToken";
import { selfWarmPassFor } from "@/lib/selfWarm";
import { fromLoopback } from "@/lib/trustedProxy";
import { sessionDb } from "@/lib/db";
import { forgetJellyfinToken, jellyfinTokenAlive, jellyfinTokenKnownDead } from "@/lib/jellyfinToken";
import { revokeJellyfinDevices } from "@/lib/jellyfinRevoke";
import { logAuthEvent } from "@/lib/eventLogs";
import { crossSiteWrite } from "@/lib/crossSite";

// Réexportée : la règle est écrite une fois, dans `crossSite.ts`, et les signalements — hors du
// proxy (voir `HORS_PROXY`) — la posent eux-mêmes avec la même fonction.
export { crossSiteWrite };

// Next.js 16's Proxy (formerly "middleware") always runs on the Node.js runtime — unlike the old
// Edge-only middleware, so verifySessionFull's better-sqlite3-backed revocation check (a native
// module, impossible under Edge) is safe to call directly here. Previously this used the
// Edge-compatible verifySessionToken (signature + expiry only), which meant logout only cleared
// the cookie client-side and deleted the DB row, but every route that doesn't individually call
// verifySessionFull relied solely on this gate — so a revoked session (logged out, or
// force-expired) stayed fully usable against most of the app for up to its full 7-day lifetime.

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
  // Le « vu » d'un compte (DECISIONS.md §51) : la route n'écrit que pour l'appelant — sa copie
  // locale, et chez Jellyfin sous son propre identifiant.
  "POST /api/player/watched",
  // « Vous avez terminé ce film » à la fin d'une lecture : n'écrit « vu » que pour l'appelant (un GET
  // jusqu'au 29/10/2026, passé en POST pour que `crossSiteWrite` le couvre).
  "POST /api/player/watched/finished",
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
  // Le relevé de télécommande d'une Fire TV (fireTv.ts) : la route n'écrit que sur l'appelant,
  // dans le journal des ouvertures, et ne renvoie rien.
  "POST /api/remote-diag",
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
  // Le téléchargement hors ligne (bêta, 19/10/2026) : demandé par chaque compte pour lui-même.
  "POST /api/offline/jobs",
  "POST /api/jellyfin/favorite",
  "POST /api/player/account/preferences",
  // La langue retenue par série (20/10/2026) : rangée sous le compte de la session, rien d'autre.
  "POST /api/player/series-language",
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
  // Générer des sous-titres (DECISIONS.md §69) : lancer ou rejoindre une tâche. La dépense est
  // bornée par la route elle-même — 50 lancements par jour et par compte, budget mensuel global.
  "POST /api/subtitle-gen/jobs",
  // Les Nouveautés (DECISIONS.md §73) : « la fenêtre s'est affichée » et ses mesures. Les deux
  // routes n'écrivent que pour l'appelant (son compte vient de la session) et ne renvoient rien.
  "POST /api/release-notes/seen",
  "POST /api/release-notes/event",
  // Le passage vers la nouvelle adresse (DECISIONS.md §119) : la demande ne fabrique une session que
  // pour l'appelant lui-même, et « réglages posés » n'efface que ceux de sa session.
  "POST /api/passage",
  "POST /api/passage/arrival",
  // L'ancienne adresse a libéré sa place (§119) : une ligne au journal, pour les seuls titres attestés
  // à la session de l'appelant.
  "POST /api/passage/fetched",
  // Les livres (option, DECISIONS.md §129) — chaque route n'écrit que sous le compte de la session et
  // répond 404 option coupée : les réglages du lecteur pour un type d'appareil, et sa liste de lecture
  // (ajouter, retirer ; un livre que le compte ne voit pas est refusé par la route).
  "PUT /api/books/reader-prefs",
  "POST /api/books/list",
  "DELETE /api/books/list",
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
  // Hors du matcher depuis A2 (`HORS_PROXY`) : ces entrées et celle de `POST /api/reports` ne
  // servent plus, et restent pour le jour où ils y reviendraient — sans elles, 403 aux comptes.
  /^(PUT|DELETE) \/api\/reports\/\d+$/,
  /^POST \/api\/reports\/\d+\/(messages|status)$/,
  /^DELETE \/api\/reports\/\d+\/images\/\d+$/,
  // Le sondage d'une tâche de sous-titres (la position du spectateur, pour la priorité) et sa
  // reprise après une pause. Identifiant de 32 caractères hexadécimaux, rien d'autre : l'annulation
  // (`/api/subtitle-gen/admin/...`) reste à l'administrateur.
  /^POST \/api\/subtitle-gen\/jobs\/[0-9a-f]{32}\/(poll|resume)$/,
  // Le compte retire sa propre demande ; la route ne touche qu'aux siennes.
  /^DELETE \/api\/offline\/jobs\/[0-9a-f]{32}$/,
  // Sa propre position dans un livre (option « Livres », DECISIONS.md §127) : la route n'écrit que
  // sous le compte de la session, et répond 404 tant que l'option est coupée.
  /^POST \/api\/books\/[0-9a-f]{32}\/progress$/,
  // Retirer un livre de sa propre rangée « Continuer la lecture » (§127) : sous le compte de la session.
  /^DELETE \/api\/books\/[0-9a-f]{32}\/progress$/,
  // Ses propres signets (§127) : même règle que la position, sous le compte de la session.
  /^POST \/api\/books\/[0-9a-f]{32}\/bookmarks$/,
  // Demander un livre (§127) : un ticket rangé sous le compte de la session. Répondre à une demande
  // (`PATCH /api/books/requests/<id>`) reste à l'administrateur.
  /^POST \/api\/books\/requests$/,
  // Une séance de lecture finie (§129) : une ligne au journal des lectures, sous le compte de la session —
  // le titre et l'auteur relus par le serveur, jamais pris du corps.
  /^POST \/api\/books\/[0-9a-f]{32}\/session$/,
  // « Marquer comme lu / non lu » depuis la fiche (29/10/2026) : la position et le « lu » Jellyfin du compte
  // de la session seulement, sur un livre qu'il voit (`bookFor`, dans la route).
  /^(POST|DELETE) \/api\/books\/[0-9a-f]{32}\/read$/,
];

function isAllowedForEveryone(method: string, pathname: string): boolean {
  const signature = `${method} ${pathname}`;
  return GUEST_ALLOWED_MUTATIONS.has(signature) || GUEST_ALLOWED_PATTERNS.some((re) => re.test(signature));
}

/**
 * Les lectures réservées à l'administrateur.
 *
 * La règle générale laisse tout GET à un compte ordinaire. Les quatre premières ne *lisent* pas : elles
 * déclenchent chez Radarr, Sonarr ou Bazarr une recherche interactive auprès des indexeurs et des
 * fournisseurs de sous-titres — des minutes de travail, des quotas consommés, et des noms de
 * sorties que seule la gestion affiche. Aucun écran du cinéma ne les appelle (25/09/2026).
 *
 * `/api/activity`, lui, lit bien : l'historique de Radarr et Sonarr — ce qui a été récupéré,
 * importé, supprimé, et d'où. Seule la page d'état de la gestion l'affiche ; un compte ordinaire
 * n'a aucune raison de le lire (même jour).
 *
 * Mais la même donnée sortait encore par `/api/dashboard` (son champ `activity`) et par
 * `/api/timeline/imports` : la règle ci-dessus ne protégeait rien. Et `/api/stats/storage?refresh=1`
 * laissait n'importe quel compte relancer en boucle le parcours complet des disques. Les trois ne
 * servent que la gestion, que le cinéma n'ouvre plus que depuis l'onglet Compte de
 * l'administrateur (le bouton du rail a été retiré le 06/10/2026). Motifs exacts :
 * `/api/stats/storage-forecast` et les autres `/api/stats/*` ne sont pas attrapés (29/09/2026).
 */
const ADMIN_ONLY_READS: RegExp[] = [
  // Les réglages de l'installation (adresses, état des clés) — DECISIONS.md §48.
  /^\/api\/settings(\/|$)/,
  /^\/api\/activity\/?$/,
  /^\/api\/dashboard\/?$/,
  /^\/api\/timeline\/imports\/?$/,
  /^\/api\/stats\/storage\/?$/,
  /^\/api\/radarr\/movies\/[^/]+\/releases\/?$/,
  /^\/api\/sonarr\/series\/[^/]+\/releases\/?$/,
  /^\/api\/bazarr\/(movies|episodes)\/[^/]+\/subtitles\/?$/,
  // La bibliothèque telle que la gestion la voit (08/10/2026) : Radarr et Sonarr entiers, chaque
  // fiche de gestion, le calendrier, les files, les torrents, les indexeurs, les dossiers et l'espace
  // disque, l'état des services. Aucun écran du cinéma ne les lit — vérifié appelant par appelant ce
  // jour-là (`GlobalSearch`, `SimilarMedia`, `SSENotifier` ne vivent que dans la gestion) — et ils
  // portaient en entier un titre que les tags bloqués d'un compte lui cachent (DECISIONS.md §54) :
  // titre, synopsis, chemin, nom du torrent. Les descriptions de fiche (`/info`) restent ouvertes :
  // le cinéma les lit, et elles retirent elles-mêmes ce que le compte ne doit pas voir.
  /^\/api\/radarr\/movies\/?$/,
  /^\/api\/sonarr\/series\/?$/,
  /^\/api\/radarr\/movies\/[^/]+(\/(similar|file))?\/?$/,
  /^\/api\/sonarr\/series\/[^/]+(\/(similar|episodes))?\/?$/,
  /^\/api\/(radarr|sonarr)\/(calendar|queue|meta)\/?$/,
  /^\/api\/calendar\/?$/,
  /^\/api\/library\/map\/?$/,
  /^\/api\/stats(\/|$)/,
  /^\/api\/qbittorrent(\/|$)/,
  /^\/api\/jackett(\/|$)/,
  /^\/api\/bazarr\/wanted\/?$/,
  /^\/api\/sse\/?$/,
  /^\/api\/status\/?$/,
  /^\/api\/jellyfin\/items\/?$/,
  // Ce que seules les pages de la gestion lisent encore, fermé quand Louis a confirmé qu'un compte
  // ordinaire n'accède à rien de la gestion, « ni aux pages ni à leurs données » (15/10/2026) —
  // appelants vérifiés un par un ce jour-là : l'état des services (`/api/health` : versions exactes
  // et sept sondes amont à chaque appel, ROBUSTESSE-16 ; `/api/discover/movies`, sa sonde TMDB), les
  // fiches Radarr/Sonarr de la gestion (`redirect`, `streams`, `series/…/episodes` de Jellyfin), les
  // notes de la page Sonarr (`/api/watchlist/ratings`). Le cinéma lit l'état public (`/api/status/public`).
  /^\/api\/health\/?$/,
  /^\/api\/discover\/movies\/?$/,
  /^\/api\/jellyfin\/redirect\/?$/,
  /^\/api\/jellyfin\/streams\/[^/]+\/?$/,
  /^\/api\/jellyfin\/series\/[^/]+\/episodes\/?$/,
  /^\/api\/watchlist\/ratings\/?$/,
  // Le panneau des sous-titres générés : dépense du mois, tâches de tous les comptes (§69).
  /^\/api\/subtitle-gen\/admin(\/|$)/,
  // L'indexation des répliques : chemins des films, erreurs, titres de tous les films (§88).
  /^\/api\/repliques\/admin(\/|$)/,
  // Les Nouveautés vues de l'activité : l'état de chaque compte, les brouillons (§73). La route le
  // vérifie aussi (`adminOnly`).
  /^\/api\/admin\/release-notes(\/|$)/,
  // Le contrôle de la bibliothèque : chaque titre et chaque dossier, tags bloqués compris (§90). La
  // route le vérifie aussi (`adminOnly`).
  /^\/api\/admin\/library-check(\/|$)/,
  // Les téléchargements vus de l'activité : les versions du serveur, qui les a demandées, et ce que
  // chacun a emporté — titres cachés par un tag bloqué compris (19/10/2026). La route le vérifie
  // aussi (`adminOnly`). Son effacement (`DELETE /api/admin/offline/<id>`) n'est pas dans la liste
  // blanche des écritures : refusé à un compte ordinaire d'office.
  /^\/api\/admin\/offline(\/|$)/,
  // Les liens de partage : qui les a reçus, ce qu'ils ont regardé (DECISIONS.md §112).
  /^\/api\/admin\/shares(\/|$)/,
  // Les lectures de chaque compte — quels livres, combien de temps, sur quel appareil (§129). La route le
  // vérifie aussi (`adminOnly`), et répond 404 l'option des livres coupée.
  /^\/api\/admin\/activity\/books(\/|$)/,
  // La recherche de Radarr et de Sonarr (fiches complètes, chemins sur le disque) et la bibliothèque
  // de Jellyfin (sa version exacte, ses compteurs) : la gestion seule les lit (revue du 20/10/2026).
  /^\/api\/(radarr\/movies|sonarr\/series)\/lookup\/?$/,
  /^\/api\/jellyfin\/library\/?$/,
];

function isAdminOnlyRead(pathname: string): boolean {
  return ADMIN_ONLY_READS.some((re) => re.test(pathname));
}

/**
 * Les pages de la gestion — le groupe `(dashboard)` — réservées à l'administrateur.
 *
 * Les API qu'elles lisent étaient refusées à un compte ordinaire (ci-dessus), mais les pages, elles,
 * restaient ouvertes : `/gestion` se rend côté serveur (`Overview` → `buildDashboardPayload`) et
 * glissait dans le HTML ce que `/api/dashboard` refuse — versions des services, compteurs, derniers
 * imports titre par titre, l'erreur de qBittorrent. Constaté le 15/10/2026 avec un compte ordinaire
 * qui tapait l'adresse (passe de nuit, BUREAU-14) ; un titre caché par un tag bloqué (§54) y sortait
 * en clair. Aucun écran du cinéma ne mène un compte ordinaire ici (le bouton « Gestion » du panneau
 * Compte n'est rendu qu'à l'administrateur), donc on le renvoie au cinéma.
 *
 * Écrit en premiers segments plutôt que page par page : une nouvelle page sous `/radarr/…` est
 * couverte d'office. Un test liste les `page.tsx` du groupe et échoue si l'un d'eux n'est pas pris.
 */
const ADMIN_ONLY_PAGES = new Set([
  "gestion",
  "bazarr",
  "calendar",
  "controle",
  "health",
  "jackett",
  "jellyfin",
  "jellyseerr",
  "parametres",
  "person",
  "qbittorrent",
  "radarr",
  "sonarr",
  "stats",
  "timeline",
]);

export function isAdminOnlyPage(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  const first = pathname.split("/")[1] ?? "";
  return ADMIN_ONLY_PAGES.has(first);
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

function setupDoneSafe(): boolean {
  try {
    return setupDone();
  } catch {
    return true;
  }
}

/**
 * L'optimiseur d'images (`/_next/image`) ne sert qu'aux sessions — et au serveur lui-même.
 *
 * Il était public (audit F-009, puis du 08/10/2026) : sans cookie, n'importe qui lui faisait
 * télécharger et réduire n'importe quelle affiche de TMDB, rangée un an dans `data/image-cache`.
 * Parcourir les adresses de TMDB faisait grossir `./data` sans limite. Aucune page publique ne s'en
 * sert (connexion, assistant, état des services n'affichent pas d'affiche optimisée).
 *
 * Le serveur, lui, prépare ses propres affiches d'avance (`posterPrewarm`) en appelant son
 * optimiseur sur la boucle locale, sans cookie. Une telle demande ne porte pas d'`X-Forwarded-For` :
 * tout ce qui vient de l'extérieur passe par le relais, qui en pose toujours un.
 */
async function imageOptimizerAllowed(req: NextRequest): Promise<boolean> {
  // La connexion elle-même quand le démarrage l'a notée (`trustedProxy.ts`) : seule la boucle locale
  // passe sans session. Sinon, l'ancienne règle : pas d'en-tête de relais, pas d'extérieur.
  const loopback = fromLoopback(req.headers);
  if (loopback !== null) {
    if (loopback) return true;
  } else if (!req.headers.get("x-forwarded-for") && !req.headers.get("x-real-ip")) return true;
  try {
    return (await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value)) !== null;
  } catch {
    return false;
  }
}

export async function proxy(req: NextRequest) {
  /**
   * L'adresse décodée, et c'est elle que toutes les règles lisent (20/10/2026, revue de sécurité).
   * Next sert `/%61pi/settings` comme `/api/settings` quand l'adresse brute ne correspond à rien :
   * comparé tel quel, ce chemin ne commençait pas par `/api/` et échappait aux règles des rôles. En
   * production Next répondait 404 à ces adresses — rien n'était ouvert —, mais la porte ne doit pas
   * dépendre de ce détail. Un encodage illisible ne va pas plus loin.
   */
  let pathname: string;
  try {
    pathname = decodeURIComponent(req.nextUrl.pathname);
  } catch {
    return NextResponse.json({ error: "Adresse invalide" }, { status: 400 });
  }

  if (crossSiteWrite(req)) {
    return NextResponse.json({ error: "Requête refusée" }, { status: 403 });
  }

  /**
   * Le premier lancement : tant que l'assistant n'est pas terminé, toute page y mène (DECISIONS.md
   * §48). Restent ouverts l'assistant lui-même, la connexion (pour qui a déjà un compte dans
   * `.env`), et toutes les routes d'API — elles gardent leurs propres règles. Gardé : une base
   * illisible ne doit jamais enfermer une installation dans l'assistant — dans le doute, on laisse
   * passer, c'est le comportement d'avant.
   */
  if (!pathname.startsWith("/api/") && pathname !== "/setup" && pathname !== "/login" && !pathname.startsWith("/_next") && !setupDoneSafe()) {
    return NextResponse.redirect(new URL("/setup", req.url));
  }

  if (pathname === "/login") {
    return (await signedInElsewhere(req)) ?? NextResponse.next();
  }

  // L'optimiseur d'images, avant la règle générale de `/_next` — voir `imageOptimizerAllowed`.
  if (pathname.startsWith("/_next/image")) {
    return (await imageOptimizerAllowed(req)) ? NextResponse.next() : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (
    isPublicPath(pathname) ||
    pathname.startsWith("/_next")
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
  // La question préalable (CORS) d'un récepteur Chromecast, sur la même adresse et avec le même
  // laissez-passer : elle n'emporte jamais de cookie. La route y répond — DECISIONS.md §64.
  if (await castPreflightFor(req)) return NextResponse.next();
  // Le serveur qui construit ses deux catalogues au démarrage, sur la boucle locale et avec le jeton
  // du processus — voir `selfWarm.ts`.
  if (selfWarmPassFor(req)) return NextResponse.next();

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
    // Un cookie présenté mais refusé (révoqué, expiré, illisible) : une session a existé, l'écran de
    // connexion dit qu'elle a pris fin (DECISIONS.md §101). Sans cookie du tout, c'est une première
    // visite, et il n'y a rien à expliquer. Le fragment (la fiche ouverte) n'arrive jamais ici : le
    // navigateur le recolle à l'adresse d'arrivée, et la page de connexion le reprend.
    if (token) loginUrl.searchParams.set("reason", "expired");
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  /**
   * Une session de partage (DECISIONS.md §112) a sa propre porte, fermée par défaut, et ne descend
   * jamais aux règles des comptes ci-dessous : celles-ci ouvrent toute lecture à un `user`. Sa fin
   * est celle du lien, sans glissement — réémise seulement si le lien a été prolongé.
   */
  if (session.role === "share") {
    const gated = await shareGate(req, session, pathname);
    if (gated.status !== 200 || gated.headers.get("location")) return gated;
    const share = sharesDb.get(session.sh ?? "");
    if (share && share.expiresAt !== session.exp) {
      gated.cookies.set(SESSION_COOKIE, await reissueShareSessionToken(session, share.expiresAt), {
        httpOnly: true,
        sameSite: "lax",
        secure: appConfig.app.cookieSecure,
        maxAge: Math.max(1, Math.floor((share.expiresAt - Date.now()) / 1000)),
        path: "/",
      });
    }
    sessionDb.touch(session.jti);
    return gated;
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
  // Une redirection et non un 403 : c'est une page, tapée ou restée en favori — le cinéma est la
  // bonne réponse à qui n'a pas la gestion. Voir `ADMIN_ONLY_PAGES`.
  if (session.role !== "admin" && isAdminOnlyPage(pathname)) {
    return NextResponse.redirect(new URL("/", req.url));
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
   * prochaine page. La même question ferme aussi la session d'un compte désactivé ou dont le rôle a
   * changé dans Jellyfin : sans elle, la prolongation glissante recopiait le rôle de la connexion à vie.
   */
  /**
   * Sur une route d'API, la question n'est pas attendue — elle part en arrière-plan, au plus une fois
   * par heure (`jellyfinTokenAlive` garde ses réponses) —, et seule une réponse déjà connue compte
   * (revue de sécurité du 20/10/2026). Un client qui n'appelait que l'API n'était jamais revérifié :
   * un administrateur rétrogradé ou désactivé dans Jellyfin, ou un cookie volé survivant au changement
   * de mot de passe, gardait l'administration indéfiniment, la session se prolongeant d'elle-même.
   * Un compte ordinaire au jeton mort garde son flux en cours (une position se rattrape, voir plus bas)
   * mais sa session n'est plus prolongée ; un administrateur perd ses droits aussitôt.
   */
  let jellyfinDead = false;
  if (pathname.startsWith("/api/") && session.jfToken) {
    jellyfinDead = jellyfinTokenKnownDead(session.jti);
    if (!jellyfinDead) void tokenStillAccepted(session);
    if (jellyfinDead && session.role === "admin") {
      void revokeJellyfinDevices([sessionDb.delete(session.jti)], "jeton refusé");
      logAuthEvent("token-refused", { user: session.jfUser ?? session.u });
      forgetJellyfinToken(session.jti);
      const expired = NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { [SESSION_EXPIRED_HEADER]: "1" } });
      expired.cookies.delete(SESSION_COOKIE);
      return expired;
    }
  }

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
  if (shouldRefresh(session) && !jellyfinDead) {
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
  "favicon.ico",
  "favicon.svg",
  "favicon-32.png",
  "manifest.json",
  "sw.js",
  "offline.html",
  "icon-192.png",
  "icon-512.png",
  // L'icône que le système découpe lui-même (manifeste, `purpose: maskable`), et le badge
  // monochrome des notifications Android : l'un comme l'autre demandés hors de toute page.
  "icon-maskable-512.png",
  "badge-96.png",
  "icon.svg",
  "apple-touch-icon.png",
  "splash/",
];

/**
 * Ce que le proxy ne voit pas non plus, mais qui n'a rien de public : les signalements.
 *
 * Dès qu'un proxy existe, Next garde en mémoire le corps de chaque requête qu'il couvre, jusqu'à
 * `proxyClientMaxBodySize`, avant que le proxy ait rien décidé. Cette limite avait été portée à
 * 100 Mo pour les captures jointes à un signalement — et valait alors pour toute l'API, requêtes
 * anonymes comprises : vingt POST de 95 Mo sans cookie remplissaient les 2 Go du conteneur (audit
 * A2, 29/09/2026). La limite est revenue au défaut de Next, et les seules routes qui ont besoin de
 * gros corps sortent du proxy.
 *
 * Elles en portent elles-mêmes les contrôles, tous dans `reportCaller` (`reportRequest.ts`) et
 * tous **avant** de lire le corps : l'écriture venue d'une autre page (`crossSiteWrite`, la même
 * fonction), la session (401 avec `x-session-expired`), et un corps annoncé trop lourd. Le rôle n'a
 * rien à reporter : toutes leurs écritures figuraient dans la liste des invités, et chaque route
 * vérifie que le signalement est celui de l'appelant. Le renouvellement glissant du cookie n'y a
 * pas lieu — n'importe quelle autre requête de la page s'en charge.
 *
 * Un préfixe, comme les entrées ci-dessus : `/api/reportsX` échapperait aussi, et n'existe pas.
 */
export const HORS_PROXY = ["api/reports"];

/**
 * Écrit à la main, et non construit depuis les tableaux ci-dessus : Next exige une **chaîne
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
    "/((?!_next/static|favicon.ico|favicon.svg|favicon-32.png|manifest.json|sw.js|offline.html|icon-192.png|icon-512.png|icon-maskable-512.png|badge-96.png|icon.svg|apple-touch-icon.png|splash/|api/reports).*)",
  ],
};
