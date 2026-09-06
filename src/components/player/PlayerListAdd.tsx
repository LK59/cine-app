"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Plus, Check, X, Loader2 } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { cinemaNavigate, openLibraryTitle } from "@/lib/cinemaRoute";
import { PosterImage } from "@/components/PosterImage";
import { usePlayerTitleActions } from "@/lib/usePlayerTitleActions";
import type { SearchResponse, UnifiedSearchResult } from "@/app/api/search/route";

const TMDB_POSTER = "https://image.tmdb.org/t/p/w154";

/** En dessous de deux lettres, une recherche rend le catalogue entier et n'apprend rien. */
const MIN_QUERY = 2;

/** La même attente que la recherche générale, et pour la même raison — voir son commentaire. */
const DEBOUNCE_MS = 150;

/**
 * Ajouter un titre sans quitter « Ma liste ».
 *
 * Le « + » ouvrait la recherche générale : il fallait chercher, ouvrir la fiche, y trouver le
 * bouton « Dans ma liste » — trois écrans et quatre gestes pour ranger un titre qu'on avait déjà
 * en tête. Ici, on tape, et chaque résultat porte son propre « + ».
 *
 * Une liste et non une grille d'affiches : on cherche un titre qu'on connaît déjà, donc on lit un
 * nom, et une ligne se parcourt plus vite qu'un damier. Le « + » est au même endroit sur chaque
 * ligne, ce qui permet d'en ajouter trois d'affilée sans déplacer le pouce.
 *
 * Ce qui est déjà dans la liste porte une coche à la place, désactivée : on ne peut pas l'ajouter
 * deux fois, et le dire vaut mieux que de laisser essayer.
 */
export function PlayerListAdd({ existing, onClose }: { existing: Set<string>; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const { data, isLoading } = useSWR<SearchResponse>(
    debounced.length >= MIN_QUERY ? `/api/search?q=${encodeURIComponent(debounced)}&type=all` : null,
    fetcher,
    { keepPreviousData: true, revalidateOnFocus: false }
  );

  // La bibliothèque d'abord : ce qu'on possède est ce qu'on ajoutera le plus souvent, et le
  // reste du monde vient ensuite plutôt que mélangé.
  const results: UnifiedSearchResult[] = [...(data?.library ?? []), ...(data?.tmdb ?? [])];

  return (
    <div className="mt-1">
      <div className="flex items-center gap-2">
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("player.lists.addPlaceholder")}
          className="input h-10 min-w-0 flex-1 text-sm"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="btn btn-ghost h-10 w-10 shrink-0 justify-center p-0"
        >
          <X size={18} />
        </button>
      </div>

      {debounced.length < MIN_QUERY ? (
        <p className="px-1 py-10 text-center text-sm text-slate-500">{t("player.lists.addHint")}</p>
      ) : isLoading && results.length === 0 ? (
        <div className="flex justify-center py-10">
          <Loader2 size={20} className="animate-spin text-slate-500" />
        </div>
      ) : results.length === 0 ? (
        <p className="px-1 py-10 text-center text-sm text-slate-500">{t("player.lists.addNothing")}</p>
      ) : (
        <ul className="mt-3 divide-y divide-white/5">
          {results.slice(0, 30).map((result) => (
            <AddRow
              key={`${result.type}-${result.tmdbId}`}
              result={result}
              already={existing.has(`${result.type}-${result.tmdbId}`)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AddRow({ result, already }: { result: UnifiedSearchResult; already: boolean }) {
  const t = useT();
  // Un crochet par ligne : il ne tient qu'un état d'occupation et une poignée de rappels, et c'est
  // ce qui permet à chaque ligne d'avoir son propre bouton sans que la liste tienne un registre.
  const { busy, setStatus } = usePlayerTitleActions({
    tmdbId: result.tmdbId,
    type: result.type,
    title: result.title,
    year: result.year,
    poster: result.posterPath ? `${TMDB_POSTER}${result.posterPath}` : null,
    rating: result.rating,
  });
  const [added, setAdded] = useState(false);
  const done = already || added;

  /**
   * La ligne ouvre la fiche, le « + » range.
   *
   * Deux gestes différents sur la même ligne, et c'est voulu : on cherche parfois pour ajouter
   * sans réfléchir — c'est le « + » — et parfois pour vérifier de quoi il s'agit avant de
   * décider, et il faut alors pouvoir ouvrir la fiche sans repasser par la recherche générale.
   *
   * Ce qu'on possède ouvre sa fiche de bibliothèque, où « Lire » existe ; le reste ouvre sa fiche
   * TMDB, où « Lire » est devenu « Demander ». C'est le même aiguillage que partout ailleurs.
   */
  function open() {
    const libraryId = result.type === "series" ? result.sonarrId : result.radarrId;
    if (libraryId !== null) openLibraryTitle(result.type === "series" ? "series" : "movie", libraryId);
    else cinemaNavigate({ discover: result.tmdbId, discoverType: result.type === "series" ? "series" : "movie" });
  }

  return (
    <li className="flex items-center gap-3 py-2">
      <button
        type="button"
        onClick={open}
        data-nav-item
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left transition-colors active:bg-white/5"
      >
        <span className="h-14 w-10 shrink-0 overflow-hidden rounded bg-white/5">
          <PosterImage
            src={result.posterPath ? `${TMDB_POSTER}${result.posterPath}` : null}
            alt={result.title}
            subtle
            unoptimized
            sizes="40px"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-white">{result.title}</span>
          <span className="block truncate text-xs text-slate-500">
            {[result.year, t(`player.kind.${result.type === "series" ? "series" : "movie"}`)].filter(Boolean).join(" · ")}
            {!result.inLibrary && ` · ${t("player.notInLibrary")}`}
          </span>
        </span>
      </button>
      <button
        type="button"
        disabled={done || busy}
        onClick={() => {
          void setStatus("to_watch");
          // Optimiste, et sans risque : la seule façon d'échouer est un serveur qui refuse, et il
          // le dit alors lui-même par un message. Attendre la réponse pour montrer la coche
          // rendrait l'ajout de trois titres d'affilée poussif pour rien.
          setAdded(true);
        }}
        data-nav-item
        aria-label={done ? t("player.lists.alreadyInList") : t("player.lists.addToWatch")}
        title={done ? t("player.lists.alreadyInList") : t("player.lists.addToWatch")}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
          done ? "text-emerald-400" : "bg-white/10 text-white hover:bg-white/20 active:scale-95"
        }`}
      >
        {done ? <Check size={17} /> : <Plus size={18} />}
      </button>
    </li>
  );
}
