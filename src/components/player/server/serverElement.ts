/**
 * Ce que le lecteur serveur fait de l'élément et de la page quand il doit repartir de zéro :
 * couper la session HLS de l'élément, et écrire l'intention qu'une page rechargée relira.
 */
import { PLAYER_RELOAD_INTENT_KEY } from "@/components/PlaybackProvider";
import type { PlayerReloadIntent } from "@/lib/serverReload";

/**
 * Couper l'élément : pause, plus de source, `load()` pour que le navigateur lâche la session HLS.
 * Écrit à l'identique à quatre endroits jusqu'au 22/10/2026 ; chaque appelant garde sa propre garde
 * (`try`) et ce qui suit (rechargement ou non). Peut lever sur un élément déjà démonté.
 */
export function releaseHlsElement(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/**
 * Écrit l'intention que la page rechargée relira (`PlaybackProvider`). Faux si le stockage la refuse :
 * l'appelant garde alors son chemin d'avant (la lecture dans la page, ou l'écran d'erreur).
 */
export function reloadIntoServerPlayer(intent: PlayerReloadIntent): boolean {
  try {
    sessionStorage.setItem(PLAYER_RELOAD_INTENT_KEY, JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}
