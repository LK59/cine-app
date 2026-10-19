"use client";

import { useSyncExternalStore } from "react";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { deviceStore, deviceStoreSupported } from "./deviceStore";
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

export type OfflineState = "preparing" | "downloading" | "done" | "failed";

export interface OfflineDownload {
  /** L'identifiant de la préparation serveur — aussi le nom du dossier sur l'appareil. */
  id: string;
  itemId: string;
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
  /** Ce qui est sur l'appareil. */
  bytes: number;
  state: OfflineState;
  error: string | null;
  createdAt: number;
  /** Où la lecture du fichier téléchargé s'est arrêtée. */
  positionSeconds: number;
  hasPoster: boolean;
}

const CHUNK = 8 * 1024 * 1024;
const POLL_MS = 2000;

let account: string | null = null;
let downloads: OfflineDownload[] = [];
const listeners = new Set<() => void>();
let loopRunning = false;
let stopLoop: AbortController | null = null;
let wakeLock: { release(): Promise<void> } | null = null;

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
    loaded.push({ ...meta, bytes: size });
  }
  if (account !== current) return;
  downloads = loaded.sort((a, b) => b.createdAt - a.createdAt);
  emit();
  void runLoop();
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
export async function removeOfflineDownload(id: string): Promise<void> {
  const owner = account;
  downloads = downloads.filter((d) => d.id !== id);
  emit();
  if (stopLoop) stopLoop.abort();
  if (owner) await deviceStore.remove(owner, id).catch(() => {});
  await fetch(`/api/offline/jobs/${id}`, { method: "DELETE" }).catch(() => {});
  void runLoop();
}

/** Où la lecture du fichier téléchargé s'est arrêtée — gardé avec lui, pour la reprendre. */
export function saveOfflinePosition(id: string, seconds: number): void {
  const updated = patch(id, { positionSeconds: seconds });
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

async function runLoop(): Promise<void> {
  if (loopRunning || !account) return;
  loopRunning = true;
  const owner = account;
  const run = async () => {
    try {
      for (;;) {
        if (account !== owner) return;
        const next = downloads.find((d) => d.state === "preparing" || d.state === "downloading");
        if (!next) return;
        stopLoop = new AbortController();
        await holdWakeLock(true);
        await step(owner, next, stopLoop.signal).catch(async () => {
          // Réseau coupé, serveur qui redémarre : on réessaie un peu plus tard, sans rien perdre.
          await sleep(5000, stopLoop!.signal);
        });
      }
    } finally {
      stopLoop = null;
      await holdWakeLock(false);
    }
  };
  try {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks) await locks.request(`cine-offline-${owner}`, run);
    else await run();
  } finally {
    loopRunning = false;
  }
}

/** Un pas : relire l'état de la préparation, puis télécharger au plus une plage. */
async function step(owner: string, d: OfflineDownload, signal: AbortSignal): Promise<void> {
  const res = await fetch(`/api/offline/jobs/${d.id}`, { signal, cache: "no-store" });
  if (res.status === 404) {
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
    expectedBytes: job.status === "done" ? job.bytes : Math.max(job.expectedBytes, job.bytes),
    bytes,
    state: job.status === "done" || job.bytes > 0 ? "downloading" : "preparing",
  });
  if (!current) return;
  if (job.status === "done" && bytes >= job.bytes) {
    current = patch(d.id, { state: "done" });
    if (current) await saveMeta(current);
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
  if (signal.aborted || !offlineDownloadById(d.id)) return;
  await deviceStore.writeVideo(owner, d.id, bytes, chunk);
  current = patch(d.id, { bytes: bytes + chunk.byteLength });
  if (current) await saveMeta(current);
}
