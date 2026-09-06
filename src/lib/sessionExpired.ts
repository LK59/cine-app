/**
 * L'en-tête par lequel le proxy dit « ta session n'existe plus », et rien d'autre.
 *
 * Un 401 ne suffit pas à conclure : une route peut en renvoyer un parce que *Jellyfin* a refusé
 * nos identifiants, ou parce qu'une clé d'API amont est mauvaise. Déconnecter quelqu'un sur cette
 * base, c'est le renvoyer à l'écran de connexion pour une panne qui n'est pas la sienne. Seul le
 * proxy sait distinguer les deux, puisque c'est lui qui tient la session : il le dit ici.
 */
export const SESSION_EXPIRED_HEADER = "x-session-expired";

/** Une seule redirection, quel que soit le nombre de requêtes qui découvrent la nouvelle. */
let leaving = false;

/**
 * Renvoyer vers la connexion quand la session a disparu sous l'application ouverte.
 *
 * Le cas n'est pas rare : sept jours passent, ou bien on révoque la session depuis un autre
 * appareil. La page, elle, reste montée — et jusqu'ici chacune de ses rangées se contentait
 * d'échouer. On se retrouvait devant un écran vide qui ne disait pas que le remède tenait en une
 * reconnexion, et qu'un simple rechargement l'aurait déjà appliqué.
 *
 * `replace` plutôt que `assign` : l'écran qu'on quitte ne peut plus rien afficher, le laisser dans
 * l'historique ne ferait qu'y ramener. `next` rend la place exacte après la connexion.
 */
export function noteUnauthorized(res: Response): void {
  if (leaving || typeof window === "undefined") return;
  /**
   * Détecter ne doit jamais pouvoir faire échouer ce qu'on détectait.
   *
   * Ceci est appelé depuis le chemin d'erreur d'`apiAction`, dont toute la raison d'être est de
   * remonter ce que le serveur a expliqué. Une réponse sans en-têtes — un bouchon de test, un
   * remplacement de `fetch`, un intermédiaire exotique — faisait lever ici, et le message du
   * serveur (« Base indisponible ») était remplacé à l'écran par le nôtre. Le diagnostic effaçait
   * la panne qu'il devait aider à lire.
   */
  let flagged: string | null = null;
  try {
    flagged = res.headers?.get?.(SESSION_EXPIRED_HEADER) ?? null;
  } catch {
    return;
  }
  if (flagged !== "1") return;
  // La page de connexion appelle elle-même des routes protégées avant qu'une session existe —
  // /api/user/preferences en est une. S'y renvoyer depuis elle serait une boucle.
  if (window.location.pathname === "/login") return;

  leaving = true;
  const here = window.location.pathname + window.location.search;
  window.location.replace(`/login?next=${encodeURIComponent(here)}`);
}

/** Pour les tests, qui doivent pouvoir rejouer le premier 401. */
export function resetSessionExpiredForTests(): void {
  leaving = false;
}
