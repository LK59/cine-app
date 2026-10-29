"use client";

import { useSyncExternalStore } from "react";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { deviceStore, deviceStoreSupported, isDeviceStoreError, resetDeviceStore } from "./deviceStore";
import { reportClientError } from "@/lib/reportClientError";
import { withCode } from "@/lib/upstreamError";
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
interface WakeLockLike {
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
}
let wakeLock: WakeLockLike | null = null;
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

/**
 * Charge les téléchargements du compte de cette page et relance la boucle. Sans effet sans compte.
 *
 * Un seul chargement à la fois par compte : le rond du cinéma, la fiche et l'entrée hors ligne le
 * demandent chacun à leur montage, et deux lectures entrecroisées remplaçaient la liste par la plus
 * ancienne — un téléchargement lancé entre les deux disparaissait (relecture du 19/10/2026).
 */
let loading: { account: string; promise: Promise<void> } | null = null;
export function initOfflineDownloads(): Promise<void> {
  const current = persistedCacheAccount();
  if (!current || !deviceStoreSupported()) return Promise.resolve();
  if (current === account && downloads.length) {
    void flushPendingDeletes();
    void runLoop();
    return Promise.resolve();
  }
  if (loading?.account === current) return loading.promise;
  const promise = load(current).finally(() => {
    if (loading?.promise === promise) loading = null;
  });
  loading = { account: current, promise };
  return promise;
}

async function load(current: string): Promise<void> {
  account = current;
  sessionLost = false;
  const ids = await deviceStore.list(current).catch(() => [] as string[]);
  const loaded: OfflineDownload[] = [];
  for (const id of ids) {
    const meta = await deviceStore.readMeta<OfflineDownload>(current, id).catch(() => null);
    if (!meta) {
      // Un dossier sans description et sans vidéo : un rangement arrivé après une suppression. Il ne
      // se voyait nulle part et prenait de la place pour rien. Jamais un dossier qui a une vidéo : une
      // description illisible un instant ne doit pas coûter un film.
      const files = await deviceStore.files(current, id).catch(() => null);
      if (files && !files.includes("video.mp4") && !files.includes("meta.json") && !downloads.some((d) => d.id === id) && !removals.has(id)) {
        void deviceStore.remove(current, id).catch(() => {});
      }
      continue;
    }
    // La taille du fichier fait foi ; illisible (fichier tenu un instant par une autre page), celle
    // notée au dernier morceau écrit — jamais 0, qui affichait un épisode entier « 0 Mo » et le faisait
    // repartir de zéro (iPhone, 19/10/2026).
    const size = await deviceStore.videoSize(current, id).catch(() => meta.bytes ?? 0);
    loaded.push({ ...meta, bytes: size });
  }
  if (account !== current) return;
  // Ce qui a été demandé pendant la lecture du dossier reste : la liste lue s'y ajoute.
  const started = downloads.filter((d) => !loaded.some((l) => l.id === d.id));
  downloads = [...started, ...loaded].sort((a, b) => b.createdAt - a.createdAt);
  emit();
  void flushPendingDeletes();
  void runLoop();
  // Les téléchargements faits avant que les aperçus de la barre partent avec le film : rattrapés
  // une fois, avec du réseau (sans, rien n'est noté, et on réessaiera au prochain chargement).
  if (typeof navigator !== "undefined" && navigator.onLine !== false) {
    for (const d of loaded) if (d.trickplay === undefined && d.state !== "failed") void keepTrickplay(current, d.id, d.itemId);
    // Et ceux dont la fiche date d'avant les repères de générique (20/10/2026).
    for (const d of loaded) if ((d.artwork === undefined || (d.artwork && d.artwork.markers === undefined)) && d.state !== "failed") void keepArtwork(current, d.id, d.itemId);
  }
  // Le logo et le visuel lus d'avance : l'ouverture de la lecture fige ce qu'elle montre à son montage.
  for (const d of loaded) if (d.artwork) warmArtwork(current, d);
}

/**
 * Un rangement (sous-titres, aperçus, fiche, affiche) qui finit après la suppression de son
 * téléchargement a recréé son dossier : on le retire aussitôt.
 */
async function stillThere(owner: string, id: string): Promise<boolean> {
  if (offlineDownloadById(id)) return true;
  await deviceStore.remove(owner, id).catch(() => {});
  return false;
}

