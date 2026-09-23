"use client";

import { useDelayedClose } from "@/lib/useDelayedClose";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";
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
  "relative flex h-full snap-start flex-col justify-end overflow-hidden pb-14 pt-10 " +
  "[@media(min-height:820px)]:pb-24 [@media(min-height:820px)]:pt-12";



/**
 * Le second écran des fiches — distribution, saga, titres similaires.
 *
 * Centré tant qu'il tient dans la fenêtre ; mais avec trois rangées il la dépasse, commence alors
 * tout en haut, et sa première rangée passait sous le bouton Retour, qui est fixe (1 rem du bord,
 * ~2,5 rem de haut) : « Distribution » se confondait avec lui. La réserve du haut lui laisse sa
 * place, quelle que soit la hauteur du contenu. Une seule écriture pour le film et la série.
 */
export const BELOW_SECTION_CLASS =
  "flex min-h-full snap-start flex-col justify-center gap-6 px-8 pb-12 sm:px-16 " +
  "pt-[calc(5rem+env(safe-area-inset-top))]";

/** La distribution reste, quelle que soit la hauteur : elle tient sur une ligne tronquée. */
export const CAST_CLASS = "truncate text-xs text-white/60";

/**
 * Combien de noms tiennent avant qu'un décompte prenne le relais.
 *
 * Trois, parce que c'est ce qui tient sur une ligne à la largeur de la colonne sans que la
 * troncature n'entre en jeu — et parce qu'au-delà, une liste d'acteurs ne se lit plus, elle se
 * survole.
 */
export const CAST_SHOWN = 3;

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
  alwaysOpenable = false,
}: {
  text: string;
  readMore: string;
  onOpen: () => void;
  /**
   * La fenêtre a autre chose à montrer que le synopsis entier — les notes critiques. Elle ne
   * s'ouvrait que sur un texte coupé : un synopsis court aurait caché les notes pour de bon.
   */
  alwaysOpenable?: boolean;
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
      onClick={() => (clamped || alwaysOpenable) && onOpen()}
      className={`group -mx-2 rounded-lg px-2 py-1 text-left transition-colors focus-visible:outline-none focus-visible:bg-white/12 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/20 ${
        clamped || alwaysOpenable ? "cursor-pointer hover:bg-white/8" : "cursor-default"
      }`}
    >
      <p
        ref={bodyRef}
        // Sélectionnable : c'est du texte, on doit pouvoir le copier même s'il est dans un bouton.
        className="clamp-fade-2 select-text text-sm text-white/90 drop-shadow-sm sm:text-base"
      >
        {text}
      </p>
      {(clamped || alwaysOpenable) && (
        <span className="mt-0.5 inline-block text-xs font-medium text-white/60 group-hover:text-white/90">
          {readMore}
        </span>
      )}
    </button>
  );
}

/** `animate-fade-out` (200 ms) et `animate-fade-out-scale` (180 ms), globals.css. */
const DETAIL_MODAL_EXIT_MS = 200;

/**
 * Le synopsis en entier, au centre de l'écran.
 *
 * Déplié sur place, il repoussait le menu et faisait grandir une page qui doit tenir en un
 * écran : ce que l'on venait lire chassait ce que l'on venait faire. Une fenêtre centrée ne
 * déplace rien et se referme d'un geste — Échap, un clic à côté, ou son propre bouton.
 */
