/**
 * La durée d'un épisode, en minutes — ou `null`.
 *
 * TMDB a abandonné `episode_run_time` : il revient vide pour les séries récentes. Le 21/09/2026,
 * « 45min/ép. » s'affichait sur Banshee, The Following ou Utopia, et rien sur Mr Robot, Ted Lasso
 * ou Parlement — mesuré : `episode_run_time: []` pour les deux premières, alors que la durée du
 * dernier épisode diffusé est bien là (51 et 42 min).
 *
 * D'où l'ordre : le champ historique quand il existe encore, la durée que Sonarr connaît pour une
 * série de la bibliothèque, puis celle du dernier épisode diffusé, puis du prochain. Une seule
 * règle pour les deux routes qui la donnent (`/info` des séries, `/api/player/title`).
 */
export function tvEpisodeRuntime(
  tmdb: {
    episode_run_time?: number[];
    last_episode_to_air?: { runtime?: number | null } | null;
    next_episode_to_air?: { runtime?: number | null } | null;
  } | null,
  sonarrRuntime?: number | null
): number | null {
  const candidates = [
    tmdb?.episode_run_time?.[0],
    sonarrRuntime,
    tmdb?.last_episode_to_air?.runtime,
    tmdb?.next_episode_to_air?.runtime,
  ];
  for (const minutes of candidates) {
    if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) return minutes;
  }
  return null;
}
