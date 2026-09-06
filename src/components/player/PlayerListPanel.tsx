"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { cinemaNavigate, openLibraryTitle } from "@/lib/cinemaRoute";
import { Search } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { usePlayerTitleActions } from "@/lib/usePlayerTitleActions";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { PlayerResultCard } from "./PlayerResultCard";
import { PlayerRequestCard } from "./PlayerRequestCard";
import type { PlayerListsPayload, PlayerListItem } from "@/app/api/player/lists/route";

type Segment = "requests" | "toWatch" | "watched" | "abandoned" | "favorites";

const SEGMENTS: Segment[] = ["requests", "toWatch", "watched", "abandoned", "favorites"];

/**
 * « Ma liste » — les cinq segments.
 *
 * Les demandes sont ici plutôt que dans une section à elles, et c'est un choix : de son côté, la
 * personne n'a qu'une question, « où sont mes trucs », et elle mérite une seule réponse. Elles
 * sont en première position parce que ce sont les seules qui bougent toutes seules, et elles
 * portent une pastille quand quelque chose est arrivé.
 *
 * Chaque segment lit sa propre source (voir /api/player/lists), mais rien de tout ça ne se voit :
 * cinq onglets, la même carte partout, et deux phrases pour dire ce qui a besoin d'être dit.
 */
