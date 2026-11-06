"use client";

import type { CSSProperties, ReactNode } from "react";
import { BrandMark } from "@/components/BrandMark";
import { CinemaSkeletonCards } from "@/components/cinema/CinemaRowSkeleton";
import { carouselTransform } from "@/lib/useCarouselDrag";
import { APP_NAME } from "@/lib/appBuild";

/**
 * Les squelettes des deux accueils, et les mesures qu'ils partagent avec eux.
 *
 * Deux moments les montrent : l'écran de lancement (`(player)/page.tsx`), le temps que le morceau
 * de l'écran et le catalogue gardé sur l'appareil arrivent, et l'accueil lui-même tant qu'il n'a
 * aucun catalogue. Jusqu'au 06/11/2026 le premier était un rond qui tourne sur fond noir, remplacé
 * d'un coup par l'accueil ; c'est maintenant la forme de l'accueil qui va se monter — bannière,
 * titres de rangées, affiches à leur taille et à leur espacement —, et le montage la remplit.
 *
 * Les largeurs et la part de la bannière vivent ici et les accueils les importent : un squelette
 * resté à 50 % quand l'écran était passé à 44 faisait remonter toutes les rangées à chaque
 * chargement à froid (23/09/2026). Une mesure, un endroit.
 *
 * Ce module ne lit rien de l'appareil : rendu au serveur (l'écran de lancement l'est), il ne sait
 * pas lequel des deux montrer. L'écran de lancement rend les deux, et la marque d'interface posée
 * avant le premier dessin cache l'autre (`interfaceDecision.ts`, `data-ui-only`). Couché ou sur
 * iPad, c'est le CSS qui choisit la forme de la bannière du téléphone — les mêmes requêtes que
 * `useIsShortViewport` et `useIsTablet`.
 *
 * Inertes : `aria-hidden`, rien de focalisable — ils ne sont pas encore quelque chose.
 */

// ── Bureau ──────────────────────────────────────────────────────────────────────────────────────

/**
 * La part de l'écran que prend la bannière — pour le vrai écran *et* pour son squelette.
 *
 * 44 % et non 50 % : la première page doit montrer la bannière, la rangée « À la une » *entière*,
 * puis le titre de « Reprendre » et le haut de ses affiches — c'est ce qui dit qu'on peut
 * descendre. Six points de hauteur suffisent à l'obtenir.
 */
export const DESKTOP_HERO_BASIS = "44%";

// w-24→lg:w-36 (96px→144px), down from the original w-40/sm:w-48 (160/192px) fixed pair — that
// fixed size overflowed the row on anything shorter than a large desktop window, pushing the row
// label itself off (above) the visible area. Shared between ContinueCard and CinemaCard so both
// grids stay visually aligned.
export const DESKTOP_CARD_WIDTH = "w-24 sm:w-28 md:w-32 lg:w-36";

// Same edge-fade mask as CinemaRow/CinemaSeriesRow (see their own doc comment).
export const DESKTOP_EDGE_FADE: CSSProperties = {
  maskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
  WebkitMaskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
};

/**
 * L'accueil du bureau sans son contenu : la bannière (44 %) et sa colonne de texte en bas à gauche,
 * puis une rangée d'affiches. `--player-rail` réserve la pilule du rail, comme le vrai écran — et
 * dès le premier dessin, la marque d'interface la posant avant que `PlayerShell` ne le fasse.
 */