async function keepArtwork(owner: string, id: string, itemId: string): Promise<void> {
  const artwork = await storeOfflineArtwork(owner, id, itemId);
  if (artwork === undefined || account !== owner || !(await stillThere(owner, id))) return;
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
  if (trickplay === undefined || account !== owner || !(await stillThere(owner, id))) return;
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
  const body = (await res.json().catch(() => null)) as { job?: OfflineJob; error?: string; code?: string } | null;
  // Le code voyage avec l'erreur (`offline-limit`) : la fenêtre le traduit
  // (`apiErrorText`) au lieu de citer le message français à tous les comptes.
  if (!res.ok || !body?.job) throw withCode(new Error(body?.error ?? `Erreur ${res.status}`), body?.code);
  const job = body.job;
  // Un téléchargement déjà sur l'appareil pour ce titre est remplacé : un seul par titre.
  for (const old of downloads.filter((d) => d.itemId === request.itemId && d.id !== job.id)) await removeOfflineDownload(old.id);
  // Garder le stockage à l'abri du ménage du navigateur, dès le premier téléchargement.
  void navigator.storage?.persist?.().catch(() => false);
  let existing = downloads.find((d) => d.id === job.id);
  // Un échec redemandé (« Télécharger la saison », l'épisode suivant automatique) : le serveur reprend
  // la même version sous le même identifiant ; l'appareil repart de zéro avec elle. Gardé en
  // « Échec », il ne se téléchargeait jamais alors que le serveur la refaisait (relecture du 19/10/2026).
  if (existing?.state === "failed") {
    await deviceStore.truncateVideo(owner, existing.id, 0).catch(() => {});
    existing = patch(existing.id, { state: "preparing", error: null, generation: job.generation, bytes: 0, serverBytes: job.bytes, serverDone: job.status === "done", fromUser: true }) ?? undefined;
  }
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
    if (!(await stillThere(owner, job.id))) return;
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
      // 200 seulement : une affiche absente répond 204 (`ok` aussi).
      .then((r) => (r.status === 200 ? r.arrayBuffer() : null))
      .then(async (buffer) => {
        if (!buffer || buffer.byteLength === 0 || !account || !offlineDownloadById(job.id)) return;
        await deviceStore.writePoster(owner, job.id, new Uint8Array(buffer));
        if (!(await stillThere(owner, job.id))) return;
        const updated = patch(job.id, { hasPoster: true });
        if (updated) await saveMeta(updated);
      })
      .catch(() => {});
  }
  void runLoop();
}

/** La liste chargée, telle quelle (le passage la lit pour l'emporter, §119). */
export function currentOfflineDownloads(): readonly OfflineDownload[] {
  return downloads;
}

/**
 * Annuler ou supprimer : le fichier quitte l'appareil, et le serveur sait que ce compte n'en veut plus.
 *
 * `server: false` — l'appareil seul (le passage, §119) : le fichier est parti sur la nouvelle adresse,
 * où **le même compte** tient peut-être la même demande (`offline_requests` est par compte et par
 * version, pas par adresse). La retirer ici l'arracherait à la nouvelle adresse.
 */
