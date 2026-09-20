"use client";

import { mutate } from "swr";
import { TO_WATCH_KEY } from "@/lib/swr";
import type { WatchlistItem, WatchlistStatus } from "@/lib/db";

/**
 * Ce qu'il faut faire des vues quand on range un titre dans une liste — écrit **une fois**.
 *
 * Deux crochets posent ce geste : celui des fiches du mode cinéma (`useAddToWatchlist`) et celui
 * du lecteur (`usePlayerTitleActions`). Ils avaient deux comportements différents, et c'est
 * exactement la dérive que ce dépôt paie le plus cher : depuis le lecteur, les vues se
 * rafraîchissaient ; depuis une fiche cinéma, **rien ne bougeait** — la rangée « Ma liste » de
 * l'accueil ignorait l'ajout jusqu'au prochain chargement de la page. Signalé le 20/09/2026.
 *
 * Deux temps, et les deux comptent :
 *
 *  1. **La rangée de l'accueil change tout de suite**, sans attendre le serveur. C'est la seule
 *     vue qu'on regarde au moment du geste, et une rangée qui met une seconde à apparaître se lit
 *     comme une panne. Elle se crée même quand elle n'existait pas — une rangée vide ne se dessine
 *     pas, donc le premier titre ajouté la fait naître.
 *  2. **Tout le reste se relit ensuite**, y compris la vue agrégée du lecteur et la fiche ouverte.
 *     C'est ce qui remplace l'ébauche optimiste par la vraie ligne, avec son identifiant et ses
 *     dates, et ce qui rattrape un ajout fait depuis un autre appareil au même moment.
 *
 * L'ébauche ne porte que ce dont la rangée a besoin — le type et l'identifiant TMDB (voir
 * `useCinemaMyList`, qui ne lit rien d'autre). Le reste est rempli de valeurs neutres plutôt que
 * deviné : c'est une ligne qui vivra le temps d'un aller-retour.
 */
export type WatchlistRef = {
  tmdbId: number;
  mediaType: "movie" | "series";
  title?: string;
  year?: number | null;
  posterPath?: string | null;
  voteAverage?: number | null;
};

function ebauche(ref: WatchlistRef, status: WatchlistStatus): WatchlistItem {
  const now = Date.now();
  return {
    // Négatif, et c'est délibéré : aucune ligne réelle ne porte cet identifiant, donc rien ne peut
    // le confondre avec une ligne du serveur pendant le court instant où les deux coexistent.
    id: -ref.tmdbId,
    userId: "",
    mediaType: ref.mediaType,
    tmdbId: ref.tmdbId,
    tvdbId: null,
    title: ref.title ?? "",
    year: ref.year ?? null,
    posterPath: ref.posterPath ?? null,
    voteAverage: ref.voteAverage ?? null,
    status,
    note: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Toutes les vues qui montrent une liste, quelle que soit leur source : la liste locale (dont la
 * clé porte le statut demandé), la vue agrégée du lecteur, et la fiche ouverte s'il y en a une.
 *
 * Oublier la vue agrégée avait été le défaut le plus prévisible de son lot : on ajoutait un titre
 * à « À voir » et l'onglet d'à côté continuait de dire qu'il n'y avait rien. D'où le filtre par
 * préfixe plutôt qu'une liste de clés à tenir à jour.
 *
 * Exportée pour la demande d'un titre, qui touche les mêmes vues sans rien changer à la liste.
 */
export function refreshWatchlistViews(): void {
  void mutate(
    (key) =>
      typeof key === "string" &&
      (key.startsWith("/api/watchlist") ||
        key === "/api/player/lists" ||
        key.startsWith("/api/player/title/"))
  );
}

export function noteWatchlistChange(ref: WatchlistRef, status: WatchlistStatus | null): void {
  void mutate<{ items: WatchlistItem[] }>(
    TO_WATCH_KEY,
    (current) => {
      const items = current?.items ?? [];
      const sans = items.filter((i) => !(i.tmdbId === ref.tmdbId && i.mediaType === ref.mediaType));
      // Seul « à voir » peuple cette rangée : toute autre issue — « vu », « abandonné », ou plus
      // de statut du tout — l'en retire.
      return { items: status === "to_watch" ? [ebauche(ref, status), ...sans] : sans };
    },
    { revalidate: false }
  );
  refreshWatchlistViews();
}
