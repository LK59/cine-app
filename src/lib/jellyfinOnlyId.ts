/**
 * L'identifiant de catalogue d'un titre que Jellyfin a seul (DECISIONS.md §89).
 *
 * Le catalogue range ses films par identifiant Radarr et ses séries par identifiant Sonarr — clés
 * des rangées, des fiches (`#film=…`), de « Reprendre » (`/radarr/…`), des listes. Un titre que ni
 * l'un ni l'autre ne connaît (*La casa de papel*, rangée à la main dans Jellyfin) n'en a pas : il
 * reçoit un nombre de la plage réservée, au-delà d'un milliard — aucune installation n'atteindra
 * jamais un milliard d'entrées Radarr —, tiré du hachage de son identifiant Jellyfin pour rester le
 * même d'un chargement à l'autre (un lien gardé, une fiche rouverte, un cache sur l'appareil).
 *
 * Sans dépendance : les écrans le lisent aussi, pour ne pas demander à Sonarr ce qu'il n'a pas.
 */
export const JELLYFIN_ONLY_ID_BASE = 1_000_000_000;
/** La largeur de la plage : jusqu'à 1 999 999 999, sous 2³¹ — un entier sûr partout, SQLite compris. */
export const JELLYFIN_ONLY_ID_SPAN = 1_000_000_000;

export function isJellyfinOnlyId(id: number | null | undefined): boolean {
  return typeof id === "number" && id >= JELLYFIN_ONLY_ID_BASE;
}

/** FNV-1a sur 32 bits : stable, sans dépendance, et largement assez dispersé pour quelques titres. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Le premier identifiant proposé pour cet élément Jellyfin — `assignJellyfinOnlyIds` règle les collisions. */
export function jellyfinOnlyIdFor(jellyfinId: string): number {
  return JELLYFIN_ONLY_ID_BASE + (fnv1a(jellyfinId.toLowerCase()) % JELLYFIN_ONLY_ID_SPAN);
}

/**
 * Un identifiant par élément, sans collision avec ceux déjà pris (`taken`) ni entre eux.
 *
 * Les éléments sont servis dans l'ordre de leur identifiant Jellyfin, pas dans celui de la liste :
 * deux éléments qui se disputent un nombre le reçoivent toujours dans le même ordre, quel que soit
 * l'ordre dans lequel Jellyfin les a rendus. Le perdant prend le suivant libre, et la collision est
 * rapportée (`onCollision`) — elle déplace un identifiant, ce qui casse un lien gardé : on veut le savoir.
 */
export function assignJellyfinOnlyIds(
  jellyfinIds: readonly string[],
  taken: ReadonlySet<number>,
  onCollision?: (jellyfinId: string, wanted: number, given: number) => void
): Map<string, number> {
  const used = new Set(taken);
  const out = new Map<string, number>();
  for (const jellyfinId of [...new Set(jellyfinIds)].sort()) {
    const wanted = jellyfinOnlyIdFor(jellyfinId);
    let id = wanted;
    while (used.has(id)) id = id + 1 >= JELLYFIN_ONLY_ID_BASE + JELLYFIN_ONLY_ID_SPAN ? JELLYFIN_ONLY_ID_BASE : id + 1;
    if (id !== wanted) onCollision?.(jellyfinId, wanted, id);
    used.add(id);
    out.set(jellyfinId, id);
  }
  return out;
}
