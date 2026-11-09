/**
 * À qui une fonction expérimentale est ouverte (09/11/2026, DECISIONS.md §139 et §138) : `off`,
 * `admins` ou `tous`. Les fonctions du modèle et des acteurs à l'écran s'allument d'abord pour les
 * administrateurs seuls (consigne du propriétaire), puis pour tout le monde.
 *
 * **Le serveur décide** (`audienceAllows`, appelé par chaque route qui sert la fonction) ; l'écran ne fait
 * que cacher la pilule ou la ligne à qui n'y a pas droit — de la présentation, pas une porte.
 *
 * Les réglages gardent leur clé d'avant (`ASK_ENABLED`, `XRAY_ENABLED`) : `true` y vaut `tous` et
 * `false` `off`, si bien qu'une installation réglée avant le 09/11/2026 garde exactement ce qu'elle avait.
 */

export type Audience = "off" | "admins" | "tous";
export const AUDIENCES: readonly Audience[] = ["off", "admins", "tous"];

/** Une valeur de réglage, d'aujourd'hui ou d'avant. Tout ce qui n'est pas reconnu vaut `off`. */
export function parseAudience(raw: string | null | undefined): Audience {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "tous" || v === "true" || v === "all") return "tous";
  if (v === "admins" || v === "admin") return "admins";
  return "off";
}

/** La fonction est-elle ouverte à cette session ? Sans session, jamais ; `admins`, le rôle seul compte. */
export function audienceAllows(audience: Audience, session: { role?: string | null } | null | undefined): boolean {
  if (!session || audience === "off") return false;
  return audience === "tous" || session.role === "admin";
}
