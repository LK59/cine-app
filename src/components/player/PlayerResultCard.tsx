"use client";

import { memo } from "react";
import { Film, Tv, User } from "lucide-react";
import { PosterImage } from "@/components/PosterImage";
import { useT } from "@/components/TranslationProvider";

export type ResultKind = "movie" | "series" | "person";

/**
 * La carte de résultat, partagée par la recherche, Ma liste et les filmographies.
 *
 * Une seule carte pour les trois : c'est ce qui fait qu'une grille mélangée reste lisible — même
 * cadre, même titre à la même hauteur, même pastille au même endroit. La seule différence est le
 * mot de la pastille, et c'est justement l'information qu'on cherche quand un film et une série
 * portent le même nom.
 *
 * Aucun nom d'outil n'apparaît : « Film » et « Série », jamais la provenance.
 *
 * Mémoïsée : une filmographie en compte deux cents, et l'écran qui les porte se redessine à
 * chaque changement d'adresse.
 */
export const PlayerResultCard = memo(function PlayerResultCard({
  kind,
  title,
  subtitle,
  poster,
  missing,
  onOpen,
  showKind = true,
}: {
  kind: ResultKind;
  title: string;
  subtitle?: string | null;
  poster: string | null;
  /** Absent de la bibliothèque — la carte le dit, discrètement, plutôt que de mentir. */
  missing?: boolean;
  onOpen: () => void;
  /**
   * L'étiquette « Film » / « Série » / « Personne », à couper quand la grille n'en montre qu'une.
   *
   * Elle départage un film et une série du même nom dans une recherche, où les deux se côtoient.
   * Dans une grille qui ne contient qu'une sorte, elle ne départage rien — et elle coûte un
   * `backdrop-filter` par carte, que le navigateur doit recalculer à chaque image tant que ce
   * qu'il y a derrière bouge. C'est-à-dire pendant tout un défilement.
   */
  showKind?: boolean;
}) {
  const t = useT();
  const Icon = kind === "movie" ? Film : kind === "series" ? Tv : User;
  const kindLabel = t(kind === "movie" ? "player.kind.movie" : kind === "series" ? "player.kind.series" : "player.kind.person");

  return (
    <button
      type="button"
      onClick={onOpen}
      data-nav-item
      className="pressable group flex flex-col text-left focus-visible:outline-none"
    >
      <div className="relative overflow-hidden rounded-lg bg-white/5 ring-1 ring-white/10 transition duration-200 group-hover:ring-white/30 group-focus-visible:ring-2 group-focus-visible:ring-accent-500">
        <div className={kind === "person" ? "aspect-[2/3]" : "aspect-[2/3]"}>
          {poster ? (
            /* `unoptimized` : ces adresses sont déjà des images TMDB demandées à la taille de la
               carte. Les faire passer par l'optimiseur de Next revenait à faire retranscoder des
               centaines d'affiches par ce serveur pendant qu'on fait défiler la grille — la cause
               n°1 des à-coups de défilement identifiée sur les rangées du mode cinéma. Le CDN
               fait ce travail mieux, et gratuitement. */
            <PosterImage
              src={poster}
              alt={title}
              subtle
              unoptimized
              sizes="(max-width: 640px) 30vw, (max-width: 1024px) 18vw, 150px"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-subtle">
              <Icon size={26} />
            </div>
          )}
        </div>

        {/* Deux étiquettes mangeaient l'affiche par les deux bouts. Le type reste — c'est lui
            qui départage un film et une série du même nom — mais posé sur un voile sombre plutôt
            que dans un cadre à lui, et sans son propre fond : il se lit, il ne se réclame pas.

            Absent quand la grille ne montre qu'une sorte, et ce n'est pas qu'une question de
            bruit visuel. Un `backdrop-filter` doit être recalculé à chaque image tant que ce
            qu'il y a derrière bouge — c'est-à-dire à chaque image d'un défilement. Sur la grille
            complète, six cent soixante-dix cartes en portaient une chacune, pour répéter « Film »
            six cent soixante-dix fois sous l'onglet Films. */}
        {/* Le pictogramme seul, depuis le 23/09/2026 : le mot « Film » ou « Série » couvrait le
            haut de l'affiche — souvent le titre qui y est imprimé. Le nom reste dit aux lecteurs
            d'écran, qui ne voient pas l'icône. */}
        {showKind && (
          <span
            role="img"
            aria-label={kindLabel}
            title={kindLabel}
            className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/65 text-white"
          >
            <Icon size={11} aria-hidden />
          </span>
        )}

        {/* Sans flou, sur un fond un peu plus dense (21/09/2026) : une filmographie peut en porter
            cent cinquante, dans une carte qui glisse — autant de `backdrop-filter` à recalculer
            à chaque image. Même raison que l'étiquette du type juste au-dessus. */}
        {/* « Pas encore là » est l'état par défaut d'une liste d'envies : c'était l'information la
            moins importante de la grille et la plus voyante, un bandeau violet pleine largeur en
            travers de six affiches sur huit. Réduite à une pastille de coin sans fond plein, le
            violet reste disponible pour ce qui le mérite — un titre qui vient d'arriver. */}
        {missing && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-accent-400 ring-1 ring-accent-400/40">
            {t("player.notInLibrary")}
          </span>
        )}
      </div>

      <p className="mt-2 line-clamp-2 text-[13px] font-medium leading-snug text-white">
        {title}
      </p>
      {subtitle && <p className="mt-0.5 truncate text-[11px] text-subtle">{subtitle}</p>}
    </button>
  );
});
