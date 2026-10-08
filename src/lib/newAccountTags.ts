// Les tags bloqués d'office pour les nouveaux comptes Jellyfin (08/10/2026, DECISIONS.md §56).
//
// Le tag « prive » réserve des titres à deux comptes : il est bloqué, dans la politique Jellyfin, sur
// tous les autres (§54). Mais un compte créé ensuite dans Jellyfin naît sans ce blocage — et voit ces
// titres, dans Jellyfin comme dans le cinéma. Ce module pose les tags de `NEW_ACCOUNT_BLOCKED_TAGS` sur
// chaque compte que l'installation découvre, une seule fois, au moment où elle le découvre.
//
// « Découvrir », pas « jamais connecté » : la liste des comptes connus (`known_accounts`) est
// d'abord remplie avec tous les comptes présents, sans rien toucher — les deux comptes qui ont accès à
// « prive » sont déjà là et ne le perdront pas. Un compte ne passe qu'une fois : retirer ensuite le
// blocage dans Jellyfin le retire pour de bon. Les administrateurs ne sont jamais touchés.
//
// La règle reste celle de Jellyfin : on écrit dans sa politique, rien de plus — c'est elle que le
// cinéma relit (`blockedTagsOf`) et que les applications Jellyfin appliquent.

import { config } from "@/lib/config";
import { knownAccountsDb } from "@/lib/db";
import { logAuthEvent } from "@/lib/eventLogs";
import { upstreamSignal, UPSTREAM_TIMEOUT_MS } from "@/lib/http";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { forgetBlockedTags } from "@/lib/blockedTags";
import { logError } from "@/lib/logger";

/** Un compte créé dans Jellyfin est bloqué dans les cinq minutes, sans attendre qu'il se connecte ici. */
const INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 30_000;

interface JellyfinUser {
  Id?: string;
  Name?: string;
  Policy?: { IsAdministrator?: boolean; BlockedTags?: string[] | null } & Record<string, unknown>;
}

/** Les tags à poser, lus à chaque passage : un réglage changé dans l'application vaut tout de suite. */
export function newAccountTags(raw: string = config.accounts.newBlockedTags): string[] {
  return [...new Set(raw.split(/[,\n]/).map((t) => t.trim()).filter(Boolean))];
}

/** La politique d'un compte avec les tags en plus — `null` s'il les a déjà tous (casse ignorée, comme Jellyfin). */
export function withTags(policy: NonNullable<JellyfinUser["Policy"]>, tags: readonly string[]): JellyfinUser["Policy"] | null {
  const current = (policy.BlockedTags ?? []).filter((t): t is string => typeof t === "string");
  const have = new Set(current.map((t) => t.toLowerCase()));
  const missing = tags.filter((t) => !have.has(t.toLowerCase()));
  return missing.length === 0 ? null : { ...policy, BlockedTags: [...current, ...missing] };
}

/**
 * Un passage : lit les comptes Jellyfin, pose les tags sur ceux qu'on découvre, et les note comme
 * connus. Le tout premier passage ne fait que noter.
 */
export async function applyNewAccountTags(): Promise<{ tagged: string[] }> {
  const base = config.jellyfin.url;
  const headers = jellyfinAuthHeaders(config.jellyfin.apiKey);
  const tagged: string[] = [];
  let users: JellyfinUser[];
  try {
    const res = await fetch(`${base}/Users`, { headers, signal: upstreamSignal(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GET /Users : HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    users = Array.isArray(body) ? (body as JellyfinUser[]) : [];
  } catch (err) {
    logError("jellyfin.new-account-tags", err);
    return { tagged };
  }
  const valid = users.filter((u): u is JellyfinUser & { Id: string } => typeof u.Id === "string" && u.Id.length > 0);
  // Première fois : tout ce qui existe est connu, et rien n'est modifié.
  if (knownAccountsDb.isEmpty()) {
    knownAccountsDb.addAll(valid.map((u) => u.Id));
    return { tagged };
  }
  const tags = newAccountTags();
  for (const user of valid) {
    if (knownAccountsDb.has(user.Id)) continue;
    try {
      const policy = user.Policy && !user.Policy.IsAdministrator && tags.length > 0 ? withTags(user.Policy, tags) : null;
      if (policy) {
        const res = await fetch(`${base}/Users/${jellyfinIdSegment(user.Id)}/Policy`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(policy),
          signal: upstreamSignal(UPSTREAM_TIMEOUT_MS),
        });
        // Pas noté comme connu en cas d'échec : le passage suivant réessaie.
        if (!res.ok) throw new Error(`POST /Users/…/Policy : HTTP ${res.status}`);
        tagged.push(user.Name ?? user.Id);
        logAuthEvent("new-account-tags", { user: user.Name ?? user.Id, tags });
      }
      knownAccountsDb.addAll([user.Id]);
    } catch (err) {
      logError("jellyfin.new-account-tags", err, { user: user.Name });
    }
  }
  // Le cinéma relit les tags bloqués toutes les deux minutes : qu'il voie ceux-ci dès maintenant.
  if (tagged.length > 0) forgetBlockedTags();
  return { tagged };
}

export function startNewAccountTagsCron(): void {
  const run = () => void applyNewAccountTags().catch((err) => logError("jellyfin.new-account-tags", err));
  const startup = setTimeout(run, STARTUP_DELAY_MS);
  startup.unref?.();
  const interval = setInterval(run, INTERVAL_MS);
  interval.unref?.();
}
