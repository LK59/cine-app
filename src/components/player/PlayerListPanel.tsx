"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { cinemaNavigate, openLibraryTitle } from "@/lib/cinemaRoute";
import { Search, Plus, Bookmark, Inbox, Eye, CircleSlash, Heart } from "lucide-react";
import { BROWSE_ALL } from "@/lib/cinemaBrowse";
import { filterByTitle, sortList, LIST_SORTS, type ListSort } from "@/lib/playerListSort";
import { PlayerEmptyState } from "./PlayerEmptyState";
import { PlayerListAdd } from "./PlayerListAdd";
import { useT } from "@/components/TranslationProvider";
import { usePlayerTitleActions } from "@/lib/usePlayerTitleActions";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { PlayerResultCard } from "./PlayerResultCard";
import { PlayerRequestCard } from "./PlayerRequestCard";
import type { PlayerListsPayload, PlayerListItem } from "@/app/api/player/lists/route";

type Segment = "requests" | "toWatch" | "watched" | "abandoned" | "favorites";

const SEGMENTS: Segment[] = ["toWatch", "requests", "watched", "abandoned", "favorites"];

/** Une image par vide : un écran qui ne porte qu'une phrase grise ressemble à un chargement raté. */
const EMPTY_ICON: Record<Segment, React.ElementType> = {
  toWatch: Bookmark,
  requests: Inbox,
  watched: Eye,
  abandoned: CircleSlash,
  favorites: Heart,
};

