/**
 * Signale au serveur un changement de langue du son fait à la main (`seriesLanguage.ts`) — par les
 * deux lecteurs, pour que la règle soit la même quel que soit celui qui joue l'épisode.
 *
 * Sans attendre ni rien afficher : ce n'est qu'une indication pour les épisodes suivants, et un envoi
 * perdu coûte au pire un changement de plus à faire à la main.
 */
export function noteSeriesLanguage(itemId: string, language: string | null): void {
  if (!language) return;
  try {
    void fetch("/api/player/series-language", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId, language }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* rien */
  }
}
