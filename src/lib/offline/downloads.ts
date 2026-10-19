"use client";

import { useSyncExternalStore } from "react";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { deviceStore, deviceStoreSupported, resetDeviceStore } from "./deviceStore";
import { reportClientError } from "@/lib/reportClientError";
import { applyResumeRules } from "./resumeRules";
import { storeOfflineSubtitles, type OfflineSubtitle } from "./subtitles";
import { storeOfflineTrickplay, type OfflineTrickplay } from "./trickplay";
import { BACKDROP_FILE, LOGO_FILE, forgetOfflineImages, offlineImage, storeOfflineArtwork, type OfflineArtwork } from "./artwork";
import type { OfflineJob } from "./jobs";
import type { OfflineCodec, OfflineQuality } from "./quality";

/**
 * Les téléchargements hors ligne de l'appareil (bêta, 19/10/2026) — l'état que l'interface lit, et la
 * boucle qui les fait avancer.
 *
 * La préparation vit sur le serveur (`offline/jobs.ts`) ; ici, on suit ce qu'elle a écrit et on le
 * télécharge par plages de 8 Mo, écrites dans l'OPFS (`deviceStore.ts`). Le téléchargement commence
 * pendant la préparation, et reprend où il en était à la réouverture : ce qui est sur l'appareil se
 * mesure à la taille du fichier, jamais à une valeur notée à côté. Une préparation reprise de zéro
 * côté serveur (`generation`) fait repartir le fichier de zéro ici.
 *
 * Un seul onglet télécharge pour un compte (`navigator.locks`) : deux boucles écrivant le même fichier
 * le corrompraient. L'écran reste allumé pendant un téléchargement quand la page est visible — sur
 * iPhone, rien ne télécharge application fermée.
 */

/** `paused` : arrêté vers l'appareil par la personne ; la préparation du serveur, elle, continue. */
export type OfflineState = "preparing" | "downloading" | "paused" | "done" | "failed";

/** Ce qu'un épisode porte en plus d'un film : sa série et sa place, pour la page et l'épisode suivant. */
export interface OfflineEpisodeFacts {
  /** Pour rouvrir la fiche de la série (`cinemaNavigate({ serie })`). */
  sonarrId: number | null;
  seriesTitle: string;
  seasonNumber: number;
  episodeNumber: number | null;
  /** Le titre de l'épisode seul ; `title` porte « Série — S01E02 · Titre » pour le lecteur. */
  episodeTitle: string;
  /**
   * Le téléchargement automatique (carte blanche de Louis, 19/10/2026) : à mi-épisode lu depuis
   * l'appareil, le suivant se télécharge avec la même langue et la même qualité ; un épisode vu
   * jusqu'au bout s'efface une fois le suivant arrivé.
   */
  autoNext: boolean;
  /**
   * La série chez Jellyfin : pour relire sa liste d'épisodes au moment de télécharger le suivant
   * (absent des épisodes demandés avant le 19/10/2026 au soir — le suivant ne se télécharge alors pas).
   */
  seriesItemId?: string;
  /**
   * La langue demandée (`trackLanguage`), reprise pour l'épisode suivant : les pistes diffèrent d'un
   * épisode à l'autre, la langue non. `null` : la piste par défaut de chaque épisode.
   */
  audioLanguage?: string | null;
  /**
   * L'épisode qui suit, tel que la liste le disait à la demande (`nextEpisodeIn`) — ce que
   * « Épisode suivant » du lecteur hors ligne lance, depuis l'appareil s'il y est, sans réseau.
   */
  next?: { itemId: string; title: string } | null;
}

