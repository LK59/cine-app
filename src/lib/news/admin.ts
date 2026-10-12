import { jellyfin } from "@/lib/clients/jellyfin";
import { config } from "@/lib/config";
import { NEWS_LIMITS, isEmptyContent, sanitizeByLang, type NewsContentByLang } from "./content";

/**
 * Les comptes du cinéma, pour la vue Nouveautés de l'activité : ceux de Jellyfin, plus le compte
 * local de l'administrateur — la même liste que l'écran d'accueil (`/api/admin/onboarding`).
 * Jellyfin injoignable : la liste se réduit à ce que la base connaît déjà, sans erreur.
 */
export async function newsAccountNames(): Promise<string[]> {
  const users = await jellyfin.getUsers().catch(() => [] as { Name: string }[]);
  return [...new Set([...users.map((u) => u.Name), config.app.adminUser])];
}

/** Le corps d'une page envoyé par l'éditeur, nettoyé ; `null` sans version ou sans français. */
export function pageBody(raw: unknown): { version: string; content: NewsContentByLang } | null {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const version = typeof o.version === "string" ? o.version.trim().slice(0, NEWS_LIMITS.version) : "";
  if (!version) return null;
  const content = sanitizeByLang(o.content);
  if (isEmptyContent(content.fr)) return null;
  return { version, content };
}