export function removeOfflineDownload(id: string, options: { server?: boolean } = {}): Promise<void> {
  const owner = account;
  const tellServer = options.server !== false;
  downloads = downloads.filter((d) => d.id !== id);
  emit();
  claimed.get(id)?.abort();
  if (!tellServer) {
    const removal = (async () => {
      if (owner) {
        forgetOfflineImages(owner, id);
        await deviceStore.remove(owner, id).catch(() => {});
      }
    })();
    removals.set(id, removal);
    void removal.finally(() => {
      if (removals.get(id) === removal) removals.delete(id);
    });
    return removal;
  }
  // Le retrait de la demande d'abord, et retenu : un nouveau téléchargement du même titre l'attend
  // (`startOfflineDownload`). Envoyé après le ménage de l'appareil, il arrivait après la nouvelle
  // demande — même version, même identifiant — et l'effaçait : « Préparation » sans fin, puis
  // « Échec » (Louis, 19/10/2026).
  const removal = (async () => {
    // Sans réseau, le retrait attend : sinon la préparation continuait sur le serveur pour personne.
    const sent = await fetch(`/api/offline/jobs/${id}`, { method: "DELETE" })
      .then((r) => r.ok || r.status === 404)
      .catch(() => false);
    if (!sent && owner) rememberPendingDelete(owner, id);
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

/** Les retraits que le serveur n'a pas reçus, par compte — renvoyés au prochain chargement. */
const PENDING_DELETES = "cine:offline-pending-deletes";

function pendingDeletes(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(PENDING_DELETES) ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}

function rememberPendingDelete(owner: string, id: string): void {
  try {
    const all = pendingDeletes();
    all[owner] = [...new Set([...(all[owner] ?? []), id])].slice(-50);
    localStorage.setItem(PENDING_DELETES, JSON.stringify(all));
  } catch {
    /* stockage refusé : le retrait se perd, la copie expirera d'elle-même sur le serveur */
  }
}

async function flushPendingDeletes(): Promise<void> {
  const owner = account;
  if (!owner || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  const ids = pendingDeletes()[owner] ?? [];
  for (const id of ids) {
    // Redemandé depuis : il n'y a plus rien à retirer.
    if (offlineDownloadById(id)) continue;
    const sent = await fetch(`/api/offline/jobs/${id}`, { method: "DELETE" })
      .then((r) => r.ok || r.status === 404)
      .catch(() => false);
    if (!sent) return;
    try {
      const all = pendingDeletes();
      all[owner] = (all[owner] ?? []).filter((x) => x !== id);
      localStorage.setItem(PENDING_DELETES, JSON.stringify(all));
    } catch {
      return;
    }
  }
}

/**
 * Réessayer un échec, aux mêmes choix (piste, qualité, téléchargement automatique) : le retrait, puis
 * la même demande — depuis la page des téléchargements et la fiche hors ligne, où il n'y a pas de
 * fenêtre de choix sous la main.
 */
export async function retryOfflineDownload(id: string): Promise<void> {
  const d = offlineDownloadById(id);
  if (!d) return;
  await removeOfflineDownload(id);
  await startOfflineDownload({
    itemId: d.itemId,
    ...(d.episode ? { episode: d.episode } : {}),
    radarrId: d.radarrId,
    title: d.title,
    year: d.year,
    runtimeSeconds: d.runtimeSeconds,
    audioIndex: d.audioIndex,
    audioLabel: d.audioLabel,
    audioTracks: d.audioTracks,
    quality: d.quality,
    codec: d.codec,
  });
}

/**
 * La reprise que Jellyfin connaît, rapportée sur l'appareil quand une fiche l'apprend : la page des
 * téléchargements et la fiche hors ligne lisent celle de l'appareil, et disaient « 1 h 20 restantes »
 * quand la fiche en ligne disait « 40 min » pour le même film, vu entre-temps ailleurs (relecture du
 * 19/10/2026). Seulement quand rien n'attend d'être envoyé : une position lue hors ligne est la plus récente.
 */
export function adoptOnlinePosition(id: string, seconds: number): void {
  const d = offlineDownloadById(id);
  if (!d || Math.abs(d.positionSeconds - seconds) < 2) return;
  const updated = patch(id, { positionSeconds: seconds, positionAt: Date.now(), watchedToEnd: false });
  if (updated) void saveMeta(updated);
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
  // Revu en partie après avoir été vu jusqu'au bout : ce n'est plus « vu », et le ménage automatique
  // ne doit plus l'effacer à l'arrivée du suivant.
  const updated = patch(id, { positionSeconds: kept.seconds, positionAt: Date.now(), watchedToEnd: kept.watched });
  if (updated) void saveMeta(updated);
}

/**
 * L'écran allumé tant qu'un téléchargement avance et que la page est visible. Une seule demande à la
 * fois (trois fils la demandaient ensemble au lancement : deux verrous perdus, jamais rendus), et
 * redemandée au retour au premier plan — le navigateur la rend de lui-même quand la page se cache.
 */
let wakeRequest: Promise<void> | null = null;
function holdWakeLock(on: boolean): Promise<void> {
  if (on) {
    if (wakeLock || wakeRequest || typeof document === "undefined" || document.visibilityState !== "visible") return wakeRequest ?? Promise.resolve();
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockLike> } };
    wakeRequest = (async () => {
      try {
        const lock = (await nav.wakeLock?.request("screen")) ?? null;
        if (!lock) return;
        // Rendu par le navigateur (page cachée) : oublié, pour être redemandé au retour.
        lock.addEventListener?.("release", () => {
          if (wakeLock === lock) wakeLock = null;
        });
        if (workers === 0) await lock.release().catch(() => {});
        else wakeLock = lock;
      } catch {
        wakeLock = null;
      } finally {
        wakeRequest = null;
      }
    })();
    return wakeRequest;
  }
  const lock = wakeLock;
  wakeLock = null;
  return lock ? lock.release().catch(() => {}) : Promise.resolve();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && workers > 0) void holdWakeLock(true);
  });
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
/**
 * Les téléchargements qu'un autre onglet tient, et jusqu'à quand on les laisse : un fil qui retombait
 * sur le même toutes les cinq secondes était un fil perdu pour les autres (relecture du 19/10/2026).
 */
const elsewhere = new Map<string, number>();
const ELSEWHERE_MS = 30_000;

