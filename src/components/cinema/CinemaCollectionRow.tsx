"use client";

import { memo, useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PosterImage } from "@/components/PosterImage";
import type { CinemaMovie, CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
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

/** Le même épisode de saga, une fois confronté à ce que cet écran sait réellement ouvrir. */
interface ResolvedPart extends CollectionPart {
  /**
   * Le titre du catalogue, quand cet écran le connaît — l'objet entier, pas son identifiant.
   *
   * C'est ce que la rangée des titres similaires rend à la fiche, et c'est pour ça qu'on le rend
   * ici aussi : ouvrir depuis une saga et ouvrir depuis les titres similaires doivent emprunter
   * *le même* chemin, pas deux chemins qu'on croit équivalents. Chercher pourquoi la fermeture
   * n'était pas la même revenait à comparer deux trajets ; il n'y en a plus qu'un.
   */
  movie: CinemaMovie | null;
}

interface CollectionPayload {
  name: string;
  overview: string;
  parts: CollectionPart[];
}

/**
 * La réponse de la fiche Radarr, réduite à ce qu'on y cherche.
 *
 * La collection est rangée sous `tmdb`, avec le reste de ce qui vient de là — le synopsis, la
 * distribution, la bande-annonce. La lire à la racine ne renvoyait jamais rien, et une rangée qui
 * n'a pas d'identifiant ne demande rien : elle ne s'affichait donc nulle part, sans erreur.
 */
interface MovieInfo {
  tmdb?: { collection?: { id: number; name: string } | null } | null;
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
export function useCinemaCollection(radarrId: number): { name: string; parts: ResolvedPart[] } {
  // La même clé que la fiche interroge déjà pour la bande-annonce : la réponse est en cache, et
  // cette rangée ne coûte donc pas une requête de plus.
  const { data: info } = useSWR<MovieInfo>(`/api/radarr/movies/${radarrId}/info`, fetcher, {
    // Même raison que ci-dessous : la fiche ouverte au-dessus revalidait cette clé, ce qui rendait
    // un nouvel objet à la fiche du dessous et la faisait se redessiner pendant l'animation.
    revalidateOnFocus: false,
    revalidateIfStale: false,
    keepPreviousData: true,
  });
  const collectionId = info?.tmdb?.collection?.id ?? null;
  const { data } = useSWR<CollectionPayload>(
    collectionId ? `/api/tmdb/collection/${collectionId}` : null,
    fetcher,
    // Lu une fois et gardé : une saga ne change pas pendant qu'on regarde une fiche, et chaque
    // revalidation rend un nouvel objet — donc une nouvelle liste, donc un nouveau rendu de la
    // rangée, au moment précis où la fiche est en train de s'animer.
    { revalidateOnFocus: false, revalidateIfStale: false, keepPreviousData: true }
  );

  /**
   * Ce que cet écran sait réellement ouvrir.
   *
   * La route des collections répond « on l'a » d'après *tout* Radarr. L'écran cinéma, lui, ne
   * connaît que ce qui a un fichier et une correspondance Jellyfin — six cent soixante-quinze
   * titres sur six cent quatre-vingt-dix. Un épisode de saga présent dans Radarr mais absent
   * d'ici s'ouvrait donc sur une fiche que rien ne pouvait résoudre : l'écran restait vide, et la
   * fiche du dessous était démontée avec lui. C'est ce qu'on prenait pour une animation ratée.
   *
   * L'appartenance se décide donc contre le catalogue de cet écran, lu dans le cache comme
   * partout ailleurs. Ce qui n'y est pas ouvre sa fiche TMDB, où « Lire » est devenu « Demander ».
   */
  const { data: catalogue } = useSWR<CinemaMoviesPayload>("/api/cinema/movies", fetcher, {
    revalidateOnMount: false,
    revalidateIfStale: false,
    revalidateOnFocus: false,
  });

  const openableByTmdb = useMemo(() => {
    const map = new Map<number, CinemaMovie>();
    if (!catalogue) return map;
    for (const movie of [...catalogue.spotlight, ...Object.values(catalogue.rows).flat()]) {
      if (movie.tmdbId) map.set(movie.tmdbId, movie);
    }
    return map;
  }, [catalogue]);

  /**
   * La liste, calculée une fois par réponse.
   *
   * Sans ce `useMemo`, elle rendait un tableau neuf à *chaque* rendu de la fiche — et une fiche de
   * téléphone se redessine à chaque pixel du geste de fermeture, puisque le glissement vit dans
   * son état. La rangée mémoïsée ci-dessous n'aurait alors jamais rien mémoïsé.
   */
  const parts = useMemo(
    () =>
      (data?.parts ?? [])
        .map((part): ResolvedPart => ({ ...part, movie: openableByTmdb.get(part.tmdbId) ?? null }))
        .filter((part) => part.movie?.radarrId !== radarrId),
    [data, openableByTmdb, radarrId]
  );

  return { name: data?.name ?? "", parts };
}

/**
 * Mémoïsée, comme la rangée des titres similaires et pour la même raison.
 *
 * La fiche qui la contient se redessine sans arrêt — le geste de fermeture, l'état d'ouverture,
 * l'arrivée des données. Sans `memo`, chacun de ces rendus redessinait la rangée entière et ses
 * affiches, et l'animation de fermeture se payait en saccades.
 */
export const CinemaCollectionRow = memo(function CinemaCollectionRow({
  name,
  parts,
  onSelectOwned,
}: {
  name: string;
  parts: ResolvedPart[];
  /**
   * Ouvrir un titre qu'on possède.
   *
   * C'est la fiche qui le fait, avec le rappel qu'elle donne déjà à ses titres similaires : le
   * geste est le même, il doit donc suivre le même chemin — jusqu'à la façon dont la fermeture
   * retrouve son état. Sans lui, la rangée navigue elle-même, ce qui marche mais n'est pas la
   * même chose.
   */
  onSelectOwned?: (movie: CinemaMovie) => void;
}) {
  const t = useT();
  if (parts.length === 0) return null;

  function open(part: ResolvedPart) {
    if (part.movie) {
      // Le chemin de la fiche quand elle en offre un ; le nôtre sinon, pour que la rangée reste
      // utilisable là où personne ne l'écoute.
      if (onSelectOwned) onSelectOwned(part.movie);
      else openLibraryTitle("movie", part.movie.radarrId);
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
            {!part.movie && (
              <span className="absolute bottom-1 right-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-accent-200 ring-1 ring-accent-400/40 backdrop-blur-sm">
                {t("player.notInLibrary")}
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
});

/**
 * La même rangée, qui va chercher ses données elle-même.
 *
 * La fiche du téléphone empile ses sections sans réserver d'écran à chacune : elle n'a donc pas
 * besoin de savoir d'avance s'il y aura quelque chose, et se passe du crochet séparé.
 */
export const CinemaMovieCollectionRow = memo(function CinemaMovieCollectionRow({
  radarrId,
  onSelectOwned,
}: {
  radarrId: number;
  onSelectOwned?: (movie: CinemaMovie) => void;
}) {
  const { name, parts } = useCinemaCollection(radarrId);
  return <CinemaCollectionRow name={name} parts={parts} onSelectOwned={onSelectOwned} />;
});
