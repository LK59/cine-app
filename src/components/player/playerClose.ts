import { refreshAfterPlayback } from "@/lib/swr";

/**
 * Fermer le lecteur, passer à l'épisode suivant : une seule suite pour les quatre hôtes
 * (DECISIONS.md §114).
 *
 * Elle était écrite quatre fois — natif (`ExperimentalPlayerHost`), serveur (`PlayerHost`), hors
 * ligne (`OfflinePlayerHost`), Chromecast (`ChromecastPlayer`) —, chacun avec son propre `200` ou
 * son propre `CLOSE_MS`, et l'audit du lecteur (22/10/2026) les a trouvées identiques à quelques
 * étapes près. Les étapes qui diffèrent le font exprès, et restent au site d'appel :
 *
 *  * **la garde** est celle de chaque hôte (§36) — `lifecycle.noteClosing()` pour le natif, qui la
 *    range avec sa machine à états ; une référence pour le serveur et le hors ligne (`claimOnce`) et
 *    pour la diffusion, qui y avance aussi sa génération. Ce module ne la tient pas : il la demande
 *    (`claim`). Jamais un état React : deux appels dans le même tour le liraient tous deux d'avant
 *    (le hors ligne, jusqu'au 23/10/2026 — §116) ;
 *  * **la ligne `stop`** : le hors ligne n'écrit pas au journal du lecteur ;
 *  * **le téléviseur** (`release`) : l'arrêt AirPlay du serveur, la fin de séance Chromecast ;
 *  * **le fondu** (`setClosing`) : la télécommande Chromecast n'a pas d'image à faire disparaître ;
 *  * **le plein écran** : la télécommande Chromecast ne le quitte pas ;
 *  * **la relecture des vues** : pas après une scène (§91), qui ne les a pas changées.
 */

/**
 * Le fondu de fermeture des lecteurs, en millisecondes : `playback.close(openId)` part à son terme.
 * Une seule valeur — les quatre hôtes l'écrivaient chacun.
 */
export const PLAYER_CLOSE_MS = 200;

/** L'épisode qu'on enchaîne, tel que `PlaybackProvider.advance` le reçoit. */
export interface AdvanceTarget {
  itemId: string;
  title: string;
  resumeAt?: number;
}

export interface PlayerCloseSteps {
  /**
   * La garde de l'hôte : vrai la première fois seulement, et l'hôte s'y note fermé. Un second appui,
   * un Retour pendant le fondu, ne renvoient ni ligne `stop`, ni arrêt, ni relecture (§36).
   */
  claim: () => boolean;
  /** Sortir du plein écran du document — tous les hôtes sauf la télécommande Chromecast. */
  leaveFullscreen: boolean;
  /** La ligne `stop "close"` au journal du lecteur ; absente pour le hors ligne, qui n'y écrit pas. */
  reportStop?: () => void;
  /** L'arrêt chez Jellyfin (`usePlaybackSession().stop`) — sa promesse attend la relecture des vues. */
  stopReporting: () => Promise<void>;
  /** Arrêter le téléviseur, après l'arrêt rapporté pour que la position rapportée reste la bonne. */
  release?: () => void;
  /** Le fondu ; absent quand il n'y a pas d'image (Chromecast). */
  setClosing?: (closing: true) => void;
  playback: { close: (openId?: number) => void };
  /** Cette lecture-ci seulement : un film lancé pendant le fondu n'est pas refermé à sa place. */
  openId: number | undefined;
  itemId: string;
  /** Relire la fiche, « Reprendre » et les listes — faux après une scène (§91). */
  refresh: boolean;
}

/**
 * La garde d'un hôte qui la tient dans une référence : vrai la première fois seulement, et la
 * référence notée fermée aussitôt — un second appel dans le même tour (double appui, Retour puis
 * croix) la trouve déjà prise. Un état React ne le permet pas : le second appel lit encore la valeur
 * du rendu d'avant (le hors ligne, deux arrêts et deux relectures jusqu'au 23/10/2026, §116).
 */
export function claimOnce(closed: { current: boolean }): boolean {
  if (closed.current) return false;
  closed.current = true;
  return true;
}

/** Ferme le lecteur ; faux si la garde de l'hôte a refusé (déjà fermé). */
export function closePlayerSession(steps: PlayerCloseSteps): boolean {
  if (!steps.claim()) return false;
  if (steps.leaveFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  steps.reportStop?.();
  // Tout de suite, pas au démontage : la position de reprise est celle de la croix, pas celle où
  // `currentTime` aura dérivé pendant le fondu.
  const reported = steps.stopReporting();
  steps.release?.();
  steps.setClosing?.(true);
  const { openId, playback } = steps;
  setTimeout(() => playback.close(openId), PLAYER_CLOSE_MS);
  // La fiche et la rangée « Reprendre » sont fausses dès qu'on quitte le film. Hors du chemin de la
  // fermeture : l'écran part tout de suite, la relecture attend l'arrêt et l'écran libéré.
  if (steps.refresh) void refreshAfterPlayback(reported, steps.itemId);
  return true;
}

export interface AdvanceSteps {
  /**
   * La séance est close (croix pendant le décompte de l'épisode suivant, main passée) : rien à
   * enchaîner — l'épisode 2 était sinon monté puis démonté aussitôt (§36). Le site d'appel y ajoute
   * ce qui lui est propre (l'épisode déjà à l'écran, pour le menu « Épisodes »).
   */
  over: boolean;
  /** La ligne `stop "next"` au journal du lecteur. */
  reportStop: () => void;
  /** L'arrêt chez Jellyfin, sans l'attendre : le lecteur reste ouvert pour l'épisode suivant. */
  stopReporting: () => unknown;
  playback: { advance: (next: AdvanceTarget) => void };
}

/**
 * Passe à l'épisode `target` dans la même séance — sans fondu ni fermeture, la position finale de
 * l'épisode quitté rapportée d'abord. Faux si rien n'a été enchaîné.
 */
export function advanceTo(target: AdvanceTarget | null, steps: AdvanceSteps): boolean {
  if (!target || steps.over) return false;
  steps.reportStop();
  steps.stopReporting();
  steps.playback.advance(target);
  return true;
}
