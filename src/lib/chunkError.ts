/**
 * L'erreur qui n'est pas une erreur de l'application : un morceau de code qui a disparu du serveur.
 *
 * Next découpe le bundle et charge certains écrans à la demande — ici les deux clients cinéma, le
 * mobile et le bureau, chargés par `next/dynamic`. Redimensionner la fenêtre au-delà du point de
 * bascule déclenche donc un import à l'exécution.
 *
 * Or un déploiement renomme ces fichiers : ils portent le hachage de leur contenu. Un onglet resté
 * ouvert pendant une mise en production demande alors un nom qui n'existe plus, et reçoit un 404.
 * Rien n'est cassé dans l'application — c'est la page qui est plus vieille que le serveur.
 *
 * Ce que le bouton « Réessayer » ne pouvait pas régler : webpack garde en mémoire la promesse
 * rejetée du morceau manquant. Refaire le rendu redemande donc le même nom absent et échoue à
 * l'identique, indéfiniment. Il faut recharger la page, pas réessayer.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const named = (error as { name?: string }).name === "ChunkLoadError";
  const message = (error as { message?: string }).message ?? "";
  return named || /Loading chunk|Failed to load chunk|Loading CSS chunk|dynamically imported module/i.test(message);
}

/**
 * Une seule fois, et c'est le point important.
 *
 * Si le morceau manque encore après le rechargement — un déploiement à moitié publié, un cache
 * intermédiaire qui sert un index neuf et des fichiers anciens — recharger en boucle donnerait un
 * écran blanc clignotant dont personne ne peut sortir. Au deuxième passage on laisse donc l'erreur
 * s'afficher, avec son bouton, et le viseur reprend la main.
 *
 * Le drapeau vit dans `sessionStorage` : il disparaît avec l'onglet, ce qui est exactement sa durée
 * de vie utile. Et l'accès est gardé — un navigateur en navigation privée peut lever ici, et une
 * garde qui lève sur le chemin d'erreur de quelqu'un d'autre devient l'erreur.
 */
const RELOADED_KEY = "cine:chunk-reloaded";

export function recoverFromChunkError(): boolean {
  try {
    if (sessionStorage.getItem(RELOADED_KEY)) return false;
    sessionStorage.setItem(RELOADED_KEY, "1");
  } catch {
    // Stockage indisponible : on recharge quand même, une fois vaut mieux que jamais.
  }
  window.location.reload();
  return true;
}

/** Appelée quand l'application a fini par se monter : le tour d'après repart d'une page saine. */
export function forgetChunkReload(): void {
  try {
    sessionStorage.removeItem(RELOADED_KEY);
  } catch {
    // Sans conséquence : le drapeau meurt avec l'onglet de toute façon.
  }
}
