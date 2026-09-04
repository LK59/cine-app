import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { PosterImage } from "@/components/PosterImage";

/**
 * L'affiche encadrée — la brique la plus dessinée de l'app, et jusqu'ici la moins partagée.
 *
 * Dix composants la redessinaient : les trois rangées du tableau de bord, les grilles Films et
 * Séries, Ma liste, la fiche personne, les recommandations, ActorModal, Jellyfin. Ce n'est pas
 * un défaut d'apparence, c'est un coût : le retour du bouton « Demander » à l'état réel a dû
 * être appliqué cinq fois, le passage au fond opaque onze fois, et les notes IMDb avaient été
 * oubliées sur la page Séries pour cette raison exacte.
 *
 * Ce composant ne prend en charge que ce qui était rigoureusement identique partout — le cadre,
 * l'image, ce qui se pose dessus, le bloc titre, l'anneau de survol et l'appui. Les actions
 * propres à chaque écran restent chez lui, en `overlay` ou en `children`.
 */

/** Les trois largeurs de rangée. Il y en avait cinq, sans que rien ne les distingue. */
export const CARD_WIDTH = {
  /** Un visage, une vignette secondaire. */
  sm: "w-24",
  /** Le format courant d'une rangée d'affiches. */
  md: "w-28",
  /** Une reprise de lecture : plus large, parce qu'on y lit une progression. */
  lg: "w-36 sm:w-40",
} as const;

const NAV_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

interface Props {
  posterUrl: string | null | undefined;
  alt: string;
  /** Où mène la carte. Sans lien, elle reste une surface qu'on ne peut qu'ouvrir autrement. */
  href?: string | null;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Ce qui se pose sur l'affiche : note, pastille de disponibilité, barre de progression. */
  overlay?: ReactNode;
  /** Largeur fixe dans une rangée ; omise, la carte remplit sa cellule de grille. */
  width?: string;
  /** Désignée par la navigation à la télécommande. */
  selected?: boolean;
  className?: string;
  /** `data-tv-*`, préchargement au survol, gestes d'appui long : ce que l'écran ajoute. */
  anchorProps?: Partial<ComponentProps<typeof Link>> & Record<string, unknown>;
  children?: ReactNode;
}

export function MediaCard({
  posterUrl,
  alt,
  href,
  title,
  subtitle,
  overlay,
  width,
  selected = false,
  className = "",
  anchorProps,
  children,
}: Props) {
  const surface = [
    // Colonne, toujours : l'affiche, le texte, puis ce que l'écran ajoute. C'est ce qui permet
    // à une rangée d'actions de se clouer en bas d'une carte (`mt-auto`) au lieu de flotter à la
    // suite d'un titre qui fait une ou deux lignes selon le film.
    "card-solid relative flex flex-col overflow-hidden select-none touch-manipulation",
    "transition-[transform,box-shadow] duration-200",
    width ? `${width} shrink-0` : "",
    href ? "hover:-translate-y-0.5 hover:ring-1 hover:ring-accent-500/40" : "",
    selected ? "ring-2 ring-accent-500" : "",
    NAV_RING,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <div className="relative">
        <PosterImage src={posterUrl} alt={alt} />
        {overlay}
      </div>
      {(title || subtitle) && (
        <div className="p-2">
          {title && <p className="truncate text-xs font-medium text-white">{title}</p>}
          {subtitle && <div className="mt-0.5 text-[11px] text-slate-500">{subtitle}</div>}
        </div>
      )}
      {children}
    </>
  );

  if (!href) return <div className={surface}>{body}</div>;

  return (
    <Link href={href} className={surface} {...anchorProps}>
      {body}
    </Link>
  );
}
