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

/** Le logo d'un titre, détaché du fond quel qu'il soit. */
export const LOGO_STYLE = { filter: "drop-shadow(0 6px 20px rgb(0 0 0 / 0.6))" } as const;

/**
 * Où l'on en est, montré plutôt qu'écrit.
 *
 * « 1h34 restants » était sur le bouton, et rien ne le montrait : on lisait le temps qui reste
 * sans jamais voir la part déjà vue.
 */
export function CinemaProgressBar({
  resumeTicks,
  runtimeTicks,
}: {
  resumeTicks: number | null | undefined;
  runtimeTicks: number | null | undefined;
}) {
  if (!resumeTicks || !runtimeTicks || runtimeTicks <= 0) return null;
  const pct = Math.min(100, Math.max(1, (resumeTicks / runtimeTicks) * 100));
  return (
    <div className="h-1 w-48 max-w-full overflow-hidden rounded-full bg-white/25">
      <div className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
    </div>
  );
}