export function CinemaDetailModal({
  title,
  children,
  closeLabel,
  onClose,
}: {
  title: string;
  /**
   * Du contenu, et non une chaîne.
   *
   * Elle ne servait qu'au synopsis, donc un `text` suffisait. La distribution a besoin de la même
   * fenêtre — même dimensions, même fermeture, même piège d'Échap capturé — mais avec des noms
   * cliquables. Écrire une seconde fenêtre pour ça, c'était deux boîtes de dialogue à maintenir
   * qui divergeraient à la première correction. D'où le contenu libre, et le nom qui cesse de
   * promettre un synopsis.
   */
  children: ReactNode;
  closeLabel: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  /**
   * La fermeture, jouée avant d'être faite.
   *
   * La fenêtre entrait en fondu mais se fermait d'un coup — sa voisine, la bande-annonce, sortait,
   * elle (relevé le 23/09/2026). `useDelayedClose` garde aussi le dernier `onClose` reçu, et
   * `requestClose` est stable : les deux fiches passent une fonction fléchée, neuve à chaque
   * rendu, et un effet qui en dépendait se rejouait avec elle, focus compris — l'écran du dessous
   * se redessine tout seul, et Entrée refermait la fenêtre au lieu d'ouvrir l'acteur.
   */
  const { closing, requestClose } = useDelayedClose(onClose, DETAIL_MODAL_EXIT_MS);

  // Le focus une fois, à l'ouverture — et plus jamais ensuite. Voir `useDelayedClose` ci-dessus.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    // Écoutée en capture : la fiche écoute Échap sur `window` elle aussi, et sans cela la même
    // touche fermait la fenêtre *et* la fiche derrière elle.
    function onKey(e: KeyboardEvent) {
      /**
       * Les flèches restent dans la fenêtre.
       *
       * La fiche parcourt son menu aux flèches, sur `window` elle aussi : chaque fiche devait donc
       * se taire tant qu'une fenêtre était ouverte, et chacune tenait sa propre liste. Le film
       * pensait au synopsis mais pas à la distribution, la série à aucun des deux — une flèche
       * dans la distribution envoyait le focus sur « Lecture », *derrière* la fenêtre, et Entrée
       * lançait le film. Arrêtées ici, une fois, pour toutes les fenêtres et toutes les fiches.
       *
       * Arrêtées et non annulées : le défilement du texte par les flèches reste celui du
       * navigateur.
       */
      if (e.key.startsWith("Arrow")) {
        e.stopPropagation();
        return;
      }
      if (e.key !== "Escape" && e.key !== "Backspace") return;
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [requestClose]);

  return createPortal(
    <div
      // Sur le départ, elle n'a plus d'avis : aucun clic ne la traverse ni ne la rouvre (règle 2
      // du cycle de vie des fiches, CLAUDE.md).
      className={`fixed inset-0 flex items-center justify-center bg-black/70 p-6 ${
        closing ? "pointer-events-none animate-fade-out" : "animate-fade-in"
      }`}
      style={{ zIndex: 49, backdropFilter: "blur(6px)" }}
      onClick={requestClose}
    >
      <div
        role="dialog"
        aria-modal
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`glass-panel w-full max-w-xl rounded-2xl p-6 shadow-2xl ${
          closing ? "animate-fade-out-scale" : "animate-fade-in-scale"
        }`}
      >
        <div className="mb-3 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-white font-display">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={requestClose}
            aria-label={closeLabel}
            className="btn btn-ghost btn-icon shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        <div className="scrollbar-thin max-h-[60vh] select-text overflow-y-auto pr-1 text-sm leading-7 text-white/90">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Le retour en place d'une fiche relâchée : la durée et la courbe du téléphone (`sheet-out`). */
const GRIP_RETURN_MS = 280;

/**
 * La poignée : de quoi refermer une fiche du bureau au doigt.
 *
 * Les fiches larges se ferment par la croix ou par Échap — deux gestes de souris et de clavier.
 * Sur une tablette, qui reçoit cette mise en page parce qu'elle en a la taille (voir `useIsTouch`),
 * il ne restait donc que le petit bouton du coin, là où le téléphone se referme d'un glissement
 * vers le bas. Signalé le 20/09/2026, en même temps que la bannière qui ne suivait pas le doigt.
 *
 * **Une poignée, et non la fiche entière.** Ici, contrairement au téléphone, le contenu défile
 * verticalement sur toute la hauteur et en accrochage obligatoire : un glissement vers le bas
 * appartient déjà au défilement. Prendre la fiche n'importe où reviendrait à disputer chaque geste
 * au navigateur, qui gagne — il annule le pointeur dès qu'il décide de faire défiler. La poignée
 * est donc une bande au-dessus du défilement, avec `touch-action: none` pour que ce geste-là lui
 * revienne franchement, et un trait visible qui dit qu'elle est là.
 *
 * **Seulement au doigt.** À la souris, tirer une fiche vers le bas ne veut rien dire, et la bande
 * mangerait des clics au profit d'un geste que personne ne ferait.
 */
export function useSheetGrip(onDismiss: () => void, enabled: boolean) {
  const swipe = useSwipeToDismiss(onDismiss);
  /**
   * Le temps du retour, le style reste posé.
   *
   * Relâchée sous le seuil, la fiche revenait d'un coup : `offset` repasse à 0 et `dragging` à
   * faux dans le même rendu, et le style qui portait la transition disparaissait avec eux
   * (23/09/2026). Il tient désormais la durée du retour, puis s'efface — au repos, toujours rien.
   * Retenu pendant le rendu, et non dans un effet : c'est ce rendu-là qui pose la position zéro.
   */
  const [returning, setReturning] = useState(false);
  const [wasDragging, setWasDragging] = useState(false);
  if (swipe.dragging !== wasDragging) {
    setWasDragging(swipe.dragging);
    setReturning(!swipe.dragging && swipe.offset === 0 && !swipe.dismissed);
  }
  useEffect(() => {
    if (!returning) return;
    const timer = setTimeout(() => setReturning(false), GRIP_RETURN_MS);
    return () => clearTimeout(timer);
  }, [returning]);
  const held = enabled && (swipe.dragging || swipe.offset > 0 || returning);
  return {
    /**
     * Aucun `transform` au repos, et c'est délibéré : sur cette fiche le bouton Retour est en
     * `fixed`, et un `transform` sur son ancêtre — fût-il nul — en ferait le référent, ce qui le
     * décrocherait de la fenêtre. Pendant le geste c'est justement ce qu'on veut, toute la fiche
     * partant d'un bloc ; au repos, rien ne doit être posé.
     */
    style: held
      ? {
          transform: `translateY(${swipe.offset}px)`,
          transition: swipe.dragging ? "none" : `transform ${GRIP_RETURN_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        }
      : undefined,
    grip: enabled ? (
      <div
        {...swipe.handlers}
        aria-hidden
        className="absolute inset-x-0 top-0 z-10 flex h-16 items-center justify-center"
        style={{ touchAction: "none" }}
      >
        <div className="mt-2 h-1 w-10 rounded-full bg-white/35" />
      </div>
    ) : null,
  };
}
