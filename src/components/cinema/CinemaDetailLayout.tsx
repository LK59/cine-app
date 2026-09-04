"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
/**
 * La mise en scène d'une fiche en mode cinéma : les voiles, la colonne, la barre de progression.
 *
 * Le film et la série les écrivaient chacun de leur côté, avec les mêmes valeurs à la virgule
 * près. Elles sont ici, en un seul endroit, parce que ce sont trois décisions de composition et
 * qu'elles doivent être prises une fois.
 */

/** `--color-ink`, en composantes, pour écrire des dégradés à étapes explicites. */
const INK = "10 10 12";

/**
 * Le voile horizontal.
 *
 * Il partait du bord gauche et s'éteignait au milieu, c'est-à-dire pile sur le sujet de l'image :
 * l'astronaute de « Sunshine » se retrouvait à cheval entre la partie voilée et la partie nue,
 * coupé en deux par une frontière qui ne suivait rien. Il tient maintenant franchement jusqu'au
 * tiers — là où le texte se lit — puis s'éteint avant la moitié, en laissant l'image entière.
 */
export const HORIZONTAL_VEIL = `linear-gradient(to right,
  rgb(${INK} / 0.94) 0%,
  rgb(${INK} / 0.88) 30%,
  rgb(${INK} / 0.52) 50%,
  rgb(${INK} / 0.14) 70%,
  rgb(${INK} / 0) 86%)`;

/** Le voile vertical : pose l'image sur le noir du bas sans assombrir le haut. */
export const VERTICAL_VEIL = `linear-gradient(to top,
  rgb(${INK} / 0.92) 0%,
  rgb(${INK} / 0.50) 20%,
  rgb(${INK} / 0.10) 46%,
  rgb(${INK} / 0) 64%)`;

/**
 * La colonne de texte, et le menu.
 *
 * Le synopsis allait jusqu'à 576 px, le menu s'arrêtait à 320, et rien ne les alignait : le bloc
 * avait l'air posé de travers. Une seule colonne désormais, dimensionnée en proportion de la
 * fenêtre comme le fait une interface de télévision, avec un menu qui en occupe les deux tiers —
 * assez large pour être une colonne, assez étroit pour ne pas être un paragraphe.
 */
export const COLUMN_STYLE = { width: "min(40rem, 46vw)", minWidth: "min(100%, 22rem)" } as const;
export const MENU_STYLE = { width: "min(26rem, 100%)" } as const;

/** Le logo d'un titre, détaché du fond quel qu'il soit. */
export const LOGO_STYLE = { filter: "drop-shadow(0 6px 20px rgb(0 0 0 / 0.6))" } as const;

/**
 * La première page tient dans l'écran, quel que soit l'écran.
 *
 * Elle était `min-h-full` : sur un 13 pouces, le logo, le synopsis et cinq lignes de menu
 * dépassaient, la section grandissait au-delà de la fenêtre, et cette « page unique » devenait
 * elle-même défilante. Remonter depuis les titres similaires ne ramenait donc pas en haut mais
 * quelque part au milieu, logo collé au bouton Retour.
 *
 * `h-full` la fixe à exactement une fenêtre. Ce qu'il faut alors, c'est que le contenu sache
 * rétrécir : les valeurs ci-dessous se réduisent par paliers de hauteur de fenêtre, plutôt que
 * de compter sur une largeur qui ne dit rien de la place verticale disponible.
 */
export const SECTION_CLASS =
  "relative flex h-full snap-start flex-col justify-end overflow-hidden pb-10 pt-14 " +
  "[@media(min-height:820px)]:pb-14 [@media(min-height:820px)]:pt-20";

/** Le logo : plus discret quand l'écran est court, sans jamais disparaître. */
export const LOGO_CLASS =
  "mb-1 max-h-14 w-auto max-w-full object-contain " +
  "[@media(min-height:700px)]:max-h-20 [@media(min-height:900px)]:max-h-28";



/** La distribution reste, quelle que soit la hauteur : elle tient sur une ligne tronquée. */
export const CAST_CLASS = "truncate text-xs text-white/60";

/** L'espacement de la colonne, resserré sur un écran court. */
export const COLUMN_GAP = "gap-3 [@media(min-height:820px)]:gap-4";

/**
 * Le synopsis, en deux lignes, avec de quoi lire la suite.
 *
 * Trois lignes tronquées prennent la place de trois lignes sans donner le texte ; deux lignes et
 * un moyen de lire la suite donnent les deux. La ligne rejoint le parcours des flèches — elle
 * porte `data-detail-menu` comme les actions — mais son repère de position reste translucide :
 * le blanc est réservé à ce qui se déclenche, et lire n'est pas déclencher.
 */
export function CinemaOverview({
  text,
  readMore,
  onOpen,
}: {
  text: string;
  readMore: string;
  onOpen: () => void;
}) {
  const [clamped, setClamped] = useState(false);
  const bodyRef = useRef<HTMLParagraphElement>(null);

  // Mesuré plutôt que deviné : la longueur qui tient en deux lignes dépend de la largeur de la
  // colonne, donc de la fenêtre. Relu à chaque redimensionnement, pour la même raison.
  useEffect(() => {
    const measure = () => {
      const el = bodyRef.current;
      if (el) setClamped(el.scrollHeight - el.clientHeight > 2);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text]);

  return (
    <button
      type="button"
      data-detail-menu
      onClick={() => clamped && onOpen()}
      className={`group -mx-2 rounded-lg px-2 py-1 text-left transition-colors focus-visible:outline-none focus-visible:bg-white/12 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/20 ${
        clamped ? "cursor-pointer hover:bg-white/8" : "cursor-default"
      }`}
    >
      <p
        ref={bodyRef}
        // Sélectionnable : c'est du texte, on doit pouvoir le copier même s'il est dans un bouton.
        className="line-clamp-2 select-text text-sm text-white/90 drop-shadow-sm sm:text-base"
      >
        {text}
      </p>
      {clamped && (
        <span className="mt-0.5 inline-block text-xs font-medium text-white/60 group-hover:text-white/90">
          {readMore}
        </span>
      )}
    </button>
  );
}

/**
 * Le synopsis en entier, au centre de l'écran.
 *
 * Déplié sur place, il repoussait le menu et faisait grandir une page qui doit tenir en un
 * écran : ce que l'on venait lire chassait ce que l'on venait faire. Une fenêtre centrée ne
 * déplace rien et se referme d'un geste — Échap, un clic à côté, ou son propre bouton.
 */
export function CinemaSynopsisModal({
  title,
  text,
  closeLabel,
  onClose,
}: {
  title: string;
  text: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    // Écoutée en capture : la fiche écoute Échap sur `window` elle aussi, et sans cela la même
    // touche fermait la fenêtre *et* la fiche derrière elle.
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" && e.key !== "Backspace") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/70 p-6 animate-fade-in"
      style={{ zIndex: 47, backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="glass-panel animate-fade-in-scale w-full max-w-xl rounded-2xl p-6 shadow-2xl"
      >
        <div className="mb-3 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-white font-display">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="btn btn-ghost btn-icon shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        <p className="scrollbar-thin max-h-[60vh] select-text overflow-y-auto pr-1 text-sm leading-7 text-white/90">
          {text}
        </p>
      </div>
    </div>,
    document.body
  );
}
