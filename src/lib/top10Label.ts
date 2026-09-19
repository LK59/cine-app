import type { Top10Theme } from "@/lib/cinemaRails";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Comment s'intitule le palmarès du jour.
 *
 * Écrit une fois pour les trois endroits qui l'affichent — les deux rangées du bureau et celle du
 * téléphone. Trois copies d'une même phrase finiraient par ne plus dire la même chose, et c'est le
 * titre qui explique au spectateur pourquoi le classement n'est pas celui d'hier.
 *
 * Un genre est repris **tel que la bibliothèque le nomme**, sans traduction : c'est déjà ainsi que
 * les rangées de genres s'intitulent, et traduire ici seulement donnerait deux noms différents pour
 * la même chose sur le même écran. Une décennie, elle, se dit dans la langue de qui lit — c'est une
 * tournure, pas un nom propre.
 */
export function top10Label(theme: Top10Theme | null, t: Translate): string {
  if (!theme) return t("cinema.top10");
  const slice = theme.kind === "genre" ? theme.genre : t("cinema.decade", { decade: theme.decade });
  return t("cinema.top10Theme", { theme: slice });
}
