import { isJellyfinId } from "@/lib/jellyfinPath";
import type { OfflineCodec, OfflineQuality } from "@/lib/offline/quality";

/**
 * Les téléchargements hors ligne qu'un passage emporte (DECISIONS.md §119) — **la liste, jamais les
 * fichiers** : chaque adresse a son propre stockage (OPFS), et sur iPhone l'application installée a
 * le sien. Ce qu'il faut pour redemander exactement la même chose sur la nouvelle adresse, par le
 * chemin normal (`startOfflineDownload`) : le titre, la qualité, le codec, la piste son choisie — et
 * de quoi l'afficher avant que le serveur ne réponde (titre, taille, place d'un épisode dans sa série).
 *
 * Lu par le serveur (à la demande, puis à l'arrivée) et par le navigateur (à l'arrivée) : ce module
 * n'importe rien de l'un ni de l'autre. Chaque entrée est revalidée champ par champ des deux côtés ;
 * une entrée hors format est ignorée sans bruit, les autres passent.
 */

export interface PassageEpisode {
  sonarrId: number | null;
  seriesTitle: string;
  seasonNumber: number;
  episodeNumber: number | null;
  episodeTitle: string;
  autoNext: boolean;
  seriesItemId?: string;
  audioLanguage?: string | null;
  next?: { itemId: string; title: string } | null;
}

export interface PassageDownload {
  itemId: string;
  quality: OfflineQuality;
  codec: OfflineCodec;
  audioIndex: number;
  title: string;
  /** La taille attendue (octets) : pour annoncer « N téléchargements (X Go) ». */
  bytes: number;
  year: number | null;
  radarrId: number | null;
  runtimeSeconds: number;
  audioLabel: string;
  audioTracks: { index: number; label: string }[];
  episode?: PassageEpisode;
}

/** Au plus tant d'entrées : une saison ou une saga, comme la limite du serveur (`OFFLINE_MAX_IN_FLIGHT`). */
export const PASSAGE_DOWNLOADS_MAX = 50;
/** Le paquet entier : cinquante entrées font une vingtaine de Ko ; au-delà, refusé. */
export const PASSAGE_DOWNLOADS_MAX_BYTES = 64 * 1024;

const MAX_TEXT = 300;
const MAX_TRACKS = 32;
/** Une taille plausible : 1 To. */
const MAX_BYTES = 1024 ** 4;
const LANGUAGE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})?$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_TEXT;
const whole = (v: unknown, max = 1_000_000): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const wholeOrNull = (v: unknown): v is number | null => v === null || whole(v, 10_000_000);

function cleanTracks(raw: unknown): { index: number; label: string }[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TRACKS) return null;
  const out: { index: number; label: string }[] = [];
  for (const t of raw) {
    if (!isObject(t) || !whole(t.index, 1000) || !text(t.label)) return null;
    out.push({ index: t.index, label: t.label });
  }
  return out;
}

function cleanEpisode(raw: unknown): PassageEpisode | null {
  if (!isObject(raw)) return null;
  const { sonarrId, seriesTitle, seasonNumber, episodeNumber, episodeTitle, autoNext, seriesItemId, audioLanguage, next } = raw;
  if (!wholeOrNull(sonarrId) || !text(seriesTitle) || !whole(seasonNumber, 10_000) || !(episodeNumber === null || whole(episodeNumber, 100_000))) return null;
  if (!text(episodeTitle) || typeof autoNext !== "boolean") return null;
  const out: PassageEpisode = { sonarrId, seriesTitle, seasonNumber, episodeNumber, episodeTitle, autoNext };
  if (seriesItemId !== undefined) {
    if (!isJellyfinId(seriesItemId)) return null;
    out.seriesItemId = seriesItemId;
  }
  if (audioLanguage !== undefined) {
    if (!(audioLanguage === null || (typeof audioLanguage === "string" && LANGUAGE.test(audioLanguage)))) return null;
    out.audioLanguage = audioLanguage;
  }
  if (next !== undefined) {
    if (next === null) out.next = null;
    else if (isObject(next) && isJellyfinId(next.itemId) && text(next.title)) out.next = { itemId: next.itemId, title: next.title };
    else return null;
  }
  return out;
}