export interface OfflineDownload {
  /** L'identifiant de la préparation serveur — aussi le nom du dossier sur l'appareil. */
  id: string;
  itemId: string;
  /** Absent : un film. */
  episode?: OfflineEpisodeFacts;
  /** Interne à `patch` : un changement d'état voulu par la personne (la reprise d'une pause). Jamais gardé. */
  fromUser?: boolean;
  /** Vu jusqu'au bout avec le téléchargement automatique : effacé quand le suivant est arrivé. */
  watchedToEnd?: boolean;
  /** Pour rouvrir la fiche depuis le gestionnaire (`cinemaNavigate({ film })`). */
  radarrId: number | null;
  title: string;
  year: number | null;
  runtimeSeconds: number;
  quality: OfflineQuality;
  codec: OfflineCodec;
  audioIndex: number;
  audioLabel: string;
  /**
   * Toutes les pistes son du film, nommées au moment du téléchargement : le lecteur les montre, et
   * en choisir une autre que celle gardée propose la lecture en ligne (ou dit qu'on est hors ligne).
   */
  audioTracks: { index: number; label: string }[];
  generation: number;
  expectedBytes: number;
  /** Ce que le serveur a écrit (pendant la préparation), puis la taille finale. */
  serverBytes: number;
  serverDone: boolean;
  /** Où en est la préparation : en file (d'autres passent avant), en cours, prête. */
  serverStatus?: OfflineJob["status"];
  /** Ce qui est sur l'appareil. */
  bytes: number;
  state: OfflineState;
  error: string | null;
  createdAt: number;
  /** Où la lecture du fichier téléchargé s'est arrêtée (règle de reprise de Jellyfin appliquée). */
  positionSeconds: number;
  /** Quand cette position a été notée. */
  positionAt?: number;
  hasPoster: boolean;
  /** Les sous-titres texte gardés avec le film (`subtitles.ts`). */
  subtitles?: OfflineSubtitle[];
  /**
   * Les aperçus de la barre gardés avec le film (`trickplay.ts`). Absent : pas encore cherchés (un
   * téléchargement d'avant le 19/10/2026 au soir, rattrapé au chargement) ; `null` : le titre n'en a pas.
   */
  trickplay?: OfflineTrickplay | null;
  /**
   * La fiche gardée avec le film (`artwork.ts`) : résumé, année, genres, logo, grand visuel. Absente :
   * pas encore cherchée (rattrapée au chargement) ; `null` : le titre n'est plus connu du serveur.
   */
  artwork?: OfflineArtwork | null;
}

const CHUNK = 8 * 1024 * 1024;
const POLL_MS = 2000;

let account: string | null = null;
let downloads: OfflineDownload[] = [];
const listeners = new Set<() => void>();
let wakeLock: { release(): Promise<void> } | null = null;
/** Les suppressions en cours, par identifiant : une nouvelle demande les attend. */
const removals = new Map<string, Promise<void>>();

