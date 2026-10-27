import { jellyfin, type JellyfinSession } from "@/lib/clients/jellyfin";
import { readRecords } from "@/lib/activity/logReader";
import { buildSeances, type Seance } from "@/lib/activity/seances";

/**
 * Les lectures en cours, vues du Stream Deck (27/10/2026) : ce que la touche d'accueil compte, ce que
 * la page « Lectures » montre touche par touche, et le détail d'une lecture.
 *
 * Jellyfin dit qui regarde quoi, où il en est, et par quelle application — la télévision du salon
 * comprise, que Laterna ne voit pas. Le journal du lecteur (`player.log`, en séances) complète celles
 * de Laterna : par quel chemin elle passe, l'image, et ce qui s'est mal passé.
 *
 * **Le lecteur serveur n'est pas un échec** (souhait du propriétaire) : c'est un chemin parmi
 * d'autres, affiché comme tel. Seuls comptent comme souci une attente, une erreur ou une
 * reconstruction qui ne vient pas d'un retour d'arrière-plan — et seulement récents : une séance
 * qui a eu un à-coup il y a vingt minutes et joue depuis sans encombre n'est plus orange.
 */

/** Une session muette depuis plus longtemps que ça ne joue plus (Jellyfin garde l'élément jusqu'à l'arrêt). */
const SILENT_AFTER_MS = 150_000;
/** Un incident plus ancien n'allume plus la lecture en orange. */
const RECENT_TROUBLE_MS = 120_000;
/** Ce que la réponse garde en mémoire : le plugin interroge toutes les quelques secondes. */
const CACHE_MS = 3_000;

export type PlayPath = "appareil" | "serveur" | "télé" | "jellyfin";
export type PlayState = "ok" | "pause" | "souci";

export interface StreamDeckPlay {
  id: string;
  user: string;
  device: string;
  client: string;
  itemId: string | null;
  /** Ce qui sert l'affiche : la série pour un épisode. */
  imageItemId: string | null;
  title: string;
  series: string | null;
  /** « S01E08 », pour un épisode. */
  code: string | null;
  positionS: number | null;
  durationS: number | null;
  paused: boolean;
  path: PlayPath;
  /** « HEVC 4K · Dolby Vision » */
  video: string | null;
  audio: string | null;
  subtitle: string | null;
  /** Le débit du flux envoyé, en Mb/s (transcodage) ou celui du fichier. */
  streamMbps: number | null;
  incidents: { waits: number; errors: number; rebuilds: number; last: string | null };
  state: PlayState;
}

export interface StreamDeckPlays {
  at: number;
  count: number;
  /** Au moins une lecture en souci en ce moment. */
  trouble: boolean;
  plays: StreamDeckPlay[];
}

type Stream = { Type?: string; Index?: number; DisplayTitle?: string; Codec?: string; BitRate?: number; Width?: number; VideoRangeType?: string };
export type LiveSession = JellyfinSession & {
  NowPlayingItem?: NonNullable<JellyfinSession["NowPlayingItem"]> & { SeriesId?: string; MediaStreams?: Stream[]; Bitrate?: number };
  PlayState?: NonNullable<JellyfinSession["PlayState"]> & { AudioStreamIndex?: number; SubtitleStreamIndex?: number };
};

let cached: { at: number; value: Promise<StreamDeckPlays> } | null = null;

export function streamDeckPlays(now = Date.now()): Promise<StreamDeckPlays> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = build(now);
  cached = { at: now, value };
  value.catch(() => {
    if (cached?.value === value) cached = null;
  });
  return value;
}

async function build(now: number): Promise<StreamDeckPlays> {
  const sessions = (await jellyfin.getSessions()) as LiveSession[];
  const live = sessions.filter((s) => s.NowPlayingItem && isFresh(s, now));
  // Douze heures suffisent à retrouver la séance d'un film en cours ; le journal courant est en cache.
  const seances = live.length ? buildSeances(readRecords("player", now - 12 * 3600_000)) : [];
  const plays = live.map((s) => toPlay(s, seances, now)).sort((a, b) => a.user.localeCompare(b.user) || a.title.localeCompare(b.title));
  return { at: now, count: plays.length, trouble: plays.some((p) => p.state === "souci"), plays };
}

function isFresh(s: LiveSession, now: number): boolean {
  const seen = Date.parse(s.LastPlaybackCheckIn ?? s.LastActivityDate ?? "");
  return Number.isFinite(seen) && now - seen <= SILENT_AFTER_MS;
}

/** La séance de Laterna qui joue ce titre pour ce compte : la plus récemment ouverte. */
export function seanceFor(seances: Seance[], user: string, itemId: string | null): Seance | null {
  if (!itemId) return null;
  const key = user.toLowerCase();
  let best: Seance | null = null;
  for (const s of seances) {
    if (s.user.toLowerCase() !== key || s.itemId !== itemId) continue;
    if (!best || s.start > best.start) best = s;
  }
  return best;
}

