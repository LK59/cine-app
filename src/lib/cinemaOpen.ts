"use client";

import { cinemaNavigate, openLibraryTitle } from "@/lib/cinemaRoute";
import type { DiscoveryItem } from "@/app/api/player/discover/route";

/**
 * Les gestes d'ouverture que les deux écrans cinéma partagent.
 *
 * `CLAUDE.md` nomme la dette de ce dépôt : « the same decision is made in several places, and
 * they drift ». Ces trois-là l'attendaient. Relevé le 20/09/2026 en comparant les deux clients :
 * `openDiscovery` était **identique octet pour octet** des deux côtés, `openResume` ne différait
 * que par une écriture de focus propre au clavier, et `openDetail` avait **déjà divergé** — le
 * bureau ne savait ouvrir qu'un film et omettait l'onglet, le mobile prenait les deux et le
 * posait.
 *
 * Et tous écrivaient l'adresse à la main plutôt que de passer par `openLibraryTitle`, qui existe
 * précisément pour porter l'onglet — et qui, depuis, referme aussi ce qui couvre la fiche. Ça ne
 * cassait rien : les deux résolveurs tolèrent un onglet qui ne correspond pas, le mobile par le
 * repli de `sheetTarget`, le bureau parce qu'il résout par champ sans regarder l'onglet. Mais
 * c'était la forme exacte du défaut corrigé le matin même, survivant à deux endroits et protégé
 * par deux mécanismes différents dont aucun n'est écrit comme une garantie.
 */

/** Un titre de la bibliothèque, quel que soit l'écran qui l'ouvre. */
export function openTitle(type: "movies" | "series", libraryId: number): void {
  openLibraryTitle(type === "series" ? "series" : "movie", libraryId);
}

/**
 * Un titre ouvert depuis *l'intérieur* d'une fiche — titres similaires, saga — sur le bureau.
 *
 * **Sans toucher à l'onglet**, pour la raison même d'`openResumeTarget` : un film ouvert depuis
 * « Reprendre » sur l'onglet Séries laisse l'adresse sur `tab=series`. `openTitle` y réécrivait
 * `tab=movies` en ouvrant le titre similaire, et la pile du bureau, qui ne redessinait la fiche
 * du dessous que si l'onglet de l'entrée recouverte était le bon, la démontait : le retour la
 * remontait de zéro, et la grille derrière changeait d'onglet sous la fiche. Relevé le 21/09/2026.
 *
 * Sûr pour la même raison qu'`openResumeTarget` : le bureau résout les fiches par champ, sans
 * regarder l'onglet, et l'autre champ est effacé. Le téléphone garde son propre chemin
 * (`openLibraryTitle` avec l'onglet), que sa pile lit autrement.
 */
export function openSimilarTitle(type: "movies" | "series", libraryId: number): void {
  const replaced = { person: null, discover: null };
  cinemaNavigate(
    type === "series" ? { ...replaced, serie: libraryId, film: null } : { ...replaced, film: libraryId, serie: null }
  );
}

/**
 * Une suggestion : sa fiche de bibliothèque si on la possède, sa fiche TMDB sinon.
 *
 * C'est la distinction qui fait que « Lire » ne devient « Demander » qu'au bon moment.
 */
export function openDiscoveryItem(item: DiscoveryItem): void {
  if (item.libraryId !== null) {
    openLibraryTitle(item.type, item.libraryId);
    return;
  }
  cinemaNavigate({ discover: item.tmdbId, discoverType: item.type });
}

/**
 * Une carte de « Reprendre » : sa fiche si l'adresse en désigne une, la lecture sinon.
 *
 * Les adresses viennent du serveur sous la forme `/radarr/42` ou `/sonarr/7` — c'est ce que la
 * rangée de reprise porte déjà pour le tableau de bord. Rien ne correspond : c'est qu'il n'y a pas
 * de fiche à ouvrir, et le geste attendu est de lancer.
 *
 * **Sans toucher à l'onglet, et c'est délibéré** — la seule des trois qui n'appelle pas
 * `openLibraryTitle`. Cette rangée est mixte par nature : basculer sur « Séries » pour ouvrir un
 * épisode puis rebasculer en refermant se voyait comme un clignotement de toute la grille
 * derrière la fiche. La décision était prise côté téléphone, expliquée en toutes lettres, et en
 * extrayant ce geste j'ai failli l'effacer au profit d'une uniformité qui aurait coûté ce
 * clignotement. Elle est ici maintenant, une fois, pour les deux écrans.
 *
 * Ce qui la rend sûre : chaque écriture **efface l'autre champ**. Le repli de `sheetTarget` sur
 * téléphone retrouve alors la fiche sans l'onglet, et le bureau résout par champ sans jamais
 * regarder l'onglet. Ce qui couvre la fiche est refermé comme ailleurs.
 */
export function openResumeTarget(href: string | null, play: () => void): void {
  const film = href?.match(/^\/radarr\/(\d+)$/);
  if (film) return cinemaNavigate({ film: Number(film[1]), serie: null, person: null, discover: null });
  const serie = href?.match(/^\/sonarr\/(\d+)$/);
  if (serie) return cinemaNavigate({ serie: Number(serie[1]), film: null, person: null, discover: null });
  play();
}
