import { laternaAddress } from "@/lib/news/pageLaterna";

/**
 * L'adresse vers laquelle le passage mène (DECISIONS.md §119) : celle que le déploiement annonce
 * (`NEWS_LATERNA_ADDRESS`, `config.news.laternaAddress`) et aucune autre — jamais une adresse venue
 * du client, ce qui ferait du passage une redirection ouverte portant une session.
 *
 * Le nom d'hôte est validé par `laternaAddress`, la même règle que la page Nouveautés. Le schéma est
 * `https`, sauf si le réglage écrit lui-même `http://` (une instance d'essai sans certificat).
 * `null` : pas de réglage, ou un réglage inutilisable — pas de passage sur cette installation.
 */
export function passageTarget(raw: string | null | undefined): { origin: string; host: string } | null {
  const host = laternaAddress(raw);
  if (!host) return null;
  const scheme = /^http:\/\//i.test((raw ?? "").trim()) ? "http" : "https";
  return { origin: `${scheme}://${host}`, host };
}
