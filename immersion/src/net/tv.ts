import { dispatch, setSharedPlayback, type Command } from "../media/commands";
import { playbackClock, setPlaybackRate } from "../media/playback";
import { useStore } from "../state/store";
import type { TvView } from "../../../salons/src/tv";
import { requestRoster, sendTv, serverNow } from "./salons";

/**
 * La télévision commune d'un salon (DECISIONS.md §146, étape 3 de `docs/MULTIJOUEUR.md`), côté chalet.
 *
 * **Les gestes partent au service.** Dans un salon, lancer un titre, reprendre, mettre en pause, sauter et arrêter ne
 * touchent plus au lecteur : `commands.ts` les passe ici, et ils partent au service (`tv.*`). Lancer demande d'abord
 * à l'application le droit de le faire pour ce salon (`/api/salons/titre`, avec la liste des présents signée par le
 * service : chacun doit pouvoir voir le titre). Le son, les pistes et les sous-titres restent à chacun.
 *
 * **Le lecteur suit l'état du salon** (`room.tv`) : chacun lit son propre flux, et ce module l'y amène, par les mêmes
 * commandes marquées `remote`.
 * - *préparation* : ouvrir ou caler le flux à la position, en pause ; dire « prêt » une fois quelques secondes
 *   chargées devant (`READY_AHEAD_S`).
 * - *lecture* : démarrer à l'heure de départ (heure du service, `serverNow`), puis rester sur la position attendue —
 *   un écart de quelques dixièmes se rattrape par la vitesse (± 5 %), un grand par un saut.
 * - *pause* : en pause, à la position du salon.
 * Un arrivant en cours de film ouvre le titre à la position attendue et rejoint la lecture une fois chargé.
 */
const READY_AHEAD_S = 4;
/** Au-delà, on dit « prêt » quand même : le flux se remplira en route. */
const READY_AFTER_MS = 12_000;
const TICK_MS = 250;
/** Écarts tolérés (secondes) : en deçà rien, au-delà de `DRIFT_SEEK_S` un saut, entre les deux la vitesse. */
const DRIFT_OK_S = 0.12;
const DRIFT_SEEK_S = 1.5;

let followed: TvView | null = null;
let readySent = 0;
let preparingSince = 0;
let lastSeekAt = 0;
let startTimer: ReturnType<typeof setTimeout> | null = null;

const room = () => useStore.getState().net.room;
const tv = () => room()?.tv ?? null;

/** La position que le salon attend maintenant. */
function expected(view: TvView): number {
  return view.phase === "playing" ? Math.max(0, view.position + (serverNow() - view.anchor) / 1000) : view.position;
}

function seekTo(to: number): void {
  lastSeekAt = performance.now();
  dispatch({ type: "seek", to }, "remote");
}

async function openShared(item: { id: string; title: string }, from: number | null): Promise<void> {
  const roster = await requestRoster();
  if (!roster) return;
  let ticket: string | null = null;
  try {
    const res = await fetch("/api/salons/titre", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: item.id, roster }),
    });
    const body = res.ok ? ((await res.json()) as { allowed?: boolean; ticket?: string }) : null;
    ticket = body?.allowed && body.ticket ? body.ticket : null;
  } catch {
    ticket = null;
  }
  // Un titre que quelqu'un du salon ne peut pas voir : rien ne se lance, et on le dit sans dire qui.
  if (!ticket) return useStore.getState().setNet({ error: "title-refused" });
  sendTv({ t: "tv.open", ticket, title: item.title, from: from ?? 0 });
}

/** Le relais des gestes (`commands.ts`) : `true` quand le geste part au salon au lieu de s'appliquer ici. */
function shareCommand(command: Command): boolean {
  if (!room() || useStore.getState().net.status !== "online") return false;
  const current = tv();
  switch (command.type) {
    case "open":
      void openShared(command.item, command.from);
      return true;
    case "stop":
      if (!current) return false;
      sendTv({ t: "tv.stop" });
      return true;
    case "play":
      if (!current) return false;
      sendTv({ t: "tv.play" });
      return true;
    case "pause":
      if (!current) return false;
      sendTv({ t: "tv.pause" });
      return true;
    case "toggle":
      if (!current) return false;
      sendTv(current.phase === "paused" ? { t: "tv.play" } : { t: "tv.pause" });
      return true;
    case "seek":
      if (!current) return false;
      sendTv({ t: "tv.seek", to: Math.max(0, command.to) });
      return true;
    case "seekBy": {
      if (!current) return false;
      const duration = useStore.getState().playback.duration;
      const end = duration > 1 ? duration - 1 : Infinity;
      sendTv({ t: "tv.seek", to: Math.max(0, Math.min(end, expected(current) + command.delta)) });
      return true;
    }
    default:
      return false;
  }
}

