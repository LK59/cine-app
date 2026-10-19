/**
 * Lancer une chose une fois que le film montre sa première image — jamais avant.
 *
 * Écrit pour les planches de prévisualisation (15/10/2026, LECTEUR-6) : parties toutes au montage,
 * elles occupaient un lien à 2 Mbit/s pendant 26 s avant l'init du film. Partagé depuis le 19/10/2026
 * avec les miniatures du menu « Épisodes » : ce qui embellit le lecteur attend que le film soit là.
 *
 * « Là » : l'élément joue (`playing`), ou il a de quoi jouer hors d'un saut (`readyState` ≥ 3 — un
 * film mis en pause à l'ouverture, ou des commandes remontées sur un film qui joue). Pas sur le
 * `canplay` de la position 0 que le lecteur serveur a avant de sauter à la reprise : `seeking` l'écarte.
 * Sans élément, tout de suite. Une seule fois ; la fonction rendue détache les écouteurs.
 */
export function afterFirstPicture(video: HTMLVideoElement | null, run: () => void): () => void {
  let done = false;
  const begin = () => {
    if (done) return;
    done = true;
    detach();
    run();
  };
  const ifReady = () => {
    if (video && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !video.seeking) begin();
  };
  const detach = () => {
    video?.removeEventListener("playing", begin);
    video?.removeEventListener("canplay", ifReady);
    video?.removeEventListener("seeked", ifReady);
  };
  if (!video) {
    begin();
    return () => {};
  }
  video.addEventListener("playing", begin);
  video.addEventListener("canplay", ifReady);
  video.addEventListener("seeked", ifReady);
  ifReady();
  return () => {
    done = true;
    detach();
  };
}
