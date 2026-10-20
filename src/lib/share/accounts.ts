import { sharesDb } from "@/lib/share/store";

/**
 * Un compte Jellyfin qui est celui d'un lien de partage (DECISIONS.md §112) — à écarter de tout ce
 * qui parcourt les comptes du foyer : l'Activité, les nouveautés, l'accueil des nouveaux, les
 * notifications, le blocage des tags des nouveaux comptes. Ce n'est pas une personne du foyer.
 *
 * La base d'abord ; le nom (`partage-` et huit chiffres hexadécimaux, celui que
 * `createShareAccount` donne) couvre l'instant entre la création chez Jellyfin et la ligne en base.
 */
const SHARE_ACCOUNT_NAME = /^partage-[0-9a-f]{8}$/;

export function shareAccountFilter(): (user: { Id?: string | null; Name?: string | null }) => boolean {
  // Une base illisible ne doit pas faire tomber la liste des comptes : le nom suffit alors.
  let ids = new Set<string>();
  try {
    ids = sharesDb.jellyfinUserIds();
  } catch {
    /* le nom seul */
  }
  return (user) => (!!user.Id && ids.has(user.Id)) || (typeof user.Name === "string" && SHARE_ACCOUNT_NAME.test(user.Name));
}

/** Les comptes du foyer seulement. */
export function withoutShareAccounts<T extends { Id?: string | null; Name?: string | null }>(users: readonly T[]): T[] {
  const isShare = shareAccountFilter();
  return users.filter((u) => !isShare(u));
}
