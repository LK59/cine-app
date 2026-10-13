import { useCallback, useEffect, useRef, useMemo } from "react";
import { PLAYBACK_CLIENTS, type PlaybackClient } from "@/lib/playbackClients";
import { touchHintHeaders } from "@/lib/deviceLabel";
import { noteMaintenanceState } from "@/lib/useMaintenance";
import { clearUnsentPosition, flushUnsentPositions, saveUnsentPosition, unsentPositionsPending } from "@/lib/unsentPosition";
import { forgetProgressBeat, noteProgressBeat } from "@/lib/progressBeat";

interface PlaybackSessionInfo {
  itemId: string;
  playSessionId: string;
  mediaSourceId: string;
  playMethod?: "DirectPlay" | "DirectStream" | "Transcode";
  /**
   * Which of the two players is running, as Jellyfin's dashboard and history will name it.
   *
   * Defaulted rather than required so a caller that does not care keeps the app's own name.
   */
  client?: PlaybackClient;
  /**
   * Whether this player has to announce the start itself.
   *
   * The stable one does not: negotiating its stream already tells the server. The experimental
   * one negotiates nothing, so without this it reports progress against a session the server was
   * never told about.
   */
  announce?: boolean;
}

const TICKS_PER_SECOND = 10_000_000;
/**
 * Le battement d'une lecture sans événement : toutes les 30 s (13/10/2026 ; 10 s avant).
 *
 * Le relevé du 13/10 comptait ≈ 320 POST de progression par heure de film — le premier poste de
 * requêtes de l'application pendant une lecture, chacune réveillant la radio d'un téléphone entre
 * deux rafales de la réserve. Ce qu'il apporte en continu (la position que Jellyfin gardera si tout
 * s'arrête net) vaut 30 s ; tout ce qui *change* la séance part à l'instant, sans attendre le
 * battement : pause, reprise, saut (vus par `WATCH_MS`), page cachée, arrêt, épisode suivant (une
 * autre séance), retour du réseau, changement de piste (`reportNow`).
 */
export const HEARTBEAT_MS = 30_000;
export const PAUSED_HEARTBEAT_MS = 60_000;
/**
 * Le pas de la surveillance locale — sans réseau : l'état de pause et la position sont relus chaque
 * seconde, et un changement part tout de suite au lieu d'attendre le battement.
 */
export const WATCH_MS = 1_000;
/** Un écart de position au-delà du temps écoulé (vitesse ×2 comprise) plus cette marge : un saut. */
const JUMP_SLACK_SECONDS = 3;

function pageVisible(): boolean {
  try {
    return typeof document === "undefined" || document.visibilityState !== "hidden";
  } catch {
    return true;
  }
}

function report(
  path: "playing" | "progress" | "stop",
  info: PlaybackSessionInfo,
  positionTicks: number,
  isPaused = false
): Promise<void> {
  // keepalive lets the stop-on-unload report survive the page tearing down —
  // a regular fetch would get cancelled mid-flight on navigation/close.
  //
  // La promesse est rendue, et c'est nouveau : l'appelant qui ferme le lecteur doit savoir *quand*
  // Jellyfin a pris l'arrêt en compte, sous peine de relire la position juste avant qu'elle change
  // et de réafficher « Lecture » sur un film qu'on vient de quitter.
  return fetch(`/api/jellyfin/playback/${path}`, {
    method: "POST",
    // L'indice tactile : c'est sous le libellé de l'appareil que Jellyfin range la séance, et sans
    // lui un iPad s'y nomme « Mac » (`deviceLabel.ts`).
    headers: { "Content-Type": "application/json", ...touchHintHeaders() },
    // `visible` : la route enregistre aussi la présence de l'appelant (`recordPlaybackBeat`) — le
    // battement tient lieu de signal de présence pendant un film (13/10/2026).
    body: JSON.stringify({ client: PLAYBACK_CLIENTS.stable, ...info, positionTicks, isPaused, visible: pageVisible() }),
    keepalive: true,
  })
    .then(async (res) => {
      // La position n'est pas passée (serveur qui redémarre, Jellyfin injoignable) : gardée sur
      // l'appareil, renvoyée plus tard (`unsentPosition.ts`, §78). Passée : la copie gardée, plus
      // ancienne, s'efface, et ce qui attendait pour d'autres titres part derrière.
      if (res.status >= 500) {
        saveUnsentPosition(info.itemId, positionTicks / TICKS_PER_SECOND);
      } else if (res.ok && unsentPositionsPending()) {
        clearUnsentPosition(info.itemId);
        void flushUnsentPositions(Date.now(), info.itemId);
      }
      // Le battement rapporte l'état d'exploitation et tient lieu de présence : tant qu'il passe, le
      // sondage de maintenance et le signal de présence se taisent pendant le film (`progressBeat.ts`).
      if (path === "progress" && res.ok) {
        noteProgressBeat();
        noteMaintenanceState(((await res.json().catch(() => null)) as { maintenance?: unknown } | null)?.maintenance);
      }
      if (path === "stop") forgetProgressBeat();
    })
    // Pas de réponse : la coupure. La position reste sur l'appareil jusqu'au retour du réseau.
    .catch(() => saveUnsentPosition(info.itemId, positionTicks / TICKS_PER_SECOND));
}

