/**
 * Ce qui rend une installation forgeable, dit avant qu'elle ne démarre.
 *
 * Le contrôle ne refusait que la valeur par défaut du code, `change-me-in-production`. Or le
 * modèle publié, `.env.example`, en portait une autre — `generate-a-long-random-string` — et un
 * inconnu qui le recopiait sans y toucher obtenait un serveur qui démarrait, signé d'un secret que
 * n'importe qui peut lire sur GitHub : une session administrateur à la portée de tous. Une valeur
 * vide passait aussi (relevé par l'audit de la documentation, 22/09/2026). Même chose pour le mot
 * de passe administrateur d'exemple.
 *
 * Seize caractères au moins, et pas davantage : l'installation de référence tourne avec un secret
 * de vingt caractères, et une règle qui l'empêcherait de redémarrer serait une panne, pas une
 * protection. Un secret plus long reste recommandé (`openssl rand -hex 32`).
 */
export const PLACEHOLDER_SECRETS = new Set(["change-me-in-production", "generate-a-long-random-string"]);
export const PLACEHOLDER_PASSWORDS = new Set(["change-me"]);
export const MIN_SECRET_LENGTH = 16;

/** La raison de refuser ce secret de session, ou `null` s'il convient. */
export function sessionSecretProblem(secret: string): string | null {
  if (!secret.trim()) return "SESSION_SECRET est vide.";
  if (PLACEHOLDER_SECRETS.has(secret)) return "SESSION_SECRET est la valeur d'exemple publiée.";
  if (secret.length < MIN_SECRET_LENGTH) {
    return `SESSION_SECRET fait ${secret.length} caractères — ${MIN_SECRET_LENGTH} au moins.`;
  }
  return null;
}

/**
 * La raison de refuser le mot de passe administrateur local, ou `null`. Vide est permis : c'est
 * ainsi qu'on désactive le compte administrateur local (seuls les comptes Jellyfin entrent alors).
 */
export function adminPasswordProblem(password: string): string | null {
  if (PLACEHOLDER_PASSWORDS.has(password)) return "APP_ADMIN_PASSWORD est la valeur d'exemple publiée.";
  return null;
}
