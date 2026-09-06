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
] as const;

/** Vrai pour une de ces adresses, et pour tout ce qu'elle contient. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
