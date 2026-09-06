"use client";

import { useCinemaRoute } from "@/lib/cinemaRoute";
import { useIsShortViewport } from "@/lib/useIsMobile";
import { useHideOnScroll } from "@/lib/useHideOnScroll";
import { useT } from "@/components/TranslationProvider";
import { PLAYER_NAV, activePanel, openPanel } from "./playerNav";

/**
 * La durée du mouvement d'entrée et de sortie.
 *
 * Assez pour qu'on le voie — c'est ce qui distingue une barre qui s'écarte d'une barre qui
 * clignote — et assez court pour qu'on ne l'attende jamais en revenant vers le haut.
 */
const AWAY_MS = 280;

/**
 * La navigation du téléphone.
 *
 * Elle remplace le tiroir et son bouton hamburger. Ce n'était pas une question de nombre
 * d'appuis : les deux coins du haut d'un téléphone sont hors de portée du pouce, et le tiroir
 * demandait de recouvrir tout l'écran pour poser une deuxième question. Il y avait par-dessus le
 * marché deux navigations pour les mêmes quatre destinations — un tiroir ici, un rail sur grand
 * écran. Celle-ci *est* le rail du téléphone.
 *
 * Flottante et non ancrée : une bande pleine largeur collée au bas de l'écran coupe l'affiche en
 * deux, et toute l'identité de cet écran est l'image qui va d'un bord à l'autre. Elle s'efface au
 * défilement vers le bas et revient au moindre retour vers le haut.
 *
 * Couché, elle perd ses mots et ne garde que ses pictogrammes : sur trois cent quatre-vingt-dix
 * pixels de haut, deux lignes de texte en bas de l'écran coûtent une rangée d'affiches.
 */
export function PlayerBottomBar() {
  const t = useT();
  const route = useCinemaRoute();
  const short = useIsShortViewport();
  const hidden = useHideOnScroll();
  const active = activePanel(route);

  // Effacée pendant qu'une fiche est ouverte : elle recouvre l'écran entier, et la barre y
  // flotterait au-dessus d'un contenu qu'elle ne commande pas.
  const covered = route.film !== null || route.serie !== null || route.discover !== null || route.person !== null;
  const away = hidden || covered;

  return (
    <nav
      aria-label={t("player.nav.label")}
      data-player-nav
      className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4"
      style={{
        bottom: `calc(env(safe-area-inset-bottom, 0px) + ${short ? "0.5rem" : "0.75rem"})`,
        // Transformer, jamais démonter : la barre garde sa place dans l'arbre et ne coûte qu'un
        // déplacement de calque, ce que le compositeur fait sans repeindre quoi que ce soit.
        transform: away ? "translateY(calc(100% + 1.75rem))" : "none",
        opacity: covered ? 0 : 1,
        /**
         * `visibility` en dernier, et retardée à la sortie.
         *
         * Elle ne s'interpole pas : appliquée en même temps que la translation, elle escamotait
         * la barre à l'instant zéro et l'animation ne se voyait jamais — la barre semblait
         * disparaître d'un coup. Retardée du temps du mouvement, elle attend qu'il soit fini ;
         * à l'entrée elle repasse à « visible » sans délai, sinon c'est le retour qui manquerait.
         */
        transition: `transform ${AWAY_MS}ms cubic-bezier(0.32, 0.72, 0, 1), opacity 180ms linear, visibility 0s linear ${
          away ? AWAY_MS : 0
        }ms`,
        // Inerte une fois partie, pour qu'elle ne prenne pas un appui destiné à l'image.
        visibility: away ? "hidden" : "visible",
      }}
    >
      <div
        className={`player-bar pointer-events-auto flex items-center gap-1 rounded-full ${
          short ? "px-1.5 py-1" : "px-2 py-1.5"
        }`}
      >
        {PLAYER_NAV.map(({ panel, labelKey, icon: Icon }) => {
          const on = active === panel;
          return (
            <button
              key={panel}
              type="button"
              // `onPointerDown` : sur téléphone, `click` arrive trois cents millisecondes après le
              // doigt. Une navigation qui ne coûte rien doit partir au contact.
              onPointerDown={(e) => {
                if (e.button !== 0 && e.pointerType === "mouse") return;
                openPanel(panel, route);
              }}
              // Le clic reste branché pour le clavier et les technologies d'assistance, qui
              // n'émettent pas de pointeur — et il ne fait rien de plus quand il suit un appui,
              // `openPanel` ne bougeant pas d'un écran déjà ouvert.
              onClick={() => openPanel(panel, route)}
              aria-current={on ? "page" : undefined}
              data-nav-item
              className={`flex flex-col items-center justify-center rounded-full transition-colors ${
                short ? "h-11 w-14 gap-0" : "h-14 w-16 gap-0.5"
              } ${on ? "text-white" : "text-white/55 active:text-white/80"}`}
            >
              <Icon size={short ? 19 : 20} strokeWidth={on ? 2.4 : 1.8} />
              {!short && <span className={`text-[10px] ${on ? "font-semibold" : "font-medium"}`}>{t(labelKey)}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
