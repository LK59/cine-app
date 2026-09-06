"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PosterImage } from "@/components/PosterImage";
import { useT } from "@/components/TranslationProvider";
import { cinemaNavigate, openLibraryTitle } from "@/lib/cinemaRoute";

/** Le préfixe des affiches TMDB, à la taille des vignettes de rangée — comme la fiche personne. */
const TMDB_POSTER = "https://image.tmdb.org/t/p/w342";

interface CollectionPart {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  inLibrary: boolean;
  libraryHref: string | null;
}

interface CollectionPayload {
  name: string;
  overview: string;
  parts: CollectionPart[];
}

interface MovieInfo {
  collection?: { id: number; name: string } | null;
}

/**
 * La saga du film ouvert, au-dessus des titres similaires.
 *
 * « Titres similaires » propose ce qui ressemble ; celle-ci propose la suite — et c'est une
 * question différente, posée bien plus souvent. Finir un James Bond ne menait nulle part alors
 * que la réponse était déjà dans les données.
 *
 * Contrairement aux titres similaires, elle montre aussi ce qu'on n'a pas : une saga trouée dont
 * on cacherait les trous ferait croire qu'elle est complète. Un épisode absent ouvre sa fiche
 * TMDB, où « Lire » est devenu « Demander » — c'est le même chemin que partout ailleurs.
 *
 * Le film qu'on regarde n'y figure pas : la rangée répond « et ensuite ? », pas « où suis-je ? ».
 */
/**
 * La saga de ce film, sans celui qu'on regarde.
 *
 * Séparé du rendu pour la même raison que les titres similaires : la fiche du bureau doit savoir
 * *avant* de dessiner s'il y aura quelque chose, faute de quoi elle réserve un écran entier de
 * défilement à une rangée vide.
 */
export function useCinemaCollection(radarrId: number): { name: string; parts: CollectionPart[] } {
  // La même clé que la fiche interroge déjà pour la bande-annonce : la réponse est en cache, et
  // cette rangée ne coûte donc pas une requête de plus.
  const { data: info } = useSWR<MovieInfo>(`/api/radarr/movies/${radarrId}/info`, fetcher, {
    revalidateOnFocus: false,
  });
  const collectionId = info?.collection?.id ?? null;
  const { data } = useSWR<CollectionPayload>(
    collectionId ? `/api/tmdb/collection/${collectionId}` : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  return {
    name: data?.name ?? "",
    parts: (data?.parts ?? []).filter((part) => part.libraryHref !== `/radarr/${radarrId}`),
  };
}

export function CinemaCollectionRow({
  name,
  parts,
  onOpenLibrary,
}: {
  name: string;
  parts: CollectionPart[];
  onOpenLibrary?: () => void;
}) {
  const t = useT();
  if (parts.length === 0) return null;

  function open(part: CollectionPart) {
    const owned = part.libraryHref?.match(/^\/radarr\/(\d+)$/);
    if (owned) {
      onOpenLibrary?.();
      openLibraryTitle("movie", Number(owned[1]));
      return;
    }
    cinemaNavigate({ discover: part.tmdbId, discoverType: "movie" });
  }

  return (
    <section className="w-full">
      <h2 className="mb-2 text-sm font-medium text-white/70">{name || t("cinema.collection")}</h2>
      <div className="scrollbar-thin flex gap-3 overflow-x-auto overflow-y-hidden py-4">
        {parts.map((part) => (
          <button
            key={part.tmdbId}
            type="button"
            data-detail-similar
            onClick={() => open(part)}
            className="relative w-24 shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40 outline-none transition-transform hover:scale-105 focus-visible:scale-105 sm:w-28 md:w-32"
          >
            <PosterImage src={part.posterPath ? `${TMDB_POSTER}${part.posterPath}` : null} alt={part.title} subtle unoptimized sizes="120px" />
            {/* Le même signe discret que partout ailleurs pour « on ne l'a pas » — voir la grille
                de Ma liste, où la pastille pleine largeur écrasait les affiches. */}
            {!part.inLibrary && (
              <span className="absolute bottom-1 right-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-accent-200 ring-1 ring-accent-400/40 backdrop-blur-sm">
                {t("player.notInLibrary")}
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * La même rangée, qui va chercher ses données elle-même.
 *
 * La fiche du téléphone empile ses sections sans réserver d'écran à chacune : elle n'a donc pas
 * besoin de savoir d'avance s'il y aura quelque chose, et se passe du crochet séparé.
 */
export function CinemaMovieCollectionRow({ radarrId }: { radarrId: number }) {
  const { name, parts } = useCinemaCollection(radarrId);
  return <CinemaCollectionRow name={name} parts={parts} />;
}