/**
 * « Ma liste » — les cinq segments.
 *
 * Les demandes sont ici plutôt que dans une section à elles, et c'est un choix : de son côté, la
 * personne n'a qu'une question, « où sont mes trucs », et elle mérite une seule réponse.
 *
 * « À voir » ouvre la liste, et les demandes viennent juste après. Ce qu'on vient chercher ici,
 * c'est ce qu'on s'est promis de regarder ; une demande, on sait déjà qu'on l'a faite, et le point
 * vert de son onglet suffit à dire quand elle a abouti.
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
  // en commençant par « À voir ». Atterrir sur un écran vide alors que trois onglets plus loin il
  // y a quarante titres, c'est donner l'impression que la page est cassée.
  const [chosen, setChosen] = useState<Segment | null>(null);

  /**
   * Chercher dans la liste, trier la liste.
   *
   * Deux réglages qui ne changent pas d'écran, donc qui ne vont pas dans l'adresse : les mettre
   * dans l'historique ferait du bouton retour une machine à défaire des réglages. Ils survivent
   * en revanche à un changement d'onglet, parce que « je cherche Batman » ne cesse pas d'être vrai
   * en passant de « À voir » à « Vu ».
   */
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ListSort>("added");

  /**
   * Le mode « ajouter », dans cet écran plutôt qu'ailleurs.
   *
   * Le « + » ouvrait la recherche générale : chercher, ouvrir la fiche, y trouver « Dans ma
   * liste » — trois écrans pour ranger un titre qu'on avait déjà en tête. Il ouvre maintenant une
   * recherche ici même, où chaque résultat porte son propre « + ».
   */
  const [adding, setAdding] = useState(false);

  /** Ce qui est déjà rangé, pour que la recherche le montre coché plutôt que de l'offrir. */
  const alreadyListed = useMemo(
    () => new Set((data?.toWatch ?? []).map((i) => `${i.type}-${i.tmdbId}`)),
    [data]
  );

  // Les comptes suivent la recherche : un onglet qui annonce huit titres et n'en montre aucun,
  // parce qu'on filtre, dit quelque chose de faux au moment où on a le plus besoin d'y croire.
  const counts = useMemo(
    () => ({
      requests: filterByTitle(data?.requests ?? [], query).length,
      toWatch: filterByTitle(data?.toWatch ?? [], query).length,
      watched: filterByTitle(data?.watched ?? [], query).length,
      abandoned: filterByTitle(data?.abandoned ?? [], query).length,
      favorites: filterByTitle(data?.favorites ?? [], query).length,
    }),
    [data, query]
  );

  // Ce qui vient d'arriver, et rien d'autre.
  //
  // La pastille comptait toutes les demandes abouties : au bout de quelques mois elle affichait
  // « 44 » en permanence, c'est-à-dire plus rien du tout. La fenêtre de sept jours est calculée
  // côté serveur (voir `justArrived`), où « maintenant » a une valeur stable.
  const arrived = data?.requests.filter((r) => r.justArrived).length ?? 0;

  // Déduit au rendu, jamais corrigé dans un effet : la valeur suit l'arrivée des données sans
  // provoquer de rendu en cascade, et un choix explicite l'emporte pour toujours.
  // Le repli est le premier onglet et non un nom écrit en dur : tout vide, on ouvre sur « À
  // voir », qui est aussi celui qu'on trouve en premier quand il y a quelque chose.
  const segment: Segment = chosen ?? SEGMENTS.find((key) => counts[key] > 0) ?? SEGMENTS[0];

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

  /**
   * Les trois chiffres du haut.
   *
   * Ce qu'on veut savoir en arrivant : combien j'en ai mis de côté, combien je peux lancer tout
   * de suite, combien j'ai déjà vu. Le deuxième est le seul actionnable — c'est lui qui a droit à
   * la couleur.
   */
  const stats = useMemo(
    () => ({
      total: data?.toWatch.length ?? 0,
      available: data?.toWatch.filter((i) => i.libraryId !== null).length ?? 0,
      watched: data?.watched.length ?? 0,
    }),
    [data]
  );

  const items: PlayerListItem[] = useMemo(() => {
    const source = segment === "requests" ? [] : (data?.[segment] ?? []);
    return sortList(filterByTitle(source, query), sort);
  }, [data, segment, query, sort]);

  /** Les demandes suivent la même recherche : c'est le même écran, et la même question. */
  const shownRequests = useMemo(
    () => filterByTitle(data?.requests ?? [], query),
    [data, query]
  );

  return (
    <PlayerPanelFrame
      leaving={leaving}
      title={t("player.nav.myList")}
      subtitle={t("player.lists.subtitle")}
    >
      <div className="mx-auto w-full max-w-6xl">
        {/* Trois chiffres avant tout le reste : on sait ce qu'on a avant de savoir où le trouver. */}
        <div className="mb-4 grid grid-cols-3 gap-2.5">
          <StatCard value={stats.total} label={t("player.lists.stats.inList")} />
          <StatCard value={stats.available} label={t("player.lists.stats.available")} highlight />
          <StatCard value={stats.watched} label={t("player.lists.stats.watched")} />
        </div>

        {/* Chercher, trier, ajouter — sur une ligne. Cette recherche-ci ne fouille que la liste ;
            le « + » en ouvre une autre, qui cherche partout pour y ajouter. La ligne s'efface
            pendant ce temps : deux champs à l'écran, on ne saurait plus lequel filtre quoi. */}
        {!adding && (
        <div className="mb-4 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("player.lists.searchInList")}
              className="input h-10 w-full pl-9 text-sm"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as ListSort)}
            aria-label={t("player.lists.sort")}
            className="select h-10 shrink-0 text-sm"
          >
            {LIST_SORTS.map((key) => (
              <option key={key} value={key}>
                {t(`player.lists.sorts.${key}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label={t("player.lists.addTitle")}
            title={t("player.lists.addTitle")}
            className="btn-primary h-10 w-10 shrink-0 justify-center p-0"
          >
            <Plus size={18} />
          </button>
        </div>
        )}

        {/* La recherche d'ajout remplace la liste tant qu'elle est ouverte : deux champs et deux
            grilles à l'écran au même moment, on ne saurait plus lequel filtre quoi. */}
        {adding && <PlayerListAdd existing={alreadyListed} onClose={() => setAdding(false)} />}

        {!adding && (
          <>
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
                data-nav-item
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
          <PlayerEmptyState
            icon={EMPTY_ICON[segment]}
            message={t(`player.lists.empty.${segment}`)}
            action={
              // « Abandonné » est le seul vide qu'on ne cherche pas à remplir : proposer d'y
              // ajouter quelque chose serait une drôle d'invitation.
              segment === "abandoned"
                ? null
                : segment === "requests" || segment === "toWatch"
                  ? { label: t("player.lists.addTitle"), onClick: () => cinemaNavigate({ list: false, search: true }) }
                  : { label: t("player.browse.seeAll"), onClick: () => cinemaNavigate({ list: false, browse: BROWSE_ALL }) }
            }
          />
        )}

        {segment === "requests" && counts.requests > 0 && (
          <div className="player-grid mt-6 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {shownRequests.map((r) => (
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
          </>
        )}
      </div>
    </PlayerPanelFrame>
  );
}


/** Un chiffre et ce qu'il compte. Le seul actionnable — ce qu'on peut lancer — porte la couleur. */
function StatCard({ value, label, highlight = false }: { value: number; label: string; highlight?: boolean }) {
  return (
    <div
      className={`rounded-xl border px-3 py-3 ${
        highlight && value > 0 ? "border-emerald-500/25 bg-emerald-500/5" : "border-white/10 bg-white/5"
      }`}
    >
      <p className={`text-2xl font-semibold tabular-nums ${highlight && value > 0 ? "text-emerald-400" : "text-white"}`}>
        {value}
      </p>
      <p className="mt-0.5 truncate text-xs text-slate-500">{label}</p>
    </div>
  );
}
