import { jellyfin } from "@/lib/clients/jellyfin";
import { anyPlaybackBeat } from "@/lib/activity/presence";

/**
 * Quelqu'un regarde-t-il un film en ce moment ? — ce qui met l'indexation des répliques en pause
 * (DECISIONS.md §88). Les films sont sur les mêmes disques que ce qu'on regarde : une lecture de
 * l'indexation qui déplace la tête au mauvais moment, c'est une image qui attend.
 *
 * Trois signaux, et un seul suffit :
 *
 * 1. **Les séances de Jellyfin** (`/Sessions`, un `NowPlayingItem`) — le plus sûr, parce qu'il voit
 *    tout : le lecteur de CineApp (qui rapporte sa lecture à Jellyfin), le lecteur du serveur, le
 *    Chromecast, AirPlay, et les applications Jellyfin d'un téléviseur qui ne passent jamais par
 *    CineApp. Une séance dont le dernier rapport date de plus de cinq minutes est ignorée (un
 *    client tué sans dire « stop » y reste longtemps). Demandé au plus toutes les 20 s.
 * 2. **Le relais de flux** (`/api/jellyfin/stream/…`, `noteMediaRead`) — instantané : des octets du
 *    film partent en ce moment, avant même que Jellyfin ait reçu le premier rapport.
 * 3. **Le battement de lecture** de la page (`recordPlaybackBeat`, présence) — un film en pause dans
 *    un onglet compte : il peut reprendre à tout instant.
 *
 * Jellyfin injoignable n'empêche rien : les deux autres signaux restent. L'indexation reprend
 * `RESUME_AFTER_MS` après le dernier signal — quelques minutes, pour ne pas reprendre entre deux
 * épisodes, ou pendant qu'on choisit le film suivant.
 */

export const RESUME_AFTER_MS = 5 * 60_000;
const SESSION_STALE_MS = 5 * 60_000;
const SESSIONS_EVERY_MS = 20_000;
const STREAM_RECENT_MS = 60_000;

let lastStreamAt = 0;
let lastSeenAt = 0;
let sessionsCheckedAt = 0;
let sessionsPlaying = false;
let sessionsInFlight: Promise<void> | null = null;

/** Le relais de flux sert des octets d'un film. Appelé à chaque requête — une affectation, rien d'autre. */
export function noteMediaRead(now = Date.now()): void {
  lastStreamAt = now;
}

async function refreshSessions(now: number): Promise<void> {
  try {
    const sessions = await jellyfin.getSessions();
    sessionsPlaying = sessions.some((s) => {
      if (!s.NowPlayingItem) return false;
      const checkIn = Date.parse(s.LastPlaybackCheckIn ?? s.LastActivityDate ?? "");
      return !Number.isFinite(checkIn) || now - checkIn < SESSION_STALE_MS;
    });
  } catch {
    // Injoignable : ce signal se tait, les deux autres restent.
    sessionsPlaying = false;
  } finally {
    sessionsCheckedAt = now;
  }
}

export interface PlaybackSignal {
  playing: boolean;
  /** Ce qui l'a dit : `jellyfin`, `stream`, `beat`. */
  by: string | null;
  /** Le dernier signal de lecture connu (ms). */
  lastSeenAt: number;
}

/** L'état présent, en interrogeant Jellyfin s'il n'a pas été interrogé depuis 20 s. */
export async function playbackSignal(now = Date.now()): Promise<PlaybackSignal> {
  if (now - sessionsCheckedAt >= SESSIONS_EVERY_MS) {
    sessionsInFlight ??= refreshSessions(now).finally(() => {
      sessionsInFlight = null;
    });
    await sessionsInFlight;
  }
  let by: string | null = null;
  if (sessionsPlaying) by = "jellyfin";
  else if (now - lastStreamAt < STREAM_RECENT_MS) by = "stream";
  else if (anyPlaybackBeat(now)) by = "beat";
  if (by) lastSeenAt = now;
  return { playing: by !== null, by, lastSeenAt };
}

/** Faut-il attendre ? Oui pendant une lecture, et encore `RESUME_AFTER_MS` après la dernière. */
export async function mustWaitForPlayback(now = Date.now()): Promise<{ wait: boolean; signal: PlaybackSignal }> {
  const signal = await playbackSignal(now);
  return { wait: signal.playing || (lastSeenAt > 0 && now - lastSeenAt < RESUME_AFTER_MS), signal };
}

export const __testing = {
  reset(): void {
    lastStreamAt = 0;
    lastSeenAt = 0;
    sessionsCheckedAt = 0;
    sessionsPlaying = false;
    sessionsInFlight = null;
  },
};