export function PlayerListPanel({ leaving }: { leaving?: boolean }) {
  const t = useT();
  const { data, isLoading } = useSWR<PlayerListsPayload>("/api/player/lists", fetcher, {
    revalidateOnFocus: false,
  });
  const { busy, cancelRequest } = usePlayerTitleActions(null);
  // Aucun onglet n'est choisi d'avance : on ouvre sur le premier qui a quelque chose à montrer,
  // en commençant par les demandes. Atterrir sur un écran vide alors que trois onglets plus loin
  // il y a quarante titres, c'est donner l'impression que la page est cassée.
  const [chosen, setChosen] = useState<Segment | null>(null);

  const counts = useMemo(
    () => ({
      requests: data?.requests.length ?? 0,
      toWatch: data?.toWatch.length ?? 0,
      watched: data?.watched.length ?? 0,
      abandoned: data?.abandoned.length ?? 0,
      favorites: data?.favorites.length ?? 0,
    }),
    [data]
  );

  // Ce qui vient d'arriver, et rien d'autre.
  //
  // La pastille comptait toutes les demandes abouties : au bout de quelques mois elle affichait
  // « 44 » en permanence, c'est-à-dire plus rien du tout. La fenêtre de sept jours est calculée
  // côté serveur (voir `justArrived`), où « maintenant » a une valeur stable.
  const arrived = data?.requests.filter((r) => r.justArrived).length ?? 0;

  // Déduit au rendu, jamais corrigé dans un effet : la valeur suit l'arrivée des données sans
  // provoquer de rendu en cascade, et un choix explicite l'emporte pour toujours.
  const segment: Segment = chosen ?? SEGMENTS.find((key) => counts[key] > 0) ?? "requests";

  // Une fiche s'ouvre *par-dessus* Ma liste, sans la refermer : le retour du navigateur ramène
  // alors sur la liste, à son onglet, au lieu de sauter à l'accueil.
  //
  // Et `openLibraryTitle` emporte l'onglet films/séries avec l'identifiant — c'est ce qui manquait :
  // une série ouverte depuis une liste consultée côté films ne se résolvait pas, donc rien ne
  // s'ouvrait et on retombait sur l'accueil.
  function open(item: { type: "movie" | "series"; libraryId: number | null; tmdbId: number | null }) {
    if (item.libraryId !== null) {
      openLibraryTitle(item.type, item.libraryId);
      return;
    }
    // Absent de la bibliothèque : sa fiche TMDB, où « Lire » est devenu « Demander ».
    if (item.tmdbId) cinemaNavigate({ discover: item.tmdbId, discoverType: item.type });
  }

  const items: PlayerListItem[] =
    segment === "requests" ? [] : (data?.[segment] ?? []);

  return (
    <PlayerPanelFrame
      leaving={leaving}
      title={t("player.nav.myList")}
      // Ajouter un titre, c'est le chercher : le bouton ouvre la recherche plutôt que d'installer
      // un second champ ici. Elle trouve déjà tout — la bibliothèque, le reste du monde, les
      // gens — et ce qu'elle ne trouve pas chez nous, sa fiche propose de le demander.
      actions={
        <button
          type="button"
          onClick={() => cinemaNavigate({ list: false, search: true })}
          className="btn btn-ghost btn-sm"
        >
          <Search size={15} />
          <span className="hidden sm:inline">{t("player.lists.addTitle")}</span>
        </button>
      }
    >
      <div className="mx-auto w-full max-w-6xl">
        {/* Une seule ligne qui défile plutôt que cinq pastilles réparties sur trois rangs : sur
            téléphone, l'en-tête reprenait un tiers de l'écran avant la première affiche.

            Le fondu sur le bord droit dit que la ligne continue. Sans lui, le dernier onglet
            arrivait coupé en plein mot contre le bord de l'écran, ce qui se lit comme un défaut
            d'affichage et non comme une invitation à faire glisser. */}
        <div className="relative -mx-1">
          <div className="scrollbar-none flex gap-2 overflow-x-auto px-1 pb-1">
            {SEGMENTS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setChosen(key)}
                aria-pressed={segment === key}
                className={`shrink-0 whitespace-nowrap ${segment === key ? "chip chip-on" : "chip"}`}
              >
                {t(`player.lists.${key}`)}
                <span className="ml-1.5 tabular-nums opacity-60">{counts[key]}</span>
                {/* Un point, plus un second nombre. « Demandes 47 · 1 » posait deux chiffres côte à
                    côte sans dire lequel était quoi ; le point ne dit qu'une chose — il y a du
                    nouveau — et laisse le compte être le seul nombre de l'onglet. Combien de
                    nouveautés se lit à l'intérieur, sur les cartes elles-mêmes. */}
                {key === "requests" && arrived > 0 && (
                  <span
                    aria-label={t("player.lists.arrivedBadge", { n: arrived })}
                    className="ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400"
                  />
                )}
              </button>
            ))}
          </div>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-ink to-transparent" />
        </div>

        {/* Une phrase par segment qui en a besoin, à l'endroit où la question se pose. */}
        {segment === "requests" && (
          <p className="mt-5 text-sm text-slate-400">{t("player.lists.requestsHint")}</p>
        )}
        {segment === "favorites" && (
          <p className="mt-5 text-sm text-slate-400">{t("player.lists.favoritesHint")}</p>
        )}
        {segment === "watched" && (
          <p className="mt-5 text-sm text-slate-400">{t("player.lists.watchedHint")}</p>
        )}

        {isLoading && (
          <div className="mt-12 flex justify-center">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          </div>
        )}

        {!isLoading && counts[segment] === 0 && (
          <p className="mt-10 text-sm text-slate-500">{t(`player.lists.empty.${segment}`)}</p>
        )}

        {segment === "requests" && counts.requests > 0 && (
          <div className="player-grid mt-6 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {data?.requests.map((r) => (
              <PlayerRequestCard
                key={r.id}
                request={r}
                busy={busy}
                onCancel={() => void cancelRequest(r.id)}
                onOpen={() => open(r)}
              />
            ))}
          </div>
        )}

        {segment !== "requests" && items.length > 0 && (
          <div className="player-grid mt-6 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {items.map((item) => (
              <PlayerResultCard
                key={`${item.type}-${item.tmdbId ?? item.jellyfinId}`}
                kind={item.type}
                title={item.title}
                subtitle={item.year ? String(item.year) : null}
                poster={item.poster}
                // Ce qui vient de Jellyfin est dans la bibliothèque par construction : lui coller
                // « Pas encore là » sur un film qu'on vient de finir n'aurait aucun sens, même
                // dans le cas rare où Radarr ne le connaît pas et où la fiche n'est donc pas
                // ouvrable.
                missing={item.libraryId === null && item.jellyfinId === null}
                onOpen={() => open(item)}
              />
            ))}
          </div>
        )}
      </div>
    </PlayerPanelFrame>
  );
}
