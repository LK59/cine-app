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
 *
 * Les épisodes spéciaux (saison 0) ont leur propre chaîne, sans rejoindre celle des saisons : la
 * route les range en dernier, et le dernier épisode d'une série enchaînait donc sur le premier
 * spécial (relevé le 23/09/2026). Un spécial, lui, enchaîne sur le spécial suivant.
 */
export function nextEpisodeIn(seasons: CinemaSeason[]) {
  const regular = seasons.filter((season) => season.seasonNumber !== 0).flatMap((season) => season.episodes);
  const specials = seasons.filter((season) => season.seasonNumber === 0).flatMap((season) => season.episodes);
  return (currentItemId: string): { itemId: string; title: string } | null => {
    const chain = regular.some((episode) => episode.jellyfinItemId === currentItemId) ? regular : specials;
    const index = chain.findIndex((episode) => episode.jellyfinItemId === currentItemId);
    if (index === -1 || index === chain.length - 1) return null;
    const next = chain[index + 1];
    return { itemId: next.jellyfinItemId, title: next.title };
  };
}

/**
 * Le premier épisode d'une série — celui qu'on relance quand tout a été vu.
 *
 * Jellyfin ne propose plus rien « à suivre » pour une série marquée vue en entier : le bouton
 * Lire des fiches disparaissait avec lui, et la série ne se relançait plus que par la liste des
 * épisodes (22/09/2026). La première saison ordinaire, pas les spéciaux : l'ordre des saisons est
 * celui de la route, spéciaux en dernier — une série qui n'a que des spéciaux repart du premier.
 */
export function firstEpisodeOf(seasons: CinemaSeason[]): CinemaSeason["episodes"][number] | null {
  const season = seasons.find((s) => s.seasonNumber !== 0 && s.episodes.length > 0) ?? seasons.find((s) => s.episodes.length > 0);
  return season?.episodes[0] ?? null;
}

