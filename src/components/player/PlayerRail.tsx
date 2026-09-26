"use client";

import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { Clapperboard } from "lucide-react";
import { useCinemaRoute } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { prefetchRoute } from "@/lib/prefetch";
import { PLAYER_NAV, MANAGE_ITEM, activePanel, openPanel } from "./playerNav";
import { useReportBadge } from "@/lib/useReportBadge";
import { NavDot } from "./NavDot";
import { inHiddenTab } from "@/lib/keptTabs";

/**
 * Le rail du lecteur — desktop.
 *
 * Une pilule d'icônes qui flotte au bord gauche, et se déploie en libellés au survol comme au
 * focus. Deux raisons de la poser *par-dessus* plutôt que de la mettre en colonne à côté :
 *
 * 1. L'écran cinéma se dessine en `fixed inset-0` (il est porté dans document.body, voir
 *    CinemaClient) ; un frère en flex ne l'aurait pas poussé, il l'aurait recouvert à moitié.
 * 2. C'est l'idiome des interfaces de télévision : la navigation ne prend de la place que
 *    lorsqu'on la regarde. Le contenu garde toute la largeur le reste du temps.
 *
 * Une pilule et non plus une bande pleine hauteur (26/09/2026) : la bande découpait l'image de
 * fond sur toute la hauteur de l'écran, pour quatre icônes. Flottante, elle laisse l'image aller
 * jusqu'au bord, et parle la même langue que la barre du téléphone (`player-bar`).
 *
 * Le contenu réserve quand même la pilule repliée : la variable `--player-rail` est posée par
 * PlayerShell sur l'élément racine, et l'écran cinéma s'en sert comme retrait à gauche. Sans ça
 * la première affiche de chaque ligne passerait sous les icônes.
 */
export function PlayerRail() {
  const route = useCinemaRoute();
  const router = useRouter();
  const t = useT();
  const badge = useReportBadge();
  const active = activePanel(route);
  // La gestion est à l'administrateur, et le panneau Compte ne la propose qu'à lui : le rail la
  // montrait à tout le monde, vers des pages où chaque bouton répond 403 (23/09/2026).
  const { data: me } = useSWR<{ role: string }>("/api/auth/me", fetcher);
  const isAdmin = me?.role === "admin";

  /**
   * Les flèches, dans le rail.
   *
   * Haut et bas parcourent ses entrées ; droite en sort et rend la main à la grille, qui a sa
   * propre navigation (useTvGridNav) — laquelle ignore désormais ce qui se passe ici, sans quoi
   * une flèche vers le bas quitterait le rail dès la première pression.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (!["ArrowUp", "ArrowDown", "ArrowRight"].includes(e.key)) return;
    // `stopPropagation` : la navigation de la grille écoute sur `window`, donc après ce
    // gestionnaire. Elle voyait le focus déjà posé sur la première affiche et appliquait sa propre
    // flèche droite par-dessus — on atterrissait sur la deuxième. Ici, l'événement s'arrête.
    e.stopPropagation();
    const nav = e.currentTarget;
    const items = Array.from(nav.querySelectorAll<HTMLButtonElement>("button"));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);

    if (e.key === "ArrowRight") {
      // La première de l'écran, pas celle de l'onglet caché gardé monté (`keptTabs.ts`).
      const firstCard = Array.from(document.querySelectorAll<HTMLElement>("[data-tv-card]")).find((el) => !inHiddenTab(el));
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
      //
      // Le `nav` n'est qu'un repère pleine hauteur, transparent aux clics : seules la pilule et
      // ses boutons en prennent. Sinon la colonne vide au-dessus et au-dessous de la pilule
      // aurait avalé les clics destinés à l'image et aux fiches.
      className="player-rail-anchor pointer-events-none fixed inset-y-0 z-50 w-12"
      data-player-nav
      // La grille renvoie ici quand on va à gauche depuis sa première colonne — voir
      // useTvGridNav, qui a déjà le même renvoi vers le haut pour la bascule Films/Séries.
      data-tv-escape-left
      onKeyDown={onKeyDown}
    >
      {/* Le logo seul, posé sur l'axe de la pilule : un repère, pas une entrée. Le nom reste dit. */}
      <div className="flex h-16 items-center justify-center">
        <Clapperboard size={22} className="text-accent-400" aria-hidden />
        <span className="sr-only">Cine App</span>
      </div>

      <div className="player-rail player-bar pointer-events-auto absolute left-0 top-1/2 flex -translate-y-1/2 flex-col gap-1 overflow-hidden p-1">
        {PLAYER_NAV.map(({ panel, labelKey, icon: Icon }) => {
          const isActive = active === panel;
          return (
            <button
              key={panel}
              type="button"
              onClick={() => openPanel(panel, route)}
              aria-current={isActive ? "page" : undefined}
              // L'onglet actif s'allume en pastille, comme sur le téléphone : un trait bleu au
              // bord n'a plus de bord où s'appuyer une fois la barre détachée de la fenêtre.
              className={`relative flex h-10 shrink-0 items-center gap-3.5 overflow-hidden rounded-full pl-[0.625rem] pr-3 text-left text-sm font-medium transition-colors active:transform-none active:bg-white/15 active:delay-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                isActive ? "bg-white/12 text-white" : "text-subtle hover:bg-white/8 hover:text-white"
              }`}
            >
              <span className="relative shrink-0">
                <Icon size={20} strokeWidth={isActive ? 2.4 : 1.8} />
                {panel === "account" && badge.any && <NavDot />}
              </span>
              <span className="player-rail-label whitespace-nowrap">
                {t(labelKey)}
              </span>
            </button>
          );
        })}

        {/* La porte vers la gestion : toujours là, jamais mise en avant. Une ligne de séparation,
            une icône plus petite, une couleur en retrait — celui qui la cherche la trouve,
            l'autre ne la lit jamais. */}
        {isAdmin && (
          <>
            <div className="mx-2 my-0.5 h-px shrink-0 bg-white/10" />
            <button
              type="button"
              onClick={() => router.push(MANAGE_ITEM.href)}
              onMouseEnter={() => prefetchRoute(MANAGE_ITEM.href)}
              onFocus={() => prefetchRoute(MANAGE_ITEM.href)}
              className="flex h-10 shrink-0 items-center gap-3.5 overflow-hidden rounded-full pl-[0.75rem] pr-3 text-left text-xs text-subtle transition-colors hover:bg-white/5 hover:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              <MANAGE_ITEM.icon size={16} className="shrink-0" />
              <span className="player-rail-label whitespace-nowrap">
                {t(MANAGE_ITEM.labelKey)}
              </span>
            </button>
          </>
        )}
      </div>
    </nav>
  );
}
