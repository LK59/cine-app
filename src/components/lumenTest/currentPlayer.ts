/**
 * Le lecteur de production d'aujourd'hui — Lumen dans la page : remux, MediaSource, `<video>` natif —, ouvert
 * par la page de banc `/lumen-test` pour le comparer à Lumen serveur sur les mêmes sauts (étape 3c,
 * docs/remux-serveur/).
 *
 * **Appelé tel qu'il est, par ses API publiques, exactement comme l'hôte natif l'ouvre** — rien de
 * `src/lib/webcodecs/` ni des hôtes du lecteur n'est modifié, et les empreintes du lecteur ne bougent pas :
 * - la description du fichier, `GET /api/jellyfin/direct/{id}` (`fetchDirectInfo`, celle que l'hôte lit avant
 *   d'ouvrir ; un `refusedReason` y refuse le fichier comme chez lui) ;
 * - `probePlaybackPath` avec l'adresse de flux de cette description (`/api/jellyfin/stream/…`, le relais de
 *   Jellyfin), sa taille, sa version, son `VideoRangeType`, la position de départ et **la piste audio par son
 *   numéro dans le fichier** (Matroska `TrackNumber`) — le même espace de numéros que la liste de Lumen serveur,
 *   donc la même piste ;
 * - `probe.start(video)` : la MediaSource attachée à l'élément (`disableRemotePlayback` compris), puis
 *   `openingHold()` avant `play()` pour un départ du début, comme l'hôte ;
 * - un saut, c'est `video.currentTime = t`, rien d'autre : `MseSource` écoute `seeking` lui-même (l'hôte ne fait
 *   pas autrement) ; la page mesure donc les deux lecteurs avec les mêmes évènements de l'élément ;
 * - `destroy()` à la fin : MediaSource fermée, `src`/`srcObject` retirés, l'élément libre pour l'essai suivant.
 *
 * **Ce que l'hôte fait en plus et que ce banc ne fait pas, exprès** : aucun cache de reprise sur l'appareil
 * (`disk` absent — le lecteur serveur n'en a pas non plus ; l'hôte en sert « Reprendre » et « À suivre »),
 * aucune réserve en mémoire (`MemoryReserve`, qui ne démarre qu'après une minute de lecture), aucune ligne dans
 * player.log ni battement de progression chez Jellyfin (rien n'est une vraie séance), aucun repli vers le lecteur
 * serveur (un refus ou une erreur du moteur est un résultat : `onError`, compté comme une erreur de l'essai).
 */

import { fetchDirectInfo } from "@/lib/directInfo";
import { probePlaybackPath, type RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";

export interface CurrentPlayerOptions {
  itemId: string;
  /** La piste audio, par son numéro dans le fichier ; null : celle que le moteur choisirait. */
  audioTrack: number | null;
  startSeconds: number;
  /** Une erreur du moteur (réseau ou lecture) : l'hôte replierait ; ici, l'essai la compte. */
  onError: (line: string) => void;
  /** Une attente que le moteur juge anormale (`onStall`) : notée au journal de la page. */
  onNote: (line: string) => void;
  /** La page a fermé l'essai pendant l'ouverture : on rend tout sans attacher. */
  cancelled: () => boolean;
}

export interface CurrentPlayer {
  playback: RemuxPlayback;
  /** La piste réellement ouverte (une piste que ce navigateur ne peut pas porter est remplacée par le moteur). */
  openedAudio: number | null;
  /** Ce que le moteur a ouvert (vidéo, piste, son copié ou réencodé), pour la ligne de l'essai. */
  facts: Record<string, string | undefined>;
}

/** La description du fichier, ou la raison pour laquelle l'hôte refuserait de l'ouvrir. */
export async function currentPlayerInfo(itemId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const info = await fetchDirectInfo(itemId);
  return info.refusedReason ? { ok: false, reason: info.refusedReason } : { ok: true };
}

/**
 * Ouvre le titre dans `video` et lance la lecture. Rejette comme `probePlaybackPath` : « Aucun chemin de lecture
 * disponible… » pour un fichier refusé, une erreur réseau sinon. Rend null si l'essai a été fermé entre-temps.
 */
export async function openCurrentPlayer(video: HTMLVideoElement, options: CurrentPlayerOptions): Promise<CurrentPlayer | null> {
  const info = await fetchDirectInfo(options.itemId);
  if (info.refusedReason) throw new Error(`refusé par l'hôte : ${info.refusedReason}`);
  // La source HLS de l'essai précédent est retirée d'abord : WebKit accepte une MediaSource après un HLS natif
  // dans la même page (l'inverse non — d'où l'ordre de la série).
  video.removeAttribute("src");
  video.load();
  const probe = await probePlaybackPath({
    streamUrl: info.streamUrl,
    knownSize: info.sizeBytes,
    fileVersion: info.fileVersion ?? null,
    videoRangeType: info.video?.rangeType ?? null,
    startSeconds: options.startSeconds,
    audioTrackNumber: options.audioTrack,
    audioPreferences: null,
    onError: (message, kind) => options.onError(`moteur ${kind ?? "lecture"} : ${message}`.slice(0, 200)),
    onStall: (facts) => options.onNote(`moteur : attente signalée ${JSON.stringify(facts).slice(0, 160)}`),
  });
  if (options.cancelled()) {
    probe.discard();
    return null;
  }
  const playback = await probe.start(video);
  if (options.cancelled()) {
    playback.destroy();
    return null;
  }
  const held = playback.openingHold();
  if (held) await held;
  if (options.cancelled()) {
    playback.destroy();
    return null;
  }
  // Ce que l'hôte montre dans « Détails » : la vidéo, la piste, et si le son est copié ou réencodé dans la page —
  // ce qui, plus que la découpe, distingue souvent les deux lecteurs sur un même titre.
  const d = playback.diagnostics;
  return { playback, openedAudio: playback.currentAudioTrack, facts: { video: d["Vidéo"], audio: d.Audio, sound: d["Traitement audio"] } };
}
