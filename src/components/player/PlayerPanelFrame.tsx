"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Menu, X } from "lucide-react";
import { cinemaClose, cinemaNavigate, useCinemaRoute } from "@/lib/cinemaRoute";
import { useIsMobile, useIsShortViewport } from "@/lib/useIsMobile";
import { useT } from "@/components/TranslationProvider";

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
 * Ce qui compte ici : une fiche passe **par-dessus** un panneau et ne le referme pas. C'est ce
 * qui fait qu'un retour depuis un film ouvert en cherchant ramène sur la recherche, avec la
 * requête intacte, au lieu de sauter à l'accueil.
 */
export function PlayerPanelFrame({
  title,
  subtitle,
  actions,
  leaving = false,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** Piloté par la coquille : l'écran est en train de sortir — voir useExitDelay. */
  leaving?: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  const route = useCinemaRoute();
  const isMobile = useIsMobile();
  const short = useIsShortViewport();
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
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

  useEffect(() => {
    if (covered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      cinemaClose({ search: false, list: false, account: false, browse: null });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [covered]);

  // Même garde que les fiches du mode cinéma : ce composant peut être rendu côté serveur, où
  // `document` n'existe pas et où `createPortal` fait échouer la page entière.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={rootRef}
      // Sur téléphone, il monte comme les fiches ; sur grand écran, il apparaît. Deux idiomes, chacun
      // celui de sa plateforme — et surtout le même que les autres écrans de la même famille.
      className={`fixed inset-0 flex flex-col overflow-hidden bg-ink ${
        leaving ? "animate-fade-out-down md:animate-fade-out" : "animate-slide-up md:animate-fade-in"
      }`}
      style={{
        zIndex: 46,
        // Le retrait du rail et la marge de l'encoche s'additionnent : le premier vaut zéro sur
        // téléphone, la seconde vaut zéro partout ailleurs.
        paddingLeft: "calc(var(--player-rail, 0px) + env(safe-area-inset-left, 0px))",
        paddingRight: "env(safe-area-inset-right, 0px)",
      }}
    >
      <header
        className={`flex shrink-0 items-start gap-3 px-5 sm:gap-4 sm:px-10 ${short ? "pb-2" : "pb-4"}`}
        // Un téléphone couché n'a que ~400 px de haut : un titre de trois rem et deux rems de
        // marge en mangeaient le quart avant la première affiche.
        style={{ paddingTop: `calc(${short ? "0.75rem" : "1.5rem"} + env(safe-area-inset-top))` }}
      >
        {/* Le même bouton qu'à l'accueil, à la même place.
            Sur téléphone, l'accueil se navigue par le menu en haut à gauche et ces écrans ne se
            fermaient que par une croix en haut à droite : deux façons d'aller ailleurs selon
            l'écran où l'on se trouvait. Le menu est ici aussi ; la croix reste, parce que fermer
            en un geste vaut mieux que passer par « Accueil ». Sur grand écran, le rail est
            toujours là, donc le bouton n'a pas lieu d'être. */}
        {isMobile && (
          <button
            type="button"
            onClick={() => cinemaNavigate({ menu: true })}
            aria-label={t("player.nav.label")}
            className="-ml-1 mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-300 transition-colors active:bg-white/10"
          >
            <Menu size={20} />
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
          {subtitle && !short && <div className="mt-1 text-sm text-slate-400">{subtitle}</div>}
        </div>
        {/* Effacé tant que le tiroir est ouvert. Le voile du tiroir assombrit l'écran sans le
            masquer : la croix de ce panneau restait lisible à côté de celle du tiroir, deux croix
            à l'écran sans rien pour dire laquelle ferme quoi. `invisible` plutôt qu'un retrait,
            pour que le titre ne se déplace pas quand le tiroir se referme. */}
        <div className={`flex shrink-0 items-center gap-1 sm:gap-2 ${route.menu ? "invisible" : ""}`}>
          {actions}
          <button
            type="button"
            onClick={() => cinemaClose({ search: false, list: false, account: false, browse: null })}
            aria-label={t("common.close")}
            className="flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            <X size={20} />
          </button>
        </div>
      </header>

      {/* L'animation est portée par le contenu et non par la racine : `fade-in-up` laisse un
          `transform` en place une fois terminée, ce qui ferait de la racine le bloc conteneur de
          tout descendant `fixed` — le piège exact qui a coûté un portage dans document.body à
          l'écran cinéma. Ici, rien de fixe n'en descend, mais la règle vaut d'être tenue. */}
      <div
        ref={bodyRef}
        className="scrollbar-thin flex-1 animate-fade-in-up overflow-y-auto overscroll-contain px-5 pb-16 sm:px-10"
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
