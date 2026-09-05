"use client";

import { useRouter } from "next/navigation";
import { Clapperboard } from "lucide-react";
import { useCinemaRoute } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { prefetchRoute } from "@/lib/prefetch";
import { PLAYER_NAV, MANAGE_ITEM, activePanel, openPanel } from "./playerNav";

/**
 * Le rail du lecteur — desktop.
 *
 * C'est une bande d'icônes posée sur le contenu, qui se déploie en libellés au survol comme au
 * focus. Deux raisons de le poser *par-dessus* plutôt que de le mettre en colonne à côté :
 *
 * 1. L'écran cinéma se dessine en `fixed inset-0` (il est porté dans document.body, voir
 *    CinemaClient) ; un frère en flex ne l'aurait pas poussé, il l'aurait recouvert à moitié.
 * 2. C'est l'idiome des interfaces de télévision : la navigation ne prend de la place que
 *    lorsqu'on la regarde. Le contenu garde toute la largeur le reste du temps.
 *
 * Le contenu réserve quand même la bande repliée : la variable `--player-rail` est posée par
 * PlayerShell sur l'élément racine, et l'écran cinéma s'en sert comme retrait à gauche. Sans ça
 * la première affiche de chaque ligne passerait sous les icônes.
 */
export function PlayerRail() {
  const route = useCinemaRoute();
  const router = useRouter();
  const t = useT();
  const active = activePanel(route);

  /**
   * Les flèches, dans le rail.
   *
   * Haut et bas parcourent ses entrées ; droite en sort et rend la main à la grille, qui a sa
   * propre navigation (useTvGridNav) — laquelle ignore désormais ce qui se passe ici, sans quoi
   * une flèche vers le bas quitterait le rail dès la première pression.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (!["ArrowUp", "ArrowDown", "ArrowRight"].includes(e.key)) return;
    const nav = e.currentTarget;
    const items = Array.from(nav.querySelectorAll<HTMLButtonElement>("button"));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);

    if (e.key === "ArrowRight") {
      const firstCard = document.querySelector<HTMLElement>("[data-tv-card]");
      if (!firstCard) return;
      e.preventDefault();
      firstCard.focus();
      return;
    }
    if (index === -1) return;
    const next = e.key === "ArrowDown" ? index + 1 : index - 1;
    if (next < 0 || next >= items.length) return;
    e.preventDefault();
    items[next].focus();
  }

  return (
    <nav
      aria-label={t("player.nav.label")}
      // Pas de `hidden md:flex` : c'est PlayerShell qui décide, avec `useIsMobile` — dont la
      // définition n'est pas celle de la barre `md` de Tailwind (un téléphone couché fait
      // ~844 px de large et franchit `md`, tout en restant un téléphone). Deux définitions
      // concurrentes du même « est-ce un mobile » laissaient l'écran sans navigation du tout en
      // paysage : le composant rendait le tiroir, et la classe `md:hidden` le cachait.
      className="player-rail fixed inset-y-0 left-0 z-50 flex flex-col"
      data-player-nav
      // La grille renvoie ici quand on va à gauche depuis sa première colonne — voir
      // useTvGridNav, qui a déjà le même renvoi vers le haut pour la bascule Films/Séries.
      data-tv-escape-left
      onKeyDown={onKeyDown}
    >
      <div className="flex h-16 shrink-0 items-center gap-3 overflow-hidden px-[1.35rem]">
        <Clapperboard size={22} className="shrink-0 text-accent-400" />
        <span className="player-rail-label whitespace-nowrap font-display text-base font-semibold text-white">
          Cine
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-1 overflow-hidden px-3 pt-4">
        {PLAYER_NAV.map(({ panel, labelKey, icon: Icon }) => {
          const isActive = active === panel;
          return (
            <button
              key={panel}
              type="button"
              onClick={() => openPanel(panel, route)}
              aria-current={isActive ? "page" : undefined}
              className={`relative flex h-11 shrink-0 items-center gap-4 overflow-hidden rounded-lg pl-[0.85rem] pr-3 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                isActive
                  ? "text-white before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-accent-500"
                  : "text-slate-400 hover:bg-white/10 hover:text-white"
              }`}
            >
              <Icon size={21} className="shrink-0" />
              <span className="player-rail-label whitespace-nowrap">
                {t(labelKey)}
              </span>
            </button>
          );
        })}
      </div>

      {/* La porte vers la gestion : toujours là, jamais mise en avant. Une ligne de séparation,
          un corps plus petit, une couleur en retrait — celui qui la cherche la trouve, l'autre ne
          la lit jamais. */}
      <div className="shrink-0 overflow-hidden border-t border-white/10 px-3 py-3">
        <button
          type="button"
          onClick={() => router.push(MANAGE_ITEM.href)}
          onMouseEnter={() => prefetchRoute(MANAGE_ITEM.href)}
          onFocus={() => prefetchRoute(MANAGE_ITEM.href)}
          className="flex h-9 w-full items-center gap-4 overflow-hidden rounded-lg pl-[0.95rem] pr-3 text-left text-[11px] text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
        >
          <MANAGE_ITEM.icon size={17} className="shrink-0" />
          <span className="player-rail-label whitespace-nowrap">
            {t(MANAGE_ITEM.labelKey)}
          </span>
        </button>
      </div>
    </nav>
  );
}