function emit(): void {
  downloads = [...downloads];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function patch(id: string, change: Partial<OfflineDownload>): OfflineDownload | null {
  const index = downloads.findIndex((d) => d.id === id);
  if (index < 0) return null;
  // Une pause décidée pendant un pas de la boucle n'est pas défaite par ce pas : seule la reprise
  // (ou une fin, un échec) change l'état d'un téléchargement en pause.
  if (downloads[index].state === "paused" && change.state && change.state !== "paused" && !change.fromUser) {
    if (change.state !== "done" && change.state !== "failed") change = { ...change, state: "paused" };
  }
  delete change.fromUser;
  downloads[index] = { ...downloads[index], ...change };
  emit();
  return downloads[index];
}

async function saveMeta(d: OfflineDownload): Promise<void> {
  if (!account) return;
  await deviceStore.writeMeta(account, d.id, d).catch(() => {});
}

/** Charge les téléchargements du compte de cette page et relance la boucle. Sans effet sans compte. */
export async function initOfflineDownloads(): Promise<void> {
  const current = persistedCacheAccount();
  if (!current || !deviceStoreSupported()) return;
  if (current === account && downloads.length) {
    void runLoop();
    return;
  }
  account = current;
  const ids = await deviceStore.list(current).catch(() => [] as string[]);
  const loaded: OfflineDownload[] = [];
  for (const id of ids) {
    const meta = await deviceStore.readMeta<OfflineDownload>(current, id).catch(() => null);
    if (!meta) continue;
    const size = await deviceStore.videoSize(current, id).catch(() => 0);
    // Un « Échec » dû à une demande retirée par erreur (le défaut du 19/10/2026) repart une fois :
    // la boucle redemande la version, qui est souvent déjà prête sur le serveur.
    const healed = meta.state === "failed" && meta.error === "La préparation n'existe plus sur le serveur" ? { state: "preparing" as const, error: null } : {};
    loaded.push({ ...meta, ...healed, bytes: size });
  }
  if (account !== current) return;
  downloads = loaded.sort((a, b) => b.createdAt - a.createdAt);
  emit();
  void runLoop();
  // Les téléchargements faits avant que les aperçus de la barre partent avec le film : rattrapés
  // une fois, avec du réseau (sans, rien n'est noté, et on réessaiera au prochain chargement).
  if (typeof navigator !== "undefined" && navigator.onLine !== false) {
    for (const d of loaded) if (d.trickplay === undefined && d.state !== "failed") void keepTrickplay(current, d.id, d.itemId);
    for (const d of loaded) if (d.artwork === undefined && d.state !== "failed") void keepArtwork(current, d.id, d.itemId);
  }
  // Le logo et le visuel lus d'avance : l'ouverture de la lecture fige ce qu'elle montre à son montage.
  for (const d of loaded) if (d.artwork) warmArtwork(current, d);
}

async function keepArtwork(owner: string, id: string, itemId: string): Promise<void> {
  const artwork = await storeOfflineArtwork(owner, id, itemId);
  if (artwork === undefined || account !== owner) return;
  const updated = patch(id, { artwork });
  if (updated) {
    warmArtwork(owner, updated);
    await saveMeta(updated);
  }
}

function warmArtwork(owner: string, d: OfflineDownload): void {
  if (d.artwork?.hasLogo) void offlineImage(owner, d.id, LOGO_FILE);
  if (d.artwork?.hasBackdrop) void offlineImage(owner, d.id, BACKDROP_FILE);
}

async function keepTrickplay(owner: string, id: string, itemId: string): Promise<void> {
  const trickplay = await storeOfflineTrickplay(owner, id, itemId);
  if (trickplay === undefined || account !== owner) return;
  const updated = patch(id, { trickplay });
  if (updated) await saveMeta(updated);
}

export function useOfflineDownloads(): OfflineDownload[] {
  return useSyncExternalStore(subscribe, () => downloads, () => EMPTY);
}
const EMPTY: OfflineDownload[] = [];

/** Le téléchargement d'un titre sur cet appareil, s'il y en a un. */
export function useOfflineDownloadFor(itemId: string | null | undefined): OfflineDownload | null {
  const list = useOfflineDownloads();
  return itemId ? (list.find((d) => d.itemId === itemId) ?? null) : null;
}

export function offlineDownloadById(id: string): OfflineDownload | null {
  return downloads.find((d) => d.id === id) ?? null;
}

export function offlineAccount(): string | null {
  return account;
}

/** Ce que la page sait du titre au moment de demander. */
export interface OfflineRequest {
  itemId: string;
  episode?: OfflineEpisodeFacts;
  radarrId: number | null;
  title: string;
  year: number | null;
  runtimeSeconds: number;
  audioIndex: number;
  audioLabel: string;
  audioTracks: { index: number; label: string }[];
  quality: OfflineQuality;
  codec: OfflineCodec;
}

/** Demande la préparation, crée le téléchargement sur l'appareil, et le lance. */
export async function startOfflineDownload(request: OfflineRequest): Promise<void> {
  if (!account) await initOfflineDownloads();
  const owner = account;
  if (!owner) throw new Error("Compte inconnu");
  await Promise.all([...removals.values()]);
  const res = await fetch("/api/offline/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemId: request.itemId, audioIndex: request.audioIndex, quality: request.quality, codec: request.codec }),
  });
  const body = (await res.json().catch(() => null)) as { job?: OfflineJob; error?: string } | null;
  if (!res.ok || !body?.job) throw new Error(body?.error ?? `Erreur ${res.status}`);
  const job = body.job;
  // Un téléchargement déjà sur l'appareil pour ce titre est remplacé : un seul par titre.
  for (const old of downloads.filter((d) => d.itemId === request.itemId && d.id !== job.id)) await removeOfflineDownload(old.id);
  // Garder le stockage à l'abri du ménage du navigateur, dès le premier téléchargement.
  void navigator.storage?.persist?.().catch(() => false);
  const existing = downloads.find((d) => d.id === job.id);
  const download: OfflineDownload = existing ?? {
    id: job.id,
    itemId: request.itemId,
    ...(request.episode ? { episode: request.episode } : {}),
    radarrId: request.radarrId,
    title: request.title,
    year: request.year,
    runtimeSeconds: job.runtimeSeconds || request.runtimeSeconds,
    quality: request.quality,
    codec: request.codec,
    audioIndex: request.audioIndex,
    audioLabel: request.audioLabel,
    audioTracks: request.audioTracks,
    generation: job.generation,
    expectedBytes: job.expectedBytes,
    serverBytes: job.bytes,
    serverDone: job.status === "done",
    bytes: 0,
    state: job.status === "done" ? "downloading" : "preparing",
    error: null,
    createdAt: Date.now(),
    positionSeconds: 0,
    hasPoster: false,
  };
  if (!existing) {
    downloads = [download, ...downloads];
    emit();
  }
  await saveMeta(download);
  // Les sous-titres texte, rangés à côté du film (Louis, 19/10/2026).
  void storeOfflineSubtitles(owner, job.id, request.itemId).then(async (subtitles) => {
    const updated = patch(job.id, { subtitles });
    if (updated) await saveMeta(updated);
  });
  // Les aperçus de la barre, pour chercher un passage sans réseau.
  void keepTrickplay(owner, job.id, request.itemId);
  // La fiche (résumé, logo, visuel), pour la page des téléchargements et l'ouverture sans réseau.
  void keepArtwork(owner, job.id, request.itemId);
  // L'affiche par la route d'images de l'application : celle du catalogue est souvent chez TMDB, d'où
  // `fetch` ne peut rien lire sans CORS (relevé au premier essai réel, 19/10/2026 — aucune affiche gardée).
  {
    void fetch(`/api/jellyfin/image?itemId=${encodeURIComponent(request.itemId)}&kind=poster`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then(async (buffer) => {
        if (!buffer || !account) return;
        await deviceStore.writePoster(owner, job.id, new Uint8Array(buffer));
        const updated = patch(job.id, { hasPoster: true });
        if (updated) await saveMeta(updated);
      })
      .catch(() => {});
  }
  void runLoop();
}

/** Annuler ou supprimer : le fichier quitte l'appareil, et le serveur sait que ce compte n'en veut plus. */
export function removeOfflineDownload(id: string): Promise<void> {
  const owner = account;
  downloads = downloads.filter((d) => d.id !== id);
  emit();
  claimed.get(id)?.abort();
  // Le retrait de la demande d'abord, et retenu : un nouveau téléchargement du même titre l'attend
  // (`startOfflineDownload`). Envoyé après le ménage de l'appareil, il arrivait après la nouvelle
  // demande — même version, même identifiant — et l'effaçait : « Préparation » sans fin, puis
  // « Échec » (Louis, 19/10/2026).
  const removal = (async () => {
    await fetch(`/api/offline/jobs/${id}`, { method: "DELETE" }).catch(() => {});
    if (owner) {
      forgetOfflineImages(owner, id);
      await deviceStore.remove(owner, id).catch(() => {});
    }
  })();
  removals.set(id, removal);
  void removal.finally(() => {
    if (removals.get(id) === removal) removals.delete(id);
    void runLoop();
  });
  return removal;
}

/**
 * Où la lecture du fichier téléchargé s'est arrêtée, selon la règle de reprise de Jellyfin
 * (`resumeRules.ts`) : la même position que Jellyfin retiendra, à la seconde. Jellyfin, lui, la reçoit
 * du lecteur hors ligne comme d'un lecteur en ligne (`usePlaybackSession`) — et sans réseau, par le
 * chemin des positions perdues, dès qu'il revient.
 */
export function saveOfflinePosition(id: string, seconds: number): void {
  const d = offlineDownloadById(id);
  if (!d) return;
  const kept = applyResumeRules(seconds, d.runtimeSeconds);
  const updated = patch(id, { positionSeconds: kept.seconds, positionAt: Date.now(), ...(kept.watched ? { watchedToEnd: true } : {}) });
  if (updated) void saveMeta(updated);
}

async function holdWakeLock(on: boolean): Promise<void> {
  try {
    if (on && !wakeLock && document.visibilityState === "visible") {
      const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
      wakeLock = (await nav.wakeLock?.request("screen")) ?? null;
    } else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    wakeLock = null;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Plusieurs téléchargements à la fois (Louis, 19/10/2026 : un seul à la fois laissait les autres sur
 * « Préparation » alors que leur version était parfois déjà prête) : jusqu'à `PARALLEL` fils, chacun
 * prenant le téléchargement le plus avancé côté serveur — prêt d'abord, puis le plus ancien. Un
 * téléchargement n'est tenu que par un fil de cette page, et par une seule page (`navigator.locks`,
 * un verrou par téléchargement : deux onglets écrivant le même fichier le corrompraient).
 */
const PARALLEL = 3;
const claimed = new Map<string, AbortController>();
let workers = 0;

function waiting(): OfflineDownload[] {
  return downloads
    .filter((d) => (d.state === "preparing" || d.state === "downloading") && !claimed.has(d.id))
    .sort((a, b) => Number(b.serverDone) - Number(a.serverDone) || a.createdAt - b.createdAt);
}

function runLoop(): Promise<void> {
  const owner = account;
  if (!owner) return Promise.resolve();
  while (workers < PARALLEL && waiting().length > 0 && workers < downloads.filter((d) => d.state === "preparing" || d.state === "downloading").length) {
    workers += 1;
    void holdWakeLock(true);
    void worker(owner).finally(() => {
      workers -= 1;
      if (workers === 0) void holdWakeLock(false);
    });
  }
  return Promise.resolve();
}

async function worker(owner: string): Promise<void> {
  let failures = 0;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  for (;;) {
    if (account !== owner) return;
    const next = waiting()[0];
    if (!next) return;
    const control = new AbortController();
    claimed.set(next.id, control);
    try {
      const once = async () => {
        await step(owner, next, control.signal);
        failures = 0;
      };
      // Le verrou de ce téléchargement, s'il est libre : tenu par un autre onglet, on passe.
      const ran = locks
        ? await locks.request(`cine-offline-${owner}-${next.id}`, { ifAvailable: true }, async (lock) => {
            if (!lock) return false;
            await once();
            return true;
          })
        : (await once(), true);
      if (!ran) await sleep(5000, control.signal);
    } catch (error) {
      // Réseau coupé, serveur qui redémarre : on réessaie un peu plus tard, sans rien perdre.
      // Au journal, une fois par erreur (le rapporteur dédoublonne) : ce qu'un iPhone a dit.
      if (!control.signal.aborted) reportClientError(error, "component:hors-ligne", { download: next.id, bytes: String(next.bytes) });
      // Un `fetch` sans réseau rejette d'un `TypeError` : rien à voir avec un fichier verrouillé.
      // Compté, il relançait le stockage toutes les cinq secondes tant qu'un téléchargement
      // attendait le réseau — et la relance fait échouer les lectures en vol du lecteur hors
      // ligne, celui qu'on utilise justement sans réseau (§109, entrée hors ligne).
      if (!(error instanceof TypeError)) failures += 1;
      // Deux échecs de suite : le stockage de l'appareil repart d'un worker neuf.
      if (failures >= 2) resetDeviceStore();
      await sleep(5000, control.signal);
    } finally {
      if (claimed.get(next.id) === control) claimed.delete(next.id);
    }
  }
}

/** Un pas : relire l'état de la préparation, puis télécharger au plus une plage. */
/**
 * Mettre en pause (Louis, 19/10/2026 : garder sa 4G, laisser passer un autre téléchargement) : plus
 * rien n'arrive sur l'appareil ; la préparation du serveur continue — elle ne coûte rien à l'appareil,
 * et à la reprise le téléchargement repart à pleine vitesse. Ce qui est déjà là reste lisible.
 */
export async function pauseOfflineDownload(id: string): Promise<void> {
  const d = offlineDownloadById(id);
  if (!d || (d.state !== "preparing" && d.state !== "downloading")) return;
  claimed.get(id)?.abort();
  const updated = patch(id, { state: "paused" });
  if (updated) await saveMeta(updated);
}

export async function resumeOfflineDownload(id: string): Promise<void> {
  const d = offlineDownloadById(id);
  if (!d || d.state !== "paused") return;
  const updated = patch(id, { state: d.bytes > 0 || d.serverDone ? "downloading" : "preparing", fromUser: true });
  if (updated) await saveMeta(updated);
  void runLoop();
}

async function step(owner: string, d: OfflineDownload, signal: AbortSignal): Promise<void> {
  const res = await fetch(`/api/offline/jobs/${d.id}`, { signal, cache: "no-store" });
  if (res.status === 404) {
    // La demande n'est plus connue du serveur (retirée par erreur, ou expirée) : on la refait, aux
    // mêmes choix. La même version revient sous le même identifiant ; sinon, c'est un échec.
    const again = await fetch("/api/offline/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: d.itemId, audioIndex: d.audioIndex, quality: d.quality, codec: d.codec }),
      signal,
    });
    const body = (await again.json().catch(() => null)) as { job?: OfflineJob; error?: string } | null;
    if (again.ok && body?.job?.id === d.id) return;
    const failed = patch(d.id, { state: "failed", error: body?.error ?? "La préparation n'existe plus sur le serveur" });
    if (failed) await saveMeta(failed);
    return;
  }
  if (!res.ok) throw new Error(`état ${res.status}`);
  const { job } = (await res.json()) as { job: OfflineJob };
  if (job.status === "failed") {
    const failed = patch(d.id, { state: "failed", error: job.error ?? "La préparation a échoué" });
    if (failed) await saveMeta(failed);
    return;
  }
  let bytes = d.bytes;
  if (job.generation !== d.generation) {
    // Repartie de zéro côté serveur : nos octets viennent d'une autre préparation.
    await deviceStore.truncateVideo(owner, d.id, 0);
    bytes = 0;
  }
  let current = patch(d.id, {
    generation: job.generation,
    serverBytes: job.bytes,
    serverDone: job.status === "done",
    serverStatus: job.status,
    expectedBytes: job.status === "done" ? job.bytes : Math.max(job.expectedBytes, job.bytes),
    bytes,
    state: job.status === "done" || job.bytes > 0 ? "downloading" : "preparing",
  });
  if (!current) return;
  if (job.status === "done" && bytes >= job.bytes) {
    current = patch(d.id, { state: "done" });
    if (current) await saveMeta(current);
    if (current?.episode) await sweepWatchedBefore(current);
    return;
  }
  if (bytes >= job.bytes) {
    await saveMeta(current);
    await sleep(POLL_MS, signal);
    return;
  }
  const end = Math.min(bytes + CHUNK, job.bytes) - 1;
  const file = await fetch(`/api/offline/jobs/${d.id}/file`, { headers: { Range: `bytes=${bytes}-${end}` }, signal, cache: "no-store" });
  if (file.status === 416) {
    await sleep(POLL_MS, signal);
    return;
  }
  if (file.status !== 206) throw new Error(`fichier ${file.status}`);
  if (Number(file.headers.get("X-Offline-Generation")) !== job.generation) return;
  const chunk = new Uint8Array(await file.arrayBuffer());
  // Supprimé puis redemandé pendant ce pas (même identifiant, la version du serveur est reprise) :
  // ces octets étaient pour l'ancien fichier, à une position qui n'est plus la bonne.
  if (signal.aborted || offlineDownloadById(d.id)?.createdAt !== d.createdAt) return;
  await deviceStore.writeVideo(owner, d.id, bytes, chunk);
  current = patch(d.id, { bytes: bytes + chunk.byteLength });
  if (current) await saveMeta(current);
}

/** L'ordre d'un épisode dans sa série : saison, puis numéro. */
const episodeRank = (e: OfflineEpisodeFacts) => e.seasonNumber * 10_000 + (e.episodeNumber ?? 0);

/**
 * Deux épisodes de la même chaîne : les spéciaux (saison 0) s'enchaînent entre eux, les saisons
 * entre elles — la règle de `nextEpisodeIn`. Sans elle, un spécial vu s'effaçait dès qu'un épisode
 * ordinaire arrivait, alors que ce n'est pas sa suite.
 */
const sameChain = (a: OfflineEpisodeFacts, b: OfflineEpisodeFacts) =>
  a.sonarrId === b.sonarrId && a.seriesTitle === b.seriesTitle && (a.seasonNumber === 0) === (b.seasonNumber === 0);

/**
 * Le téléchargement automatique, côté ménage : un épisode vu jusqu'au bout s'efface dès qu'un
 * épisode plus loin de la même série est arrivé sur l'appareil — on garde toujours de quoi
 * continuer, jamais ce qu'on a fini.
 */
async function sweepWatchedBefore(arrived: OfflineDownload): Promise<void> {
  const series = arrived.episode!;
  for (const d of downloads) {
    if (!d.episode || !d.watchedToEnd || !d.episode.autoNext || d.id === arrived.id) continue;
    if (!sameChain(d.episode, series)) continue;
    if (episodeRank(d.episode) < episodeRank(series)) await removeOfflineDownload(d.id);
  }
}

/** Vu jusqu'au bout depuis l'appareil : noté, et effacé tout de suite si la suite est déjà là. */
export async function markOfflineWatched(id: string): Promise<void> {
  const d = patch(id, { watchedToEnd: true, positionSeconds: 0 });
  if (!d) return;
  await saveMeta(d);
  if (!d.episode?.autoNext) return;
  const later = downloads.find(
    (x) => x.episode && x.state === "done" && sameChain(x.episode, d.episode!) && episodeRank(x.episode) > episodeRank(d.episode!)
  );
  if (later) await removeOfflineDownload(d.id);
}

/** Les téléchargements d'une série sur l'appareil, dans l'ordre de ses épisodes. */
export function offlineEpisodesOf(sonarrId: number | null, seriesTitle: string): OfflineDownload[] {
  return downloads
    .filter((d) => d.episode && d.episode.sonarrId === sonarrId && d.episode.seriesTitle === seriesTitle)
    .sort((a, b) => episodeRank(a.episode!) - episodeRank(b.episode!));
}