export function DesktopHomeSkeleton({ children }: { children?: ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-ink" style={{ zIndex: 45, paddingLeft: "var(--player-rail, 0px)" }}>
      <div aria-hidden className="relative min-h-0 shrink grow-0" style={{ flexBasis: DESKTOP_HERO_BASIS }}>
        <div className="flex h-full max-w-2xl flex-col justify-end gap-4 px-8 pb-10 sm:px-12">
          <div className="skeleton h-12 w-72 rounded-lg sm:h-16" />
          <div className="skeleton h-4 w-48 rounded" />
          <div className="skeleton h-4 w-full max-w-xl rounded" />
          <div className="skeleton h-4 w-2/3 max-w-md rounded" />
        </div>
      </div>
      <div aria-hidden className="min-h-80 flex-1 pt-6">
        <div className="mb-2 px-8 sm:px-12">
          <div className="skeleton h-4 w-28 rounded" />
        </div>
        <div className="flex gap-3 px-8 pb-4 pt-3 sm:px-12" style={DESKTOP_EDGE_FADE}>
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className={`skeleton ${DESKTOP_CARD_WIDTH} aspect-2/3 shrink-0 rounded-lg`} />
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}

// ── Téléphone (et iPad à l'interface tactile) ───────────────────────────────────────────────────

// Roughly a third of a phone's width, so a row always shows "two and a bit" posters — the visual
// cue that it scrolls, without a card so small the artwork stops being readable.
// `tablet:` — l'iPad, en grand (16/10/2026) : cinq affiches et demie debout, sept ou huit couché.
export const MOBILE_POSTER_WIDTH = "w-28 sm:w-32 tablet:w-36";
export const MOBILE_CONTINUE_WIDTH = "w-44 sm:w-48 tablet:w-60";

/** Couché : `useIsShortViewport`, en CSS. */
const SHORT = "[@media(max-height:500px)]";

/**
 * Une rangée de `MobileRow` (CinemaMobileClient) : mêmes marges, un trait à la place du titre, sur
 * la hauteur de sa ligne (`text-sm`, `tablet:text-lg`), et les cartes vides de « Reprendre » et de
 * « Ma liste » — celles que l'accueil montre lui-même tant que ces rangées arrivent.
 */
function MobileRowSkeleton({ cards }: { cards: ReactNode }) {
  return (
    <section className={`mt-6 tablet:mt-8 ${SHORT}:mt-4`}>
      <div className={`mb-2 flex h-5 items-center px-4 tablet:mb-3 tablet:h-7 tablet:px-8 ${SHORT}:mb-1.5`}>
        <div className="skeleton h-3.5 w-32 rounded tablet:h-4" />
      </div>
      <div className="flex gap-3 overflow-hidden px-4 pb-1 tablet:gap-4 tablet:px-8">{cards}</div>
    </section>
  );
}

/**
 * Le contenu qui défile, sans contenu : la bannière dans ses trois formes (`CinemaMobileHero`),
 * puis « Reprendre » et une rangée d'affiches.
 *
 *  - debout sur un téléphone : l'affiche à 86 % de la largeur, ses voisines réduites et estompées
 *    qui dépassent (`hero-peek-slide`, la piste posée par `carouselTransform`, comme la vraie) ;
 *  - couché : la ligne compacte, petite affiche et texte à côté ;
 *  - sur iPad : l'image de fond, 16/10 debout et 3/1 couché.
 * Sous la bannière, la place de ses barres de progression.
 */
export function MobileHomeSkeletonBody() {
  return (
    <div aria-hidden>
      <section className="px-4 pt-2 tablet:px-8">
        <div className={`-mx-4 overflow-hidden py-1 tablet:hidden ${SHORT}:hidden`}>
          <div className="flex gap-3" style={{ ["--carousel-slide" as string]: "86%", transform: carouselTransform(1, 0, true) }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className={`hero-peek-slide shrink-0 ${i === 1 ? "hero-peek-on" : ""}`}>
                <div className="skeleton aspect-2/3 w-full rounded-2xl" />
              </div>
            ))}
          </div>
        </div>
        <div className={`hidden gap-4 rounded-2xl bg-surface/70 p-3 ${SHORT}:flex`}>
          <div className="skeleton aspect-2/3 w-24 shrink-0 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
            <div className="skeleton h-6 w-40 rounded" />
            <div className="skeleton h-3 w-32 rounded" />
            <div className="skeleton mt-1 h-9 w-44 rounded-full" />
          </div>
        </div>
        <div className="skeleton hidden aspect-16/10 w-full rounded-2xl tablet:block landscape:aspect-3/1" />
        <div className="mx-auto mt-3 h-1 max-w-xs rounded-full bg-white/[0.06]" />
      </section>
      <MobileRowSkeleton cards={<CinemaSkeletonCards cardClassName={MOBILE_CONTINUE_WIDTH} shape="still" count={3} />} />
      <MobileRowSkeleton cards={<CinemaSkeletonCards cardClassName={MOBILE_POSTER_WIDTH} shape="poster" count={6} />} />
    </div>
  );
}

/**
 * Tout l'écran du téléphone, pour l'écran de lancement : le cadre de `CinemaMobileClient` (hauteur
 * de l'app, zones sûres), sa barre du haut — la marque et le nom, vrais ; à la place de la bascule
 * Films/Séries et du rond « Tous les… », leurs formes, à leur hauteur de 36 px —, puis le contenu.
 */
export function MobileHomeSkeleton({ children }: { children?: ReactNode }) {
  return (
    <div className="app-viewport safe-x fixed inset-x-0 top-0 flex flex-col overflow-hidden bg-ink" style={{ zIndex: 45 }}>
      <div
        aria-hidden
        className={`relative grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 bg-ink px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+1.25rem)] ${SHORT}:pb-2 ${SHORT}:pt-[calc(env(safe-area-inset-top,0px)+0.6rem)]`}
      >
        <div className="flex min-w-0 items-center gap-1.5 py-1 pr-2 text-white">
          <BrandMark size={18} />
          <span className="truncate font-display text-sm font-semibold tracking-tight max-[340px]:hidden">{APP_NAME}</span>
        </div>
        <div className="h-9 w-40 justify-self-center rounded-full bg-white/[0.06]" />
        <div className="ml-auto h-9 w-9 rounded-full bg-white/[0.06]" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <MobileHomeSkeletonBody />
      </div>
      {children}
    </div>
  );
}

/**
 * Les deux, pour l'écran de lancement rendu au serveur : chacun dans l'enveloppe que la marque
 * d'interface cache ou montre (`data-ui-only`, `globals.css`). `contents` : l'enveloppe ne dessine
 * rien, chaque squelette garde sa position `fixed`.
 */
export function HomeSkeletons() {
  return (
    <>
      <div className="contents" data-ui-only="desktop">
        <DesktopHomeSkeleton />
      </div>
      <div className="contents" data-ui-only="touch">
        <MobileHomeSkeleton />
      </div>
    </>
  );
}
