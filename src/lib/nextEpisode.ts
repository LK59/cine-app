import type { CinemaSeason } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";

/**
 * L'épisode qui suit, pour l'enchaînement automatique du lecteur — écrit une fois.
 *
 * Il était recopié à l'identique dans la fiche série, sa jumelle mobile et « lire la suite » depuis
 * une rangée : trois copies d'une même règle, sans un test. Elles disaient encore la même chose le
 * 21/09 ; c'est précisément le moment de n'en garder qu'une, avant que l'une d'elles apprenne
 * quelque chose que les autres ignorent.
 *
 * L'ordre est celui des saisons puis des épisodes, tel que la route les rend : la fin d'une saison
 * enchaîne sur le premier épisode de la suivante. Après le dernier, rien — le lecteur s'arrête.
 */
export function nextEpisodeIn(seasons: CinemaSeason[]) {
  const flat = seasons.flatMap((season) => season.episodes);
  return (currentItemId: string): { itemId: string; title: string } | null => {
    const index = flat.findIndex((episode) => episode.jellyfinItemId === currentItemId);
    if (index === -1 || index === flat.length - 1) return null;
    const next = flat[index + 1];
    return { itemId: next.jellyfinItemId, title: next.title };
  };
}
