/**
 * Un élément vidéo joue-t-il en ce moment sur un téléviseur ?
 *
 * Les événements disent quand la route change — `webkitcurrentplaybacktargetiswirelesschanged`
 * sous WebKit, `connect` / `disconnect` de `remote` ailleurs —, jamais ce qu'elle est quand on
 * arrive. Un lecteur remonté pendant une diffusion (une relance, l'épisode suivant) écoutait donc
 * une route déjà établie et n'en voyait rien : vingt-sept minutes sur un téléviseur, écrites
 * « sans diffusion » dans le journal (24/09/2026). Ceci lit l'état lui-même. Ne lève jamais.
 */
export function castRouteActive(video: HTMLVideoElement & { webkitCurrentPlaybackTargetIsWireless?: boolean }): boolean {
  try {
    if (video.webkitCurrentPlaybackTargetIsWireless === true) return true;
    return video.remote?.state === "connected";
  } catch {
    return false;
  }
}