/**
 * La session de cette page a été refusée (401) : les téléchargements s'arrêtent jusqu'au prochain
 * chargement de la page ou du compte (`load`). Ils réessayaient toutes les 60 s sans fin : l'ancienne
 * adresse d'un iPhone, sa session refusée, a frappé 75 fois en cinq heures (25/10/2026). Le reste de la
 * page mène déjà à la connexion ; rien n'est perdu, la reprise part de ce qui est sur l'appareil.
 */
let sessionLost = false;
const isSessionLost = (error: unknown) => error instanceof Error && (error.message === "état 401" || error.message === "fichier 401");

function waiting(): OfflineDownload[] {
  if (sessionLost) return [];
  const now = Date.now();
  return downloads
    .filter((d) => (d.state === "preparing" || d.state === "downloading") && !claimed.has(d.id) && !((elsewhere.get(d.id) ?? 0) > now))
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
      if (!ran) {
        elsewhere.set(next.id, Date.now() + ELSEWHERE_MS);
        setTimeout(() => void runLoop(), ELSEWHERE_MS + 100);
      }
    } catch (error) {
      // Une pause ou une annulation : rien d'anormal.
      if (control.signal.aborted) continue;
      // Réseau coupé, serveur qui redémarre : on réessaie un peu plus tard, sans rien perdre.
      // Au journal, une fois par erreur (le rapporteur dédoublonne) : ce qu'un iPhone a dit.
      reportClientError(error, "component:hors-ligne", { download: next.id, bytes: String(next.bytes) });
      // Seules les erreurs du stockage de l'appareil comptent : un réseau coupé, un 502 pendant un
      // déploiement, un 401 de session perdue n'ont rien à voir avec un fichier verrouillé — comptés,
      // ils relançaient le stockage, et la relance fait échouer les lectures en vol du lecteur hors
      // ligne, celui qu'on utilise justement sans réseau (§109, relecture du 19/10/2026).
      if (isDeviceStoreError(error)) failures += 1;
      // Deux échecs de suite : le stockage de l'appareil repart d'un worker neuf.
      if (failures >= 2) {
        failures = 0;
        resetDeviceStore();
      }
      // Session perdue : on s'arrête là (`sessionLost`).
      if (isSessionLost(error)) {
        sessionLost = true;
        return;
      }
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
    // Tout est déjà sur l'appareil : la copie du serveur a simplement été libérée, cinq minutes après
    // la dernière lecture (revue du 20/10/2026, `releaseFetchedCopies`). Une page tuée entre le dernier
    // morceau et ce contrôle, et revenue plus tard, ne doit pas déclarer « échec » un film complet.
    if (d.serverDone && d.expectedBytes > 0 && d.bytes >= d.expectedBytes) {
      const done = patch(d.id, { state: "done" });
      if (done) await saveMeta(done);
      if (done?.episode) await sweepWatchedBefore(done);
      return;
    }
    // La version n'existe plus sur le serveur : effacée par l'administrateur (Activité), ou expirée
    // après des jours en pause. On le dit, et « Réessayer » la redemande. Elle se redemandait toute
    // seule (un remède au retrait mal ordonné du 19/10/2026, corrigé à la source depuis) : une copie
    // effacée par l'administrateur revenait à chaque lancement, préparée pour personne.
    const failed = patch(d.id, { state: "failed", error: "La préparation n'existe plus sur le serveur" });
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

/** Combien de téléchargements ce compte a sur cet appareil (sans charger la liste). */
export async function offlineDownloadCount(owner: string | null): Promise<number> {
  if (!owner || !deviceStoreSupported()) return 0;
  return (await deviceStore.list(owner).catch(() => [] as string[])).length;
}

/**
 * Effacer tous les téléchargements de ce compte sur cet appareil — proposé à la déconnexion
 * (Louis, 20/10/2026). Le serveur apprend d'abord que ce compte n'en veut plus (la session est encore
 * là), puis le dossier du compte part en entier. Borné : la déconnexion n'attend pas un réseau lent.
 */
export async function removeAccountDownloads(owner: string | null): Promise<void> {
  if (!owner || !deviceStoreSupported()) return;
  const ids = await deviceStore.list(owner).catch(() => [] as string[]);
  for (const id of ids) claimed.get(id)?.abort();
  await Promise.race([
    Promise.all(ids.map((id) => fetch(`/api/offline/jobs/${id}`, { method: "DELETE" }).catch(() => null))),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  for (const id of ids) forgetOfflineImages(owner, id);
  await deviceStore.removeAccount(owner).catch(() => {});
  if (account === owner) {
    downloads = [];
    emit();
  }
}
