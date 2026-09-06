"use client";

import { useRef } from "react";
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

/** Le clic qui suit un appui arrive dans cette fenêtre : au-delà, c'est un vrai clic à lui seul. */
const DOUBLE_FIRE_MS = 700;

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
  // Effacée pendant qu'une fiche est ouverte : elle recouvre l'écran entier, et la barre y
  // flotterait au-dessus d'un contenu qu'elle ne commande pas.
  const covered = route.film !== null || route.serie !== null || route.discover !== null || route.person !== null;
  const short = useIsShortViewport();
  // Désactivée pendant qu'une fiche recouvre l'écran : sans ça, le défilement de la fiche la
  // laissait « cachée », et refermer la fiche découvrait une barre absente qu'il fallait aller
  // rechercher en remontant. Le crochet repart de zéro quand il reprend la main.
  const hidden = useHideOnScroll(!covered);
  const active = activePanel(route);
  const away = hidden || covered;
  /** Ce qui sépare la barre du bord de l'écran — et donc ce qu'il faut franchir pour en sortir. */
  const gap = `calc(env(safe-area-inset-bottom, 0px) + ${short ? "0.5rem" : "0.75rem"})`;
  /** Quand le pointeur a déjà fait le travail — voir la garde du clic. */
  const handledAt = useRef(0);

  return (
    <nav
      aria-label={t("player.nav.label")}
      data-player-nav
      className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4"
      style={{
        bottom: gap,
        // Transformer, jamais démonter : la barre garde sa place dans l'arbre et ne coûte qu'un
        // déplacement de calque, ce que le compositeur fait sans repeindre quoi que ce soit.
        /**
         * Assez bas pour sortir de l'écran, et pas seulement de sa propre hauteur.
         *
         * La barre flotte à quelques dizaines de pixels du bord — la zone sûre de l'indicateur
         * d'accueil, plus sa marge. Ne la déplacer que de sa hauteur la laissait donc à cheval
         * sur le bord : le mouvement s'arrêtait avec un bandeau encore visible, que `visibility`
         * escamotait ensuite d'un coup. Ce qui se lisait comme une animation en deux temps
         * n'était que ça — un mouvement trop court, suivi d'une coupure.
         */
        transform: away ? `translateY(calc(100% + ${gap} + 1rem))` : "none",
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
                handledAt.current = Date.now();
                openPanel(panel, route);
              }}
              /* Le clic reste branché pour le clavier et les technologies d'assistance, qui
                 n'émettent aucun pointeur. Mais un appui en émet un *puis* un clic : sans cette
                 garde, le même geste ouvrirait deux fois, et une entrée d'historique de plus
                 demanderait deux retours pour revenir. */
              onClick={() => {
                if (Date.now() - handledAt.current < DOUBLE_FIRE_MS) return;
                openPanel(panel, route);
              }}
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