/** Une entrée, revalidée ; `null` si un seul champ requis est hors format. */
export function cleanPassageDownload(raw: unknown): PassageDownload | null {
  if (!isObject(raw)) return null;
  const { itemId, quality, codec, audioIndex, title, bytes, year, radarrId, runtimeSeconds, audioLabel, audioTracks, episode } = raw;
  if (!isJellyfinId(itemId)) return null;
  if (quality !== "standard" && quality !== "high") return null;
  if (codec !== "hevc" && codec !== "h264") return null;
  if (!whole(audioIndex, 1000)) return null;
  if (!text(title) || !whole(bytes, MAX_BYTES)) return null;
  if (!(year === null || whole(year, 3000)) || !wholeOrNull(radarrId)) return null;
  if (typeof runtimeSeconds !== "number" || !(runtimeSeconds > 0) || runtimeSeconds > 1_000_000) return null;
  if (!text(audioLabel)) return null;
  const tracks = cleanTracks(audioTracks);
  if (!tracks) return null;
  const out: PassageDownload = { itemId: itemId.toLowerCase(), quality, codec, audioIndex, title, bytes, year, radarrId, runtimeSeconds, audioLabel, audioTracks: tracks };
  if (episode !== undefined) {
    const ep = cleanEpisode(episode);
    if (!ep) return null;
    out.episode = ep;
  }
  return out;
}

/**
 * Ce qui reste d'une liste venue d'ailleurs : les entrées valides, une par titre (la première), au
 * plus `PASSAGE_DOWNLOADS_MAX`. `[]` pour tout ce qui n'est pas une liste, ou une liste trop grosse.
 */
export function cleanPassageDownloads(raw: unknown): PassageDownload[] {
  if (!Array.isArray(raw)) return [];
  try {
    if (JSON.stringify(raw).length > PASSAGE_DOWNLOADS_MAX_BYTES) return [];
  } catch {
    return [];
  }
  const out: PassageDownload[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= PASSAGE_DOWNLOADS_MAX) break;
    const clean = cleanPassageDownload(entry);
    if (!clean || seen.has(clean.itemId)) continue;
    seen.add(clean.itemId);
    out.push(clean);
  }
  return out;
}

/** Ce qu'un téléchargement de l'appareil devient dans la liste emportée (les champs utiles seulement). */
export function passageDownloadOf(d: {
  itemId: string;
  quality: OfflineQuality;
  codec: OfflineCodec;
  audioIndex: number;
  title: string;
  expectedBytes: number;
  year: number | null;
  radarrId: number | null;
  runtimeSeconds: number;
  audioLabel: string;
  audioTracks: { index: number; label: string }[];
  episode?: PassageEpisode;
}): PassageDownload | null {
  const episode = d.episode
    ? {
        sonarrId: d.episode.sonarrId,
        seriesTitle: d.episode.seriesTitle,
        seasonNumber: d.episode.seasonNumber,
        episodeNumber: d.episode.episodeNumber,
        episodeTitle: d.episode.episodeTitle,
        autoNext: d.episode.autoNext,
        ...(d.episode.seriesItemId !== undefined ? { seriesItemId: d.episode.seriesItemId } : {}),
        ...(d.episode.audioLanguage !== undefined ? { audioLanguage: d.episode.audioLanguage } : {}),
        ...(d.episode.next !== undefined ? { next: d.episode.next } : {}),
      }
    : undefined;
  return cleanPassageDownload({
    itemId: d.itemId,
    quality: d.quality,
    codec: d.codec,
    audioIndex: d.audioIndex,
    title: d.title,
    bytes: Math.max(0, Math.round(d.expectedBytes || 0)),
    year: d.year,
    radarrId: d.radarrId,
    runtimeSeconds: d.runtimeSeconds,
    audioLabel: d.audioLabel,
    audioTracks: d.audioTracks,
    ...(episode ? { episode } : {}),
  });
}

/** La taille totale annoncée. */
export function passageDownloadsBytes(list: readonly PassageDownload[]): number {
  return list.reduce((sum, d) => sum + d.bytes, 0);
}