export function toPlay(s: LiveSession, seances: Seance[], now: number): StreamDeckPlay {
  const item = s.NowPlayingItem!;
  const user = s.UserName ?? "?";
  const itemId = item.Id ?? null;
  const episode = item.SeriesName != null && item.IndexNumber != null;
  const code = episode ? `S${String(item.ParentIndexNumber ?? 0).padStart(2, "0")}E${String(item.IndexNumber).padStart(2, "0")}` : null;
  const seance = isLaterna(s.Client) ? seanceFor(seances, user, itemId) : null;
  const streams = item.MediaStreams ?? [];
  const audioIndex = s.PlayState?.AudioStreamIndex;
  const subtitleIndex = s.PlayState?.SubtitleStreamIndex;
  const audio = streams.find((m) => m.Type === "Audio" && m.Index === audioIndex) ?? (audioIndex == null ? streams.find((m) => m.Type === "Audio") : undefined);
  const subtitle = subtitleIndex != null && subtitleIndex >= 0 ? streams.find((m) => m.Type === "Subtitle" && m.Index === subtitleIndex) : undefined;
  const videoStream = streams.find((m) => m.Type === "Video");
  const transcodeBps = s.TranscodingInfo?.Bitrate;
  const fileBps = item.Bitrate ?? videoStream?.BitRate;
  const paused = s.PlayState?.IsPaused === true;
  const incidents = incidentsOf(seance);
  const troubled = seance?.incidents.some((i) => i.kind !== "fallback" && i.kind !== "slowLink" && now - i.t <= RECENT_TROUBLE_MS) ?? false;
  return {
    id: s.Id,
    user,
    device: s.DeviceName ?? "?",
    client: s.Client ?? "?",
    itemId,
    imageItemId: episode ? (item.SeriesId ?? itemId) : itemId,
    title: item.Name ?? "?",
    series: item.SeriesName ?? null,
    code,
    positionS: s.PlayState?.PositionTicks != null ? Math.round(s.PlayState.PositionTicks / 1e7) : null,
    durationS: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 1e7) : null,
    paused,
    path: pathOf(s, seance),
    video: videoLabel(seance, videoStream),
    audio: audio?.DisplayTitle ?? null,
    subtitle: subtitle?.DisplayTitle ?? null,
    streamMbps: mbps(transcodeBps ?? fileBps),
    incidents,
    state: troubled ? "souci" : paused ? "pause" : "ok",
  };
}

/** Laterna se présente à Jellyfin sous son nom, ou sous l'ancien (« CineApp ») pour un appareil d'avant. */
function isLaterna(client: string | undefined): boolean {
  return !!client && /laterna|lumen|cineapp|cineengine/i.test(client);
}

function pathOf(s: LiveSession, seance: Seance | null): PlayPath {
  if (!isLaterna(s.Client)) return "jellyfin";
  if (seance?.onTv) return "télé";
  if (seance?.player === "serveur" || s.PlayState?.PlayMethod === "Transcode") return "serveur";
  return "appareil";
}

function incidentsOf(seance: Seance | null): StreamDeckPlay["incidents"] {
  if (!seance) return { waits: 0, errors: 0, rebuilds: 0, last: null };
  const counted = seance.incidents.filter((i) => i.kind !== "fallback" && i.kind !== "slowLink");
  const last = counted.length ? counted[counted.length - 1] : null;
  return { waits: seance.stalls, errors: seance.errors, rebuilds: seance.rebuilds, last: last ? `${last.kind} · ${last.reason}`.slice(0, 80) : null };
}

const RANGES: Record<string, string> = { DOVI: "Dolby Vision", DOVIWithHDR10: "Dolby Vision", DOVIWithHDR10Plus: "Dolby Vision", DOVIWithSDR: "Dolby Vision", HDR10: "HDR10", HDR10Plus: "HDR10+", HLG: "HLG" };

function videoLabel(seance: Seance | null, stream: Stream | undefined): string | null {
  // « hevc 3840x1916 10bit » au journal ; Jellyfin dit le codec et la largeur sinon.
  const fromLog = seance?.video?.match(/^(\w+)\s+(\d+)x(\d+)/);
  const codec = (fromLog?.[1] ?? stream?.Codec ?? "").toUpperCase().replace("H264", "H.264").replace("AVC", "H.264");
  const width = fromLog ? Number(fromLog[2]) : (stream?.Width ?? 0);
  const size = width >= 3200 ? "4K" : width >= 1800 ? "1080p" : width >= 1200 ? "720p" : width > 0 ? "SD" : "";
  const range = RANGES[seance?.range ?? stream?.VideoRangeType ?? ""] ?? null;
  const parts = [[codec, size].filter(Boolean).join(" "), range].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function mbps(bps: number | undefined | null): number | null {
  return bps && bps > 0 ? Math.round(bps / 1e5) / 10 : null;
}
