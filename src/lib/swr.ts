export const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erreur ${res.status}`);
  }
  return res.json();
};

/**
 * Les deux flux qui vieillissent pendant qu'on regarde ailleurs.
 *
 * Tout le reste du catalogue est figé volontairement — il ne change qu'au rythme des imports, et
 * le recharger au retour coûterait 1,4 Mo pour rien. Ces deux-là sont l'exception : la position
 * d'un film et l'épisode qui attend sont exactement ce qui a bougé pendant que le téléphone
 * dormait, ou pendant qu'on regardait la même série sur la télé.
 */
export const RESUME_KEY = "/api/jellyfin/resume";
export const NEXT_UP_KEY = "/api/cinema/next-up";

/**
 * De quoi rouvrir l'application sur des données vraies.
 *
 * `revalidateOnFocus` écoute `visibilitychange` autant que `focus` : c'est ce qui fait la
 * différence entre revenir d'une veille et revenir d'un autre onglet. L'intervalle empêche un
 * va-et-vient entre deux applications de déclencher une requête par aller-retour.
 */
export const liveFeedOptions = {
  revalidateOnFocus: true,
  focusThrottleInterval: 30_000,
} as const;
