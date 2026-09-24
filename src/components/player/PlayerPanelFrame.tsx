"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, X } from "lucide-react";
import { CLOSE_PANELS, cinemaClose, cinemaNavigate, useCinemaRoute } from "@/lib/cinemaRoute";
import { useIsMobile, useIsShortViewport } from "@/lib/useIsMobile";
import { useT } from "@/components/TranslationProvider";
import { usePanelArrowNav } from "@/lib/usePanelArrowNav";

/**
 * L'habillage commun des écrans ouverts depuis le rail — Recherche, Ma liste, Compte.
 *
 * Trois choses qu'ils partagent et qu'il vaut mieux n'écrire qu'une fois : le portage dans
 * document.body (même raison que l'écran cinéma : `fixed` n'est fixe que si aucun ancêtre ne
 * porte de `transform`), le décalage du rail, et la fermeture — Échap, la croix, et le retour du
 * navigateur, qui doivent toutes les trois faire exactement la même chose.
 *
 * L'ordre des plans, de bas en haut : la grille (45), les panneaux (46), les fiches de titre et
 * de personne (47), les fenêtres qu'une fiche ouvre — synopsis, épisodes (49) — et le rail (50),
 * toujours au-dessus, parce que la navigation ne doit jamais être hors d'atteinte.
 *
 * C'est une échelle **fixe**, et il faut le savoir avant d'imaginer empiler deux écrans de
 * familles différentes : il n'y a aucun cran entre le panneau et la fiche de titre. Une fiche
 * personne ne peut donc pas vivre sous un film — elle se referme, et le retour la rouvre sans que
 * rien n'apparaisse entre les deux. Voir `openLibraryTitle` et `useSheetBehind`.
 *
 * Ce qui compte ici : une fiche passe **par-dessus** un panneau et ne le referme pas. C'est ce
 * qui fait qu'un retour depuis un film ouvert en cherchant ramène sur la recherche, avec la
 * requête intacte, au lieu de sauter à l'accueil.
 */
