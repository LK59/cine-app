import type { Top10Theme } from "@/lib/cinemaRails";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Le nom d'un genre dans la langue de qui lit.
 *
 * Les genres arrivent de Radarr et de Sonarr en anglais. Le dictionnaire les traduit, mais il ne
 * peut pas connaître ceux qui apparaîtront demain : un genre absent du dictionnaire est donc rendu
 * **tel quel**, ce qui reste lisible, plutôt que sous la forme d'une clé qui ne veut rien dire.
 * `createT` renvoie la clé quand elle manque — c'est ce que cette comparaison rattrape.
 */
export function genreLabel(genre: string, t: Translate): string {
  const key = `genres.${genre}`;
  const translated = t(key);
  return translated === key ? genre : translated;
}

/**
 * Comment s'intitule le palmarès du jour.
 *
 * Écrit une fois pour les quatre endroits qui l'affichent — les deux rangées du bureau et celles du
 * téléphone. Autant de copies d'une même phrase finiraient par ne plus dire la même chose, et c'est
 * ce titre qui explique au spectateur pourquoi le classement n'est pas celui d'hier.
 *
 * Une tranche croisée se dit d'un trait — « Comédie · années 2000 » — sans phrase à construire :
 * une formulation par langue tiendrait mal sur une largeur de téléphone, et se traduirait mal.
 */
export function top10Label(theme: Top10Theme | null, t: Translate): string {
  if (!theme) return t("cinema.top10");
  const decade = (d: number) => t("cinema.decade", { decade: d });
  const slice =
    theme.kind === "genre"
      ? genreLabel(theme.genre, t)
      : theme.kind === "decade"
        ? decade(theme.decade)
        : `${genreLabel(theme.genre, t)} · ${decade(theme.decade)}`;
  return t("cinema.top10Theme", { theme: slice });
}
