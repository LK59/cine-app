"use client";

import { useSyncExternalStore } from "react";
import {
  currentOfflineDownloads,
  initOfflineDownloads,
  offlineAccount,
  removeOfflineDownload,
  startOfflineDownload,
  type OfflineDownload,
} from "@/lib/offline/downloads";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { cleanPassageDownloads, PASSAGE_DOWNLOADS_MAX, passageDownloadOf, type PassageDownload } from "./downloads";

/**
 * Les téléchargements hors ligne et le passage d'adresse, côté navigateur (DECISIONS.md §119).
 *
 * - **Au départ** (ancienne adresse) : la liste des téléchargements de ce compte sur cet appareil,
 *   terminés ou en cours, part avec le passage (`collectPassageDownloads`) — la liste, jamais les
 *   fichiers : chaque adresse a son stockage, et l'application installée sur iPhone le sien.
 * - **À l'arrivée** (nouvelle adresse) : la liste reçue est gardée sur ce stockage
 *   (`cine:passage-downloads`) le temps de l'invitation « Retélécharger vos N téléchargements » ; un
 *   appui relance chacun par le chemin normal (`relaunchPassageDownloads` → `startOfflineDownload` :
 *   droits, quotas, copies du serveur reprises si elles existent encore). « Plus tard » la laisse dans
 *   la page des téléchargements, jusqu'à ce qu'on la ferme.
 * - **Au retour sur l'ancienne adresse** : ses fichiers ne s'effacent que titre par titre, et
 *   seulement ceux que le serveur atteste récupérés par ce compte sur la nouvelle adresse depuis le
 *   passage de cette session-ci (`freeOldAddressDownloads`), jamais pendant une lecture.
 */

/** L'invitation gardée sur ce stockage : le compte, la date de l'arrivée, la liste, déjà montrée ou non. */
export const PASSAGE_OFFER_KEY = "cine:passage-downloads";

export interface PassageOffer {
  account: string;
  at: number;
  items: PassageDownload[];
  /** L'invitation flottante a été montrée : « Plus tard » la renvoie à la page des téléchargements. */
  prompted: boolean;
}

const listeners = new Set<() => void>();
let cache: { raw: string | null; value: PassageOffer | null } = { raw: null, value: null };

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(PASSAGE_OFFER_KEY);
  } catch {
    return null;
  }
}

function parse(raw: string | null): PassageOffer | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<PassageOffer>;
    if (typeof o.account !== "string" || typeof o.at !== "number") return null;
    const items = cleanPassageDownloads(o.items);
    if (!items.length) return null;
    return { account: o.account, at: o.at, items, prompted: o.prompted === true };
  } catch {
    return null;
  }
}

function snapshot(): PassageOffer | null {
  if (typeof window === "undefined") return null;
  const raw = readRaw();
  if (raw !== cache.raw) cache = { raw, value: parse(raw) };
  return cache.value;
}

function write(offer: PassageOffer | null): void {
  try {
    if (offer) window.localStorage.setItem(PASSAGE_OFFER_KEY, JSON.stringify(offer));
    else window.localStorage.removeItem(PASSAGE_OFFER_KEY);
  } catch {
    /* stockage refusé : l'invitation ne survivra pas au rechargement */
  }
  for (const listener of listeners) listener();
}

/** L'invitation de ce compte sur ce stockage, s'il y en a une. */
export function passageOfferFor(account: string | null): PassageOffer | null {
  const offer = snapshot();
  return offer && account && offer.account === account ? offer : null;
}

export function usePassageOffer(account: string | null): PassageOffer | null {
  const offer = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    () => null
  );
  return offer && account && offer.account === account ? offer : null;
}

/**
 * Garde la liste reçue à l'arrivée. Une liste vide efface l'invitation ; une arrivée déjà gardée
 * (même date) ne remplace rien — ni « montrée » ni une fermeture.
 */
export function keepPassageOffer(account: string, at: number, items: unknown): void {
  const clean = cleanPassageDownloads(items);
  const current = snapshot();
  if (current && current.account === account && current.at === at) return;
  if (!clean.length) return;
  write({ account, at, items: clean, prompted: false });
}

export function notePassageOfferPrompted(): void {
  const current = snapshot();
  if (current && !current.prompted) write({ ...current, prompted: true });
}

/** Fermée (page des téléchargements), ou relancée : l'invitation s'efface de ce stockage. */
export function forgetPassageOffer(): void {
  write(null);
}

/** Un téléchargement emporté par le passage : en cours ou terminé — jamais un échec. */
const carried = (d: OfflineDownload) => d.state === "preparing" || d.state === "downloading" || d.state === "paused" || d.state === "done";