export function PlayerPanelFrame({
  title,
  subtitle,
  actions,
  leaving = false,
  replaced = false,
  fromTab = false,
  back = false,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** Piloté par la coquille : l'écran est en train de sortir — voir useExitDelay. */
  leaving?: boolean;
  /**
   * Il sort parce qu'un autre onglet prend sa place, et non pour revenir à l'accueil.
   *
   * Les deux panneaux se croisaient alors en fondu, au même niveau : à mi-chemin, chacun était à
   * moitié transparent et l'accueil se voyait à travers les deux — de la recherche à « Ma liste »,
   * la page d'accueil passait brièvement (signalé le 23/09/2026). Remplacé, il ne s'efface plus :
   * il reste plein, dessous, et celui qui arrive fond par-dessus lui, comme les onglets d'iOS.
   */
  replaced?: boolean;
  /**
   * Il arrive d'un autre onglet, et non de l'accueil : il apparaît d'un coup, comme un onglet d'iOS.
   *
   * Même remplacé proprement (voir `replaced`), un fondu croisé montrait deux pages l'une sur
   * l'autre pendant un cinquième de seconde, leurs titres presque au même endroit et l'un décalé
   * de vingt-huit pixels : l'écran semblait clignoter, puis sauter sur la page voulue (signalé le
   * 23/09/2026). Lu à chaque entrée, pas à chaque rendu : la valeur retombe quand l'onglet d'avant
   * a fini de partir, et une classe d'animation ajoutée à ce moment-là jouerait en retard.
   */
  fromTab?: boolean;
  /**
   * Cet écran a été poussé depuis un autre, et non choisi dans le rail.
   *
   * Les trois panneaux du rail sont des onglets : on n'en sort pas, on va ailleurs, et c'est
   * pourquoi la croix disparaît sur téléphone (voir plus bas). La grille complète emprunte le même
   * cadre mais n'est pas un onglet — on y entre depuis « Voir tout », et il y a donc bel et bien un
   * *derrière*. Sans ce drapeau elle héritait de la règle des onglets : aucune sortie sur
   * téléphone, et il fallait retoucher Accueil pour revenir. Signalé le 20/09/2026.
   *
   * Un retour, et pas une croix de plus : ce sont deux vocabulaires — une croix ferme, une flèche
   * revient — et ici c'est bien revenir qu'on fait. Il remplace donc la croix à toutes les tailles
   * plutôt que de s'ajouter à elle.
   */
  back?: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  /**
   * De quoi rejouer l'entrée quand on revient sur un onglet qu'on venait de quitter.
   *
   * `useExitDelay` reprend la main sans démonter : la phase passe de « sortante » à « entrante »
   * sur le *même* nœud. Or une animation CSS ne se relance pas parce que React a rerendu — la
   * classe est déjà là, le navigateur considère qu'elle a joué. D'où « ça ne se joue pas à tous
   * les coups » : rouvrir Recherche avant que Ma liste ait fini de partir n'animait rien.
   *
   * Un compteur en clé force un nœud neuf, et le navigateur repart de zéro. Dérivé pendant le
   * rendu, comme `useExitDelay` lui-même : un `setState` dans un effet est refusé ici, à raison.
   */
  const [entrance, setEntrance] = useState(0);
  const [wasLeaving, setWasLeaving] = useState(leaving);
  const [instantEntry, setInstantEntry] = useState(fromTab);
  if (wasLeaving !== leaving) {
    setWasLeaving(leaving);
    if (!leaving) {
      setEntrance((n) => n + 1);
      setInstantEntry(fromTab);
    }
  }

  const route = useCinemaRoute();
  const isMobile = useIsMobile();
  const short = useIsShortViewport();
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Les flèches parcourent le contenu du panneau, comme elles parcourent déjà les rangées de
  // l'accueil. Sur le corps et non sur la fenêtre : un panneau ne prend les flèches que de ce
  // qu'il recouvre — et jamais quand on écrit. Voir `usePanelArrowNav`.
  //
  // `entrance` est la clé du corps : chaque retour rapide sur l'onglet en monte un nouveau, et
  // l'écouteur doit le suivre — posé une fois, il restait sur le premier, et les flèches
  // mouraient au premier aller-retour.
  usePanelArrowNav(bodyRef, true, entrance);

  // Une fiche ouverte par-dessus ce panneau écoute Échap elle aussi. `stopPropagation` n'y change
  // rien : deux écouteurs posés sur la même cible se déclenchent tous les deux, et une seule
  // touche remontait alors de deux crans dans l'historique — la fiche *et* le panneau. Le panneau
  // se tait tant qu'il n'est pas l'écran du dessus.
  const covered =
    route.film !== null || route.serie !== null || route.discover !== null || route.person !== null;

  /**
   * Le focus entre dans l'écran qui vient de s'ouvrir.
   *
   * Sans cela il restait sur le bouton du rail : un lecteur d'écran n'annonçait rien, et une
   * tabulation repartait dans la navigation au lieu d'entrer dans le contenu.
   *
   * On ne le prend que s'il est encore dehors : les effets des enfants s'exécutent avant celui du
   * parent, donc la recherche a déjà placé le sien sur son champ, et le lui reprendre serait
   * exactement le contraire de ce qu'on veut.
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root || root.contains(document.activeElement)) return;
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  // `leaving` compte autant que `covered`, et pour la même raison portée un cran plus loin : la
  // coquille rend les trois panneaux indépendamment, donc pendant une bascule Recherche → Ma liste
  // il y en a *deux* montés, celui qui part et celui qui arrive. Sans cette condition, les deux
  // écoutent Échap, et une seule touche reculait de deux crans — depuis le premier écran de la
  // pile, elle faisait sortir du mode cinéma. Un écran en train de partir n'a plus d'avis sur rien.
  useEffect(() => {
    if (covered || leaving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Deux cas où Échap ne revient pas au panneau, relevés le 23/09/2026 :
      //  - une fenêtre de dialogue est ouverte par-dessus (l'accueil, un menu d'actions) — Échap
      //    refermait le panneau Compte *sous* l'accueil, qui restait à l'écran ;
      //  - la touche vient d'un élément qui gère lui-même Échap (`data-owns-escape`) — dans la
      //    recherche d'ajout de « Ma liste », Échap quittait tout l'écran au lieu de la seule
      //    recherche.
      // L'écoute se fait en capture sur la fenêtre, avant tout le monde : c'est donc ici qu'il
      // faut s'effacer, un enfant n'a aucun moyen de passer devant.
      if (document.querySelector('[aria-modal="true"]')) return;
      if ((e.target as Element | null)?.closest?.("[data-owns-escape]")) return;
      e.stopPropagation();
      cinemaClose(CLOSE_PANELS);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [covered, leaving]);

  // Même garde que les fiches du mode cinéma : ce composant peut être rendu côté serveur, où
  // `document` n'existe pas et où `createPortal` fait échouer la page entière.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={rootRef}
      // Sur téléphone, il monte comme les fiches ; sur grand écran, il apparaît. Deux idiomes, chacun
      // celui de sa plateforme — et surtout le même que les autres écrans de la même famille.
      className={`fixed inset-0 flex flex-col overflow-hidden bg-ink ${
        /* Un onglet, pas une feuille.
         *
         * Ces panneaux montaient depuis le bas — le vocabulaire de la modale, alors que le modèle
         * est celui d'onglets pairs : `openPanel` dit lui-même qu'ils s'excluent et *remplacent*
         * l'écran au lieu de s'empiler, exactement comme les onglets du bas d'une app iOS. La
         * présentation contredisait le modèle, et on ne « rejette » pas un onglet.
         *
         * Un fondu avec un soupçon d'échelle, donc : non directionnel, le contenu se pose au lieu
         * d'arriver d'ailleurs. Les deux courbes existaient déjà dans la feuille de style ; la
         * montée n'était utilisée qu'ici, et disparaît avec elle.
         *
         * Plus de variante `md:` : un onglet est un onglet à toutes les tailles, et la distinction
         * ne faisait que donner deux gestes différents à la même idée. */
        /* Sur la racine, et non sur le conteneur de défilement où elle était.
         *
         * Ce conteneur peut être vide au moment où l'animation se joue — sa charge utile arrive
         * après —, si bien que la dérive animait une boîte sans contenu et passait inaperçue. La
         * racine, elle, existe et se voit toujours : son fond porte le mouvement quoi qu'il arrive
         * au reste. Une seule transformation composée par bascule au lieu de deux, aussi. */
        leaving ? (replaced ? "" : "animate-fade-out-scale") : instantEntry ? "" : "animate-fade-in-side"
      }`}
      style={{
        // Celui qui part passe dessous : celui qui arrive doit le recouvrir, quel que soit leur
        // ordre dans la page (la recherche précède « Ma liste », qui précède le compte).
        zIndex: leaving ? 45 : 46,
        // Inerte pendant qu'il s'en va. Sa croix reste sous le doigt le temps de l'animation, et
        // un second appui fermerait l'écran d'en dessous — celui qu'on vient d'ouvrir.
        pointerEvents: leaving ? "none" : undefined,
        // Le retrait du rail et la marge de l'encoche s'additionnent : le premier vaut zéro sur
        // téléphone, la seconde vaut zéro partout ailleurs.
        paddingLeft: "calc(var(--player-rail, 0px) + env(safe-area-inset-left, 0px))",
        paddingRight: "env(safe-area-inset-right, 0px)",
      }}
    >
      <header
        className="flex shrink-0 items-start gap-3 px-5 sm:gap-4 sm:px-10"
        // Un téléphone couché n'a que ~400 px de haut : un titre de trois rem et deux rems de
        // marge en mangeaient le quart avant la première affiche.
        style={{ paddingTop: `calc(${short ? "0.75rem" : "1.5rem"} + env(safe-area-inset-top))` }}
      >
        {back && (
          <button
            type="button"
            onClick={() => cinemaClose(CLOSE_PANELS)}
            className="btn btn-ghost -ml-1 mt-0.5 shrink-0 rounded-full px-3 py-2"
          >
            <ArrowLeft size={16} /> {t("cinema.back")}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className={`truncate font-display font-semibold text-white outline-none ${short ? "text-xl" : "text-2xl sm:text-3xl"}`}
          >
            {title}
          </h1>
          {subtitle && !short && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {actions}
          {/* La croix ne survit que sur grand écran.
              Sur téléphone, ces écrans sont devenus des onglets : on n'en « sort » plus, on va
              ailleurs, et la barre du bas dit où. Une croix y proposait de fermer quelque chose
              qui n'a plus de derrière — et laissait deux façons de faire la même chose, dont une
              dans le coin le plus hors de portée du pouce. Le rail, lui, est un compagnon et non
              une destination : la croix y garde son sens. */}
          {!isMobile && !back && (
            <button
              type="button"
              onClick={() => cinemaClose(CLOSE_PANELS)}
              aria-label={t("common.close")}
              className="flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              <X size={20} />
            </button>
          )}
        </div>
      </header>

      {/* Le corps n'a pas d'animation à lui : c'est la racine qui entre et sort (voir plus haut).
          Il est re-clé à chaque entrée pour que l'écouteur des flèches suive le nœud neuf. */}
      <div
        ref={bodyRef}
        key={entrance}
        className="scrollbar-thin flex-1 overflow-y-auto overscroll-contain px-5 pb-16 sm:px-10"
        // La barre du bas flotte par-dessus sur téléphone : sans cette réserve, la dernière rangée
        // d'un panneau finissait dessous. Nulle sur grand écran, où c'est le rail qui navigue.
        style={{
          // Au moins deux rems et demi : sur le bureau, la réserve de la barre du bas vaut zéro, et
          // le dernier élément — « Se déconnecter » — touchait le bord de la fenêtre (23/09/2026).
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + max(var(--player-bar-space, 4rem), 2.5rem))",
          // Le fondu collé en haut recouvre ce qu'on y fait défiler : une carte atteinte aux flèches
          // s'arrêtait dessous, son haut estompé. La réserve l'arrête juste après.
          scrollPaddingTop: short ? "0.5rem" : "1rem",
        }}
      >
        {/* Un fondu sous l'en-tête, collé en haut de la zone qui défile.
            Le contenu disparaissait net sous le titre, coupé à la ligne près (23/09/2026). Le
            fondu occupe la marge qui séparait l'en-tête du contenu : au repos il ne recouvre que
            du vide, et rien ne bouge ; au défilement, ce qui monte s'y efface. */}
        <div
          aria-hidden
          className={`pointer-events-none sticky top-0 z-10 bg-gradient-to-b from-ink to-transparent ${short ? "h-2" : "h-4"}`}
        />
        {children}
      </div>
    </div>,
    document.body
  );
}
