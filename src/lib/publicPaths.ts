/**
 * Ce qui s'ouvre sans session, et la seule liste qui le dise.
 *
 * Elle vivait dans le proxy, qui est le seul à *refuser* une adresse — mais il n'est pas le seul à
 * avoir besoin de la connaître. Le client aussi : quand une réponse dit « ta session a disparu »,
 * il renvoie vers la connexion, et il doit savoir se taire sur les pages qui n'en demandaient pas.
 *
 * Le coût de l'avoir devinée une fois : la racine monte le lecteur sur *toutes* les pages, y
 * compris l'état des services, où il demande les préférences de l'utilisateur et reçoit un 401
 * parfaitement normal. La garde n'excusait que `/login`, alors la page d'état — publique côté
 * proxy, et justement celle qu'on va consulter quand on n'arrive pas à se connecter — partait
 * aussitôt vers la connexion. Une page publique inaccessible.
 */
export const PUBLIC_PATHS = [
  "/login",
  "/status",
  "/api/auth/login",
  "/api/auth/jellyfin",
  "/api/status/public",
  "/api/config/public",
  "/api/push/vapid-key",
  // La sonde de santé de Docker, qui n'a pas de session à présenter — voir la route.
  "/api/ping",
  // L'assistant de premier lancement : il s'ouvre avant que quiconque ait un compte. La création du
  // compte se ferme d'elle-même une fois servie (voir la route) — DECISIONS.md §48.
  "/setup",
  "/api/setup/status",
  "/api/setup/admin",
  "/api/setup/language",
  // L'entrée hors ligne des téléchargements (DECISIONS.md §109) : le service worker la demande sans
  // cookie pour la garder, et la sert quand le serveur ne répond pas. Une page rendue, pas un fichier
  // — d'où cette liste et non `ACTIFS_PUBLICS` : elle passe par le proxy (l'assistant de premier
  // lancement, les écritures d'une autre page) comme `/status`. Elle ne sert rien d'un compte :
  // ce qu'elle montre est lu sur l'appareil.
  "/hors-ligne",
  // Un lien de partage (DECISIONS.md §112) : sa page demande le mot de passe à qui n'a pas encore de
  // session, et l'entrée l'échange contre une session `share`. La page elle-même ne montre rien du
  // titre avant le mot de passe ; ce qui suit passe par la porte des liens (`share/gate.ts`).
  "/partage",
  "/api/share/redeem",
  // Le passage d'une adresse à l'autre (DECISIONS.md §119), côté nouvelle adresse : on y arrive sans
  // session. La page lit le jeton dans le fragment (que rien ne transmet au serveur) ou fait recopier
  // le code ; l'entrée l'échange contre une session. Seulement l'entrée : la demande
  // (`/api/passage`) et les réglages d'arrivée (`/api/passage/arrival`) exigent une session.
  "/passage",
  "/api/passage/redeem",
] as const;

/** Vrai pour une de ces adresses, et pour tout ce qu'elle contient. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
