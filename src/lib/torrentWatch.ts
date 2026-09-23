import { qbittorrent } from "@/lib/clients/qbittorrent";
import { sendPushToAdmins } from "@/lib/push";
import { logError } from "@/lib/logger";
import { kvCacheDb } from "@/lib/db";

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
// qBittorrent 5 a renommé « paused » en « stopped » : un téléchargement terminé qui passe
// directement à `stoppedUP` n'était jamais annoncé (23/09/2026, v5.2.3). `queuedUP` et
// `checkingUP` sont aussi des états d'après le téléchargement.
const DONE = new Set(["uploading", "stalledUP", "forcedUP", "pausedUP", "stoppedUP", "queuedUP", "checkingUP", "completed"]);
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

/**
 * Le titre qu'un nom de torrent désigne : ce qui précède l'épisode ou la saison, sinon l'année.
 *
 * Sert à regrouper, pas à afficher un titre exact : « THE CREEP TAPES S02E04 AVA 1080p… » et
 * « The.Creep.Tapes.S01E05.1080p… » doivent tomber dans le même paquet.
 */
export function torrentTitle(name: string): string {
  const cleaned = name.replace(/\[[^\]]*\]/g, " ").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  const match =
    cleaned.match(/^(.+?)[\s-]+S\d{1,2}(?:E\d{1,3})?\b/i) ?? cleaned.match(/^(.+?)\s+\(?(?:19|20)\d{2}\b/);
  let title = (match?.[1] ?? cleaned).replace(/[\s-]+$/, "").trim() || cleaned;
  // Un nom tout en capitales se lit mieux en casse de titre ; les autres restent tels qu'écrits.
  if (/\p{Lu}/u.test(title) && title === title.toUpperCase()) {
    title = title.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
  }
  return title;
}

/**
 * Ce qu'une notification dit d'un lot de torrents.
 *
 * Un seul : son nom, tel quel, comme avant. Plusieurs : leur nombre, et leurs titres regroupés —
 * « The Creep Tapes (14) » plutôt que quatorze notifications. Le 23/09/2026, une série demandée
 * en entier est arrivée épisode par épisode : quatorze torrents, vingt-huit notifications.
 */
export function summarizeTorrents(names: string[], kind: "started" | "completed"): { title: string; body: string } {
  if (names.length === 1) {
    return { title: kind === "started" ? "Téléchargement démarré" : "Téléchargement terminé ✓", body: names[0] };
  }
  const groups = new Map<string, { title: string; count: number }>();
  for (const name of names) {
    const title = torrentTitle(name);
    const key = title.toLowerCase();
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { title, count: 1 });
  }
  const body = [...groups.values()].map((g) => (g.count > 1 ? `${g.title} (${g.count})` : g.title)).join(" · ");
  const title =
    kind === "started" ? `${names.length} téléchargements démarrés` : `${names.length} téléchargements terminés ✓`;
  return { title, body };
}

/**
 * Le lot en attente : tout ce qui arrive rapproché part ensemble.
 *
 * Il part après deux minutes sans rien de neuf — une série qui arrive épisode par épisode tient
 * dans un lot — et au plus tard dix minutes après son premier élément, pour qu'un flot continu ne
 * retienne pas tout indéfiniment.
 */
export const DIGEST_QUIET_MS = 2 * 60_000;
export const DIGEST_MAX_WAIT_MS = 10 * 60_000;

export interface TorrentDigest {
  first: number;
  last: number;
  started: string[];
  completed: string[];
}

export function createTorrentDigest(): TorrentDigest {
  return { first: 0, last: 0, started: [], completed: [] };
}

export function addToDigest(digest: TorrentDigest, found: { started: string[]; completed: string[] }, now: number): void {
  if (found.started.length === 0 && found.completed.length === 0) return;
  if (digest.started.length === 0 && digest.completed.length === 0) digest.first = now;
  digest.last = now;
  digest.started.push(...found.started);
  digest.completed.push(...found.completed);
}

/** Ce qui doit partir maintenant, s'il y a lieu — et le lot est vidé. */
export function takeDueDigest(digest: TorrentDigest, now: number): { started: string[]; completed: string[] } | null {
  if (digest.started.length === 0 && digest.completed.length === 0) return null;
  if (now - digest.last < DIGEST_QUIET_MS && now - digest.first < DIGEST_MAX_WAIT_MS) return null;
  const due = { started: digest.started, completed: digest.completed };
  digest.started = [];
  digest.completed = [];
  return due;
}

/**
 * Ce que la surveillance savait, gardé sur disque d'un démarrage à l'autre.
 *
 * Le conteneur est recréé à chaque déploiement, plusieurs fois par jour. Tout vivait en mémoire :
 * le lot en attente (jusqu'à dix minutes d'annonces) disparaissait, et le premier passage
 * suivant, qui ne fait qu'apprendre ce qui existe, taisait les téléchargements finis pendant le
 * redémarrage (23/09/2026). Relu s'il date de moins d'une heure : au-delà, l'état de qBittorrent
 * a pu changer du tout au tout, et mieux vaut réapprendre en silence qu'annoncer n'importe quoi.
 */
const PERSIST_KEY = "torrent-watch:state";
const PERSIST_MAX_AGE_MS = 3600_000;

interface PersistedWatch {
  downloading: [string, string][];
  digest: TorrentDigest;
}

export function restoreTorrentWatch(state: TorrentWatchState, digest: TorrentDigest, now = Date.now()): void {
  const saved = kvCacheDb.get(PERSIST_KEY);
  if (!saved || now - saved.fetchedAt > PERSIST_MAX_AGE_MS) return;
  const value = saved.value as PersistedWatch;
  state.downloading = new Map(value.downloading ?? []);
  // Déjà appris : ce qui a fini pendant le redémarrage sera annoncé au premier passage.
  state.bootstrapped = true;
  Object.assign(digest, value.digest ?? createTorrentDigest());
}

let lastPersisted = "";

/** Écrit seulement quand quelque chose a changé : le passage a lieu toutes les quinze secondes. */
function persistTorrentWatch(state: TorrentWatchState, digest: TorrentDigest): void {
  const value: PersistedWatch = { downloading: [...state.downloading], digest };
  const json = JSON.stringify(value);
  if (json === lastPersisted) return;
  kvCacheDb.set(PERSIST_KEY, value, Date.now());
  lastPersisted = json;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startTorrentWatch(): void {
  if (timer) return;
  const state = createTorrentWatchState();
  const digest = createTorrentDigest();
  try {
    restoreTorrentWatch(state, digest);
  } catch (err) {
    logError("notifications.torrents", err);
  }
  timer = setInterval(async () => {
    try {
      addToDigest(digest, diffTorrents(state, await qbittorrent.getTorrents()), Date.now());
    } catch (err) {
      logError("notifications.torrents", err);
    }
    // Hors du bloc précédent : un qBittorrent qui ne répond pas ne doit pas retenir un lot prêt.
    const due = takeDueDigest(digest, Date.now());
    try {
      persistTorrentWatch(state, digest);
    } catch (err) {
      logError("notifications.torrents", err);
    }
    if (!due) return;
    try {
      if (due.started.length > 0) {
        await sendPushToAdmins({ ...summarizeTorrents(due.started, "started"), tag: "torrent-started", url: "/qbittorrent", category: "torrent-started" });
      }
      if (due.completed.length > 0) {
        await sendPushToAdmins({ ...summarizeTorrents(due.completed, "completed"), tag: "torrent-complete", url: "/qbittorrent", category: "torrent-complete" });
      }
    } catch (err) {
      logError("notifications.torrents", err);
    }
  }, POLL_MS);
}
