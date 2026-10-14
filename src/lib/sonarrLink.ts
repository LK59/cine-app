import { catalogueMembers, type CatalogueLink } from "@/lib/catalogueMembers";

/**
 * D'un élément Jellyfin à sa fiche du catalogue — **par le dossier** (DECISIONS.md §89).
 *
 * Les deux flux de reprise en ont besoin — « Reprendre » pour un épisode commencé ou un film,
 * « À suivre » pour le prochain épisode — et le calculaient chacun de leur côté jusqu'au 24/09/2026,
 * puis ensemble par les identifiants que Jellyfin pose sur la série (TVDB → Sonarr). Or ces
 * identifiants sont ceux que Jellyfin a *compris* : une série qu'il avait prise pour une autre
 * (*Shōgun* 2024 lue comme celle de 1980, *Engrenages* comme une autre *Spiral*) donnait une carte de
 * reprise qui n'ouvrait rien, et un film mal identifié pouvait ouvrir la fiche d'un autre.
 *
 * Le lien vient maintenant du catalogue lui-même (`catalogueMembers().byJellyfinId`) : l'élément que
 * le rapprochement par dossier a donné à chaque titre de Radarr/Sonarr, et les titres que Jellyfin a
 * seul. Une seule carte, que tout ce qui relie Jellyfin au catalogue lit — la reprise, « À suivre »,
 * le « vu » (`libraryIndex`).
 */
export async function catalogueLinks(): Promise<Map<string, CatalogueLink>> {
  return (await catalogueMembers().catch(() => null))?.byJellyfinId ?? new Map();
}

/** L'adresse de fiche que les cartes de reprise portent (`/radarr/…`, `/sonarr/…`). */
export function cinemaHrefOf(link: CatalogueLink | undefined): string | null {
  if (!link) return null;
  return `/${link.type === "movie" ? "radarr" : "sonarr"}/${link.catalogueId}`;
}

/** L'identifiant de fiche de chaque série, par son identifiant Jellyfin — seulement celles du catalogue. */
export async function seriesCatalogueIds(seriesIds: string[]): Promise<Map<string, number>> {
  const links = await catalogueLinks();
  const out = new Map<string, number>();
  for (const seriesId of new Set(seriesIds)) {
    const link = links.get(seriesId);
    if (link?.type === "series") out.set(seriesId, link.catalogueId);
  }
  return out;
}
