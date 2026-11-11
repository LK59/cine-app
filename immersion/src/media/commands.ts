import { useStore } from "../state/store";
import { chooseSubtitle, close, open, switchAudio } from "./playback";
import { noteViewerPresent } from "./presence";

/**
 * Les commandes de lecture : la **seule** porte par laquelle on agit sur ce qui joue.
 *
 * Aucun composant, aucune action ne touche au `<video>` ; ils envoient une commande ici. La commande
 * écrit ce qui est *voulu* dans l'état (`Playback`, `state/store.ts`), et le contrôleur
 * (`playback.ts`) fait suivre le `<video>`. Un seul endroit à brancher le jour où ces commandes
 * devront aussi partir vers d'autres spectateurs, ou en arriver (`docs/MULTIJOUEUR.md`) : c'est le
 * sens du paramètre `origin`, qui ne sert encore à rien.
 */
export type Command =
  /**
   * Lancer un titre. `from` : une position imposée ; `null` : la reprise du compte. `auto` : l'épisode suivant
   * lancé par la fin d'un décompte (`upNext.ts`), le seul geste qui ne dit pas que quelqu'un est là.
   */
  | { type: "open"; item: { id: string; title: string }; from: number | null; auto?: boolean; paused?: boolean }
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  /** Aller à cette position, en secondes. */
  | { type: "seek"; to: number }
  /** Avancer ou reculer de tant de secondes. */
  | { type: "seekBy"; delta: number }
  | { type: "mute"; muted?: boolean }
  /** Écouter cette piste audio (index Jellyfin) : le flux est renégocié, à la position où l'on est. */
  | { type: "audio"; index: number }
  /** Lire ces sous-titres (index Jellyfin), ou aucun. */
  | { type: "subtitle"; index: number | null }
  /** Arrêter et éteindre les écrans. */
  | { type: "stop" };

let seekCount = 0;

/**
 * Dans un salon, la télévision est commune (`net/tv.ts`) : lancer, reprendre, mettre en pause, sauter et arrêter
 * partent au service au lieu de s'appliquer ici, et reviennent comme commandes `remote`. Le relais rend `true` quand il
 * a pris la commande. Le son, les pistes et les sous-titres restent à chacun.
 */
let sharedPlayback: ((command: Command) => boolean) | null = null;
export function setSharedPlayback(sink: ((command: Command) => boolean) | null): void {
  sharedPlayback = sink;
}

export function dispatch(command: Command, origin: "local" | "remote" = "local"): void {
  const state = useStore.getState();
  const playback = state.playback;
  const live = playback.status === "playing" || playback.status === "paused";
  if (!(command.type === "open" && command.auto)) noteViewerPresent();
  if (origin === "local" && sharedPlayback?.(command)) return;
  switch (command.type) {
    case "open":
      state.setPlayback({ wantPaused: !!command.paused, seek: null });
      void open(command.item, command.from, !!command.paused);
      return;
    case "stop":
      close();
      return;
    case "play":
      if (live) state.setPlayback({ wantPaused: false });
      return;
    case "pause":
      if (live) state.setPlayback({ wantPaused: true });
      return;
    case "toggle":
      if (live) state.setPlayback({ wantPaused: !playback.wantPaused });
      return;
    case "seek":
      if (live) state.setPlayback({ seek: { to: Math.max(0, command.to), n: ++seekCount } });
      return;
    case "seekBy": {
      if (!live) return;
      // La position observée est déjà celle du dernier saut (le contrôleur l'écrit en l'appliquant) :
      // deux appuis rapides font bien vingt secondes.
      const end = playback.duration > 1 ? playback.duration - 1 : Infinity;
      state.setPlayback({ seek: { to: Math.max(0, Math.min(end, playback.position + command.delta)), n: ++seekCount } });
      return;
    }
    case "mute":
      state.setPlayback({ muted: command.muted ?? !playback.muted });
      return;
    case "audio":
      if (live && command.index !== playback.audioIndex) switchAudio(command.index);
      return;
    case "subtitle":
      if (live) chooseSubtitle(command.index);
      return;
  }
}

