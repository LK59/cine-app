import { getTitleArt } from "@/lib/title-art";

/**
 * Le logo d'un titre — une image transparente portant son nom, pas une affiche.
 *
 * Simple façade sur `getTitleArt` depuis que l'affiche sans texte se lit dans la même réponse
 * TMDB : une seule requête et une seule entrée de cache pour les deux. Garder deux fonctions avec
 * deux clés aurait voulu dire deux appels par titre pour la même réponse.
 *
 * Les appelants qui n'ont besoin que du logo — les fiches de la gestion, la bannière du tableau
 * de bord — n'ont rien à changer.
 */
export async function getTitleLogo(tmdbId: number, mediaType: "movie" | "series"): Promise<string | null> {
  return (await getTitleArt(tmdbId, mediaType)).logoUrl;
}