/**
 * La liste que l'ancienne adresse emporte : les téléchargements de **ce compte** sur cet appareil,
 * terminés ou en cours, les plus récents d'abord, au plus `PASSAGE_DOWNLOADS_MAX`. Ne lève jamais :
 * un stockage illisible n'empêche pas le passage, il part sans liste.
 */
export async function collectPassageDownloads(): Promise<PassageDownload[]> {
  try {
    const who = persistedCacheAccount();
    if (!who) return [];
    await initOfflineDownloads();
    if (offlineAccount() !== who) return [];
    const out: PassageDownload[] = [];
    for (const d of [...currentOfflineDownloads()].sort((a, b) => b.createdAt - a.createdAt)) {
      if (!carried(d)) continue;
      const entry = passageDownloadOf(d);
      if (entry) out.push(entry);
      if (out.length >= PASSAGE_DOWNLOADS_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Combien de téléchargements partiraient avec le passage (la phrase de la fenêtre « Passer »). */
export async function passageDownloadsCount(): Promise<number> {
  return (await collectPassageDownloads()).length;
}

/**
 * « Retélécharger » : chaque titre est redemandé aux mêmes choix (qualité, codec, piste son, place
 * dans sa série), un à un, par le chemin normal. Un titre déjà sur l'appareil (et pas en échec)
 * n'est pas redemandé ; un refus du serveur (supprimé entre-temps, masqué, limite atteinte) passe
 * sans bruit. Rend combien ont été lancés. L'invitation s'efface.
 */
export async function relaunchPassageDownloads(
  items: readonly PassageDownload[],
  start: typeof startOfflineDownload = startOfflineDownload
): Promise<number> {
  forgetPassageOffer();
  await initOfflineDownloads().catch(() => undefined);
  let started = 0;
  for (const item of items) {
    if (currentOfflineDownloads().some((d) => d.itemId === item.itemId && d.state !== "failed")) continue;
    try {
      await start({
        itemId: item.itemId,
        ...(item.episode ? { episode: item.episode } : {}),
        radarrId: item.radarrId,
        title: item.title,
        year: item.year,
        runtimeSeconds: item.runtimeSeconds,
        audioIndex: item.audioIndex,
        audioLabel: item.audioLabel,
        audioTracks: item.audioTracks,
        quality: item.quality,
        codec: item.codec,
      });
      started += 1;
    } catch {
      /* indisponible ou refusé : ignoré sans bruit */
    }
  }
  return started;
}

/**
 * Sur l'ancienne adresse : efface de l'appareil les téléchargements que **le serveur atteste**
 * récupérés entiers par ce compte sur la nouvelle adresse, par une session issue du passage de
 * cette session (`GET /api/passage/fetched`). Titre par titre, et `playing()` relu avant chacun :
 * jamais pendant une lecture. Rend les titres effacés.
 *
 * Quand la nouvelle adresse a repris la **même** version (même identifiant), le retrait reste sur
 * l'appareil : la demande du serveur est celle du compte, commune aux deux adresses, et la retirer
 * l'arracherait à la nouvelle. Une autre version (celle d'ici, peut-être encore en préparation pour
 * personne) est retirée comme une suppression ordinaire.
 */
export async function freeOldAddressDownloads(playing: () => boolean): Promise<OfflineDownload[]> {
  if (playing()) return [];
  const who = persistedCacheAccount();
  if (!who) return [];
  await initOfflineDownloads();
  if (offlineAccount() !== who) return [];
  const mine = [...currentOfflineDownloads()];
  if (!mine.length) return [];
  const itemIds = [...new Set(mine.map((d) => d.itemId.toLowerCase()))].slice(0, PASSAGE_DOWNLOADS_MAX * 2);
  const res = await fetch(`/api/passage/fetched?items=${itemIds.join(",")}`, { cache: "no-store" }).catch(() => null);
  if (!res?.ok) return [];
  const { fetched } = ((await res.json().catch(() => null)) ?? {}) as { fetched?: Record<string, string> };
  if (!fetched || typeof fetched !== "object") return [];
  const removed: OfflineDownload[] = [];
  for (const d of mine) {
    const jobId = fetched[d.itemId.toLowerCase()];
    if (typeof jobId !== "string") continue;
    // Une lecture commencée entre deux effacements : on s'arrête là, le reste attendra.
    if (playing() || offlineAccount() !== who) break;
    await removeOfflineDownload(d.id, { server: d.id !== jobId });
    removed.push(d);
  }
  if (removed.length) {
    void fetch("/api/passage/fetched", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removed: removed.map((d) => d.itemId) }),
    }).catch(() => undefined);
  }
  return removed;
}
