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
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useT();
  const route = useCinemaRoute();
  const isMobile = useIsMobile();
  const short = useIsShortViewport();
  const bodyRef = useRef<HTMLDivElement>(null);
  // Une fiche ouverte par-dessus ce panneau écoute Échap elle aussi. `stopPropagation` n'y change
  // rien : deux écouteurs posés sur la même cible se déclenchent tous les deux, et une seule
  // touche remontait alors de deux crans dans l'historique — la fiche *et* le panneau. Le panneau
  // se tait tant qu'il n'est pas l'écran du dessus.
  const covered =
    route.film !== null || route.serie !== null || route.discover !== null || route.person !== null;

  useEffect(() => {
    if (covered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      cinemaClose({ search: false, list: false, account: false });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [covered]);

  // Même garde que les fiches du mode cinéma : ce composant peut être rendu côté serveur, où
  // `document` n'existe pas et où `createPortal` fait échouer la page entière.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 flex animate-fade-in flex-col overflow-hidden bg-ink"
      style={{ zIndex: 46, paddingLeft: "var(--player-rail, 0px)" }}
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
          <h1 className={`truncate font-display font-semibold text-white ${short ? "text-xl" : "text-2xl sm:text-3xl"}`}>
            {title}
          </h1>
          {subtitle && !short && <div className="mt-1 text-sm text-slate-400">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {actions}
          <button
            type="button"
            onClick={() => cinemaClose({ search: false, list: false, account: false })}
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
