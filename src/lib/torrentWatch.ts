import { qbittorrent } from "@/lib/clients/qbittorrent";
import { sendPushToAdmins } from "@/lib/push";
import { logError } from "@/lib/logger";

/**
 * Les notifications « téléchargement démarré / terminé », surveillées par le serveur lui-même.
 *
 * Elles naissaient dans la route `/api/sse`, dont la surveillance ne tourne que tant qu'un
 * navigateur y est connecté — c'est-à-dire tant qu'un onglet de la gestion est ouvert. Une
 * notification faite pour prévenir quand on n'est pas devant ne partait donc que quand on y était.
 * Elles vivent ici depuis le 21/09/2026, démarrées avec le serveur (voir `instrumentation.ts`) ;
 * `/api/sse` garde ses messages dans la page, sans plus envoyer de notification.
 *
 * Même règle d'état que là-bas : le premier passage ne fait qu'apprendre ce qui existe, pour
 * qu'un redémarrage n'annonce pas d'un coup tout ce qui télécharge déjà.
 */

const ACTIVE = new Set(["downloading", "stalledDL", "metaDL", "forcedDL", "checkingDL", "allocating"]);
const DONE = new Set(["uploading", "stalledUP", "forcedUP", "pausedUP", "completed"]);
const POLL_MS = 15_000;

export interface TorrentWatchState {
  bootstrapped: boolean;
  /** Ce qu'on a vu télécharger, par empreinte → nom. */
  downloading: Map<string, string>;
}

export function createTorrentWatchState(): TorrentWatchState {
  return { bootstrapped: false, downloading: new Map() };
}

/** Un passage : ce qui vient de démarrer, ce qui vient de finir. Pur, pour être testé. */
export function diffTorrents(
  state: TorrentWatchState,
  torrents: { hash: string; name: string; state: string }[]
): { started: string[]; completed: string[] } {
  const started: string[] = [];
  const completed: string[] = [];
  const present = new Set<string>();
  for (const t of torrents) {
    present.add(t.hash);
    if (ACTIVE.has(t.state)) {
      if (state.bootstrapped && !state.downloading.has(t.hash)) started.push(t.name);
      state.downloading.set(t.hash, t.name);
    } else if (DONE.has(t.state) && state.downloading.has(t.hash)) {
      if (state.bootstrapped) completed.push(t.name);
      state.downloading.delete(t.hash);
    }
  }
  for (const hash of [...state.downloading.keys()]) if (!present.has(hash)) state.downloading.delete(hash);
  state.bootstrapped = true;
  return { started, completed };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startTorrentWatch(): void {
  if (timer) return;
  const state = createTorrentWatchState();
  timer = setInterval(async () => {
    try {
      const { started, completed } = diffTorrents(state, await qbittorrent.getTorrents());
      for (const name of started) {
        await sendPushToAdmins({ title: "Téléchargement démarré", body: name, tag: "torrent-started", url: "/qbittorrent", category: "torrent-started" });
      }
      for (const name of completed) {
        await sendPushToAdmins({ title: "Téléchargement terminé ✓", body: name, tag: "torrent-complete", url: "/qbittorrent", category: "torrent-complete" });
      }
    } catch (err) {
      logError("notifications.torrents", err);
    }
  }, POLL_MS);
}