/** Amène le lecteur à l'état du salon ; appelé à chaque changement et toutes les `TICK_MS`. */
function follow(): void {
  const view = tv();
  const state = useStore.getState();
  const playback = state.playback;

  if (!view) {
    // La télévision du salon s'est éteinte (arrêtée, prise par un jeu, salon quitté) : la nôtre aussi, si elle la suivait.
    if (followed) {
      followed = null;
      if (startTimer) clearTimeout(startTimer);
      startTimer = null;
      setPlaybackRate(1);
      if (playback.status !== "idle") dispatch({ type: "stop" }, "remote");
    }
    return;
  }

  const fresh = !followed || followed.itemId !== view.itemId || followed.epoch !== view.epoch || followed.phase !== view.phase || followed.position !== view.position;
  followed = view;
  if (fresh && view.phase === "preparing") preparingSince = performance.now();

  // Pas encore le bon titre : on l'ouvre, en pause, là où le salon en est.
  if (playback.itemId !== view.itemId || playback.status === "idle" || playback.status === "error") {
    if (playback.status === "loading" && playback.itemId === view.itemId) return;
    // (Un autre titre qui se charge — le précédent du salon — est remplacé.)
    dispatch({ type: "open", item: { id: view.itemId, title: view.title }, from: expected(view) + (view.phase === "playing" ? 2 : 0), paused: true }, "remote");
    return;
  }
  if (playback.status === "loading") return;

  const clock = playbackClock();
  if (clock.ended) return;
  const sinceSeek = performance.now() - lastSeekAt;

  if (view.phase === "preparing" || view.phase === "paused") {
    setPlaybackRate(1);
    if (!playback.wantPaused) dispatch({ type: "pause" }, "remote");
    if (Math.abs(clock.time - view.position) > 0.5 && sinceSeek > 1500) seekTo(view.position);
    if (view.phase === "preparing" && readySent !== view.epoch) {
      const placed = sinceSeek > 300 && Math.abs(clock.time - view.position) <= 0.5;
      const loaded = placed && clock.ready && (clock.ahead >= READY_AHEAD_S || (playback.duration > 0 && clock.time + clock.ahead >= playback.duration - 0.5));
      // Passé le délai, « prêt » quand même : un flux qui ne se cale pas exactement ne retient pas tout le salon.
      if (loaded || performance.now() - preparingSince > READY_AFTER_MS) {
        readySent = view.epoch;
        sendTv({ t: "tv.ready", epoch: view.epoch });
      }
    }
    return;
  }

  // Lecture.
  const wait = view.anchor - serverNow();
  if (wait > 0) {
    // Le départ commun n'est pas encore arrivé : en pause sur la position, et un réveil à l'heure dite.
    if (!playback.wantPaused) dispatch({ type: "pause" }, "remote");
    if (Math.abs(clock.time - view.position) > 0.3 && sinceSeek > 1500) seekTo(view.position);
    if (!startTimer) {
      startTimer = setTimeout(() => {
        startTimer = null;
        dispatch({ type: "play" }, "remote");
      }, wait);
    }
    return;
  }
  const target = expected(view);
  if (playback.duration > 0 && target >= playback.duration - 0.5) return;
  if (playback.wantPaused) dispatch({ type: "play" }, "remote");
  if (sinceSeek < 2500 || !clock.ready) return;
  const drift = clock.time - target;
  if (Math.abs(drift) > DRIFT_SEEK_S) {
    setPlaybackRate(1);
    // Un peu devant : le temps que le saut se fasse.
    seekTo(target + 0.4);
  } else if (Math.abs(drift) > DRIFT_OK_S) setPlaybackRate(1 - Math.max(-0.05, Math.min(0.05, drift * 0.25)));
  else setPlaybackRate(1);
}

let installed = false;

/** Branche la télévision commune (une fois, au démarrage du chalet). */
export function installSharedTv(): void {
  if (installed) return;
  installed = true;
  setSharedPlayback(shareCommand);
  let last: TvView | null | undefined;
  useStore.subscribe((state) => {
    const next = state.net.room?.tv ?? null;
    if (next === last) return;
    last = next;
    if (startTimer && (!next || next.phase !== "playing")) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    follow();
  });
  setInterval(() => {
    if (followed || tv()) follow();
  }, TICK_MS);
}

/** Pour les scénarios : où en est le suivi. */
export function sharedTvDebug(): { followed: TvView | null; readySent: number } {
  return { followed, readySent };
}
