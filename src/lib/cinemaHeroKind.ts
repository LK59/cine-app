export type CinemaTab = "movies" | "series";

/** Le dernier survol qui a désigné un titre, et l'onglet où il a eu lieu. */
export interface HeroFocus {
  tab: CinemaTab;
  kind: CinemaTab;
}

/**
 * De quelle sorte est le titre que la bannière doit montrer.
 *
 * Elle suivait l'onglet, ce qui suffisait tant qu'un onglet ne montrait que sa propre sorte.
 * « Reprendre » est commun aux deux depuis qu'un film à moitié vu ne doit plus disparaître
 * derrière un onglet où l'on n'est pas : sur l'onglet Films, survoler la carte d'une série
 * laissait alors la bannière sur le dernier film — elle annonçait autre chose que ce qu'on
 * désignait, c'est-à-dire le défaut même que le survol de ces cartes existe pour éviter.
 *
 * Le choix est rangé avec l'onglet où il a été fait. Changer d'onglet rend donc sa sorte par
 * défaut sans qu'un effet ait à remettre quoi que ce soit à zéro — et un aller-retour entre les
 * deux onglets ne ramène pas une bannière décidée ailleurs.
 */
export function heroKindFor(focus: HeroFocus | null, tab: CinemaTab): CinemaTab {
  return focus && focus.tab === tab ? focus.kind : tab;
}