/**
 * Referme chez Jellyfin une séance que ce lecteur a ouverte sans jamais la garder.
 *
 * Une négociation du lecteur serveur remplacée — ou fermée — pendant qu'on lisait sa réponse : le
 * serveur a déjà ouvert la séance, et souvent lancé le transcodage, mais personne n'en tient
 * l'identifiant, donc aucun battement ni aucun arrêt ne la concernera. Sans cet arrêt, le
 * transcodage tournait jusqu'à ce que Jellyfin abandonne de lui-même.
 */
export function stopOrphanSession(info: Omit<PlaybackSessionInfo, "announce">, positionSeconds: number): Promise<void> {
  return report("stop", info, Math.floor(Math.max(0, positionSeconds) * TICKS_PER_SECOND));
}

// Keeps Jellyfin's "now playing" / resume state in sync with an active
// PlayerHost session: a progress heartbeat every 30s (60s paused; pause, resume and seeks at
// once, see HEARTBEAT_MS), and a stop report
// (with the final position) on close, unmount, or tab close. Returns a
// stopNow() the caller can invoke at the exact moment the user closes the
// player — capturing currentTime right then, rather than whenever React
// gets around to unmounting (which can lag behind a close-transition delay).
//
// Takes a getPositionSeconds() callback rather than reading video.currentTime directly:
// switching audio/subtitle (or retrying after an error) calls video.load(), which resets
// currentTime to 0 immediately, before the new manifest has actually loaded — a heartbeat
// firing in that window (or while a track switch is stuck/failed, per the live PWA report)
// would silently overwrite Jellyfin's resume point with 0. The caller is expected to pass a
// value that only moves forward with real playback progress (e.g. a ref updated on
// 'timeupdate'), never one that resets on an in-flight reload.
export function usePlaybackSession(
  getPositionSeconds: () => number,
  session: PlaybackSessionInfo | null,
  getPaused?: () => boolean
): { stop: () => Promise<void>; resume: () => void; savePaused: () => void; reportNow: () => void } {
  const sessionRef = useRef(session);
  const stoppedRef = useRef(false);
  /** Le battement immédiat de la séance en cours — voir `reportNow`. */
  const sendNowRef = useRef<() => void>(() => {});
  const positionRef = useRef(getPositionSeconds);
  const pausedRef = useRef(getPaused);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    positionRef.current = getPositionSeconds;
    pausedRef.current = getPaused;
  }, [getPositionSeconds, getPaused]);

  useEffect(() => {
    if (!session) return;
    stoppedRef.current = false;

    const ticks = () => Math.floor(positionRef.current() * TICKS_PER_SECOND);
    const paused = () => pausedRef.current?.() ?? false;

    // Announced before anything else, so the first heartbeat lands on a session the server knows.
    if (session.announce) report("playing", session, ticks());

    const reportStop = () => {
      if (stoppedRef.current) return;
      stoppedRef.current = true;
      report("stop", session, ticks());
    };
    // Saves the position without ending anything. Putting an app in the background is not
    // closing a film, and on a phone it is the last moment anything is guaranteed to run.
    const saveNow = () => {
      if (stoppedRef.current || document.visibilityState !== "hidden") return;
      report("progress", session, ticks(), paused());
    };

    // Rien après l'arrêt : le lecteur reste monté le temps de son animation de sortie, et un
    // battement tombé dans cette fenêtre rouvrait chez Jellyfin la séance qu'on venait de clore.
    //
    // En pause, une fois la minute (08/10/2026) : la position ne bouge pas, et 117 battements du
    // journal tombaient plus de dix minutes après la dernière image d'un film arrêté. En lecture,
    // toutes les 30 s (13/10/2026, `HEARTBEAT_MS`). Le passage en pause, la reprise et un saut
    // partent à la seconde (`WATCH_MS`) : ils attendaient le battement suivant — dix secondes au
    // plus jusque-là, trente désormais, ce qui n'aurait plus été acceptable.
    //
    // Annoncée à l'instant (`playing`) : le premier battement attend son tour. Sans annonce (le
    // lecteur serveur, la diffusion) : le premier part dès la première seconde, comme la page
    // l'a toujours dit à Jellyfin et au relais du serveur (`castProgress.ts`) dans les dix secondes.
    let lastSentAt = session.announce ? Date.now() : 0;
    let lastPaused: boolean | null = null;
    let lastPosition: number | null = null;
    let lastPositionAt = 0;
    const send = () => {
      if (stoppedRef.current) return;
      const isPaused = paused();
      lastSentAt = Date.now();
      lastPaused = isPaused;
      report("progress", session, ticks(), isPaused);
    };
    sendNowRef.current = send;
    const interval = setInterval(() => {
      if (stoppedRef.current) return;
      const now = Date.now();
      const isPaused = paused();
      // Un saut se lit dans la position : elle a reculé, ou avancé plus que le temps écoulé ne le
      // permet. Relue chaque seconde, sans rien envoyer tant que rien ne change.
      const position = positionRef.current();
      let jumped = false;
      if (lastPosition !== null) {
        const moved = position - lastPosition;
        const elapsed = Math.max(0, now - lastPositionAt) / 1000;
        jumped = moved < -JUMP_SLACK_SECONDS || moved > elapsed * 2 + JUMP_SLACK_SECONDS;
      }
      lastPosition = position;
      lastPositionAt = now;
      const toggled = lastPaused !== null && isPaused !== lastPaused;
      const due = now - lastSentAt >= (isPaused ? PAUSED_HEARTBEAT_MS : HEARTBEAT_MS);
      if (toggled || jumped || due) send();
    }, WATCH_MS);
    // Le réseau revient : la position part tout de suite, sans attendre jusqu'à trente secondes —
    // et avec elle ce que la coupure avait gardé sur l'appareil (`unsentPosition.ts`, dans `report`).
    const onOnline = () => send();

    /**
     * Une page mise de côté n'est pas une page fermée.
     *
     * `pagehide` sert ici de dernier instant garanti pour rapporter la position, et il déclare la
     * séance terminée. Mais il se déclenche aussi quand le navigateur range la page pour pouvoir
     * la rendre telle quelle — `persisted` le dit — et cette page-là revient, avec son minuteur,
     * son film et sa lecture en cours. Elle revenait alors marquée « arrêtée » : plus aucun
     * battement n'était accepté et, surtout, la position finale n'était plus rapportée du tout.
     * Le titre gardait pour toujours la position qu'il avait au moment où l'on avait quitté.
     *
     * On rouvre donc la séance au retour. Sans nouvelle annonce : c'est la même, on reprend d'où
     * elle en était — et si le serveur l'a réellement oubliée, un rapport ignoré ne coûte pas plus
     * que le silence qu'il remplace.
     */
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) stoppedRef.current = false;
    };

    window.addEventListener("pageshow", onShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", reportStop);
    // iOS never fires beforeunload — closing a tab, swiping the app away or following a link out
    // all end at pagehide instead, so on a phone that was the whole of the final position being
    // lost. Both are listened to; whichever arrives first reports, and the other finds it done.
    window.addEventListener("pagehide", reportStop);
    document.addEventListener("visibilitychange", saveNow);

    return () => {
      clearInterval(interval);
      sendNowRef.current = () => {};
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", reportStop);
      window.removeEventListener("pagehide", reportStop);
      document.removeEventListener("visibilitychange", saveNow);
      reportStop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.itemId, session?.playSessionId, session?.mediaSourceId, session?.announce, session?.client]);

  const stop = useCallback(() => {
    if (stoppedRef.current) return Promise.resolve();
    stoppedRef.current = true;
    const s = sessionRef.current;
    if (!s) return Promise.resolve();
    return report("stop", s, Math.floor(positionRef.current() * TICKS_PER_SECOND));
  }, []);

  /**
   * Rouvrir la séance après un arrêt — « Revoir » à la fin d'un film.
   *
   * La fin d'un film est maintenant annoncée à Jellyfin dès qu'elle arrive (voir le lecteur) : c'est
   * cet arrêt, avec sa position en fin de fichier, qui marque le film « vu ». Revoir le film dans
   * la même séance doit donc la redéclarer, sans quoi les battements se taisaient et la nouvelle
   * position n'était plus jamais enregistrée.
   */
  const resume = useCallback(() => {
    const s = sessionRef.current;
    if (!s || !stoppedRef.current) return;
    stoppedRef.current = false;
    report("playing", s, Math.floor(positionRef.current() * TICKS_PER_SECOND));
  }, []);

  /**
   * La position, tout de suite, film en pause — la minuterie de veille vient de l'arrêter.
   *
   * Le battement suivant l'aurait dite dans une minute (en pause) ; mais quelqu'un qui s'endort laisse le
   * téléphone se verrouiller, et une page mise de côté n'a plus de battement. C'est l'instant où le
   * spectateur s'est endormi qu'il faut retrouver demain, pas celui d'avant.
   */
  const savePaused = useCallback(() => {
    const s = sessionRef.current;
    if (!s || stoppedRef.current) return;
    void report("progress", s, Math.floor(positionRef.current() * TICKS_PER_SECOND), true);
  }, []);

  /**
   * La position, tout de suite — un événement que la surveillance d'une seconde ne voit pas dans la
   * pause ni dans la position : un changement de piste (13/10/2026). Rien hors séance ni après l'arrêt.
   */
  const reportNow = useCallback(() => sendNowRef.current(), []);

  return useMemo(() => ({ stop, resume, savePaused, reportNow }), [stop, resume, savePaused, reportNow]);
}
