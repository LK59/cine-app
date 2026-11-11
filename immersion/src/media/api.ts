import { detectCodecSupport } from "@/lib/codecSupport";
import { pickMaxBitrate } from "@/lib/networkBitrate";
import { api, apiJson, SessionExpired } from "../lib/session";

/**
 * Les routes de l'application dont la lecture se sert — les mêmes que le lecteur serveur de Laterna.
 *
 * La négociation est faite par `POST /api/jellyfin/playback/start` : c'est la route qui construit le
 * profil d'appareil à partir des codecs déclarés et qui choisit DirectPlay, DirectStream ou
 * Transcode. Les codecs viennent du même module que le lecteur (`@/lib/codecSupport`, lu tel quel
 * dans le code de l'application), le plafond de débit aussi (`@/lib/networkBitrate`) : pour un même
 * navigateur, l'Immersion demande donc exactement ce que le lecteur serveur demanderait.
 */
export type PlayMethod = "DirectPlay" | "DirectStream" | "Transcode";

export interface Negotiation {
  playSessionId: string;
  mediaSourceId: string;
  /** L'adresse du flux, sous `/api/jellyfin/stream/…` : un fichier (lecture directe) ou un maître HLS. */
  manifestUrl: string;
  isDirectPlay: boolean;
  title: string | null;
  /** Les pistes du fichier, telles que Jellyfin les numérote (`index`). */
  audioTracks?: AudioTrack[];
  subtitleTracks?: SubtitleTrack[];
  /**
   * Les repères de l'épisode, en secondes, quand Jellyfin l'a analysé (`playerMarkers` côté application) :
   * le générique d'ouverture, le « précédemment », le début du générique de fin. Nuls pour un film.
   */
  introSkip?: Span | null;
  recapSkip?: Span | null;
  creditsStart?: number | null;
  playbackInfo: {
    playMethod: PlayMethod;
    transcodeReasons: string[];
    video: { codec: string | null; width: number | null; height: number | null; rangeType: string | null } | null;
    audio: { codec: string | null; channels: number | null } | null;
  };
}

export interface Span {
  start: number;
  end: number;
}

export interface AudioTrack {
  index: number;
  language: string | null;
  title: string | null;
  codec: string | null;
  channels: number | null;
  profile: string | null;
  isDefault: boolean;
}

export interface SubtitleTrack {
  index: number;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  isHearingImpaired: boolean;
  isExternal: boolean;
  /** L'adresse de la piste en WebVTT (texte seulement). */
  url: string;
}

export interface NegotiateOptions {
  /** La piste audio voulue (index Jellyfin) ; absente : celle que le serveur choisit. */
  audioStreamIndex?: number;
  /** Position de départ, en secondes. */
  resumeAt?: number;
  /**
   * Demander une image SDR : la « version allégée » de la route — profil sans HDR (Jellyfin mappe les
   * tons), 1080p au plus, HEVC ou H.264. Réservé aux fichiers HDR (`isHdrFile`).
   */
  sdr?: boolean;
  /** L'image ré-encodée en H.264 — pour un décodeur HEVC annoncé mais défaillant. */
  videoH264Only?: boolean;
}

/** Le débit visé par la conversion en SDR : un 1080p confortable. */
const SDR_BITRATE = 20_000_000;

export class PlaybackRefused extends Error {
  constructor(
    message: string,
    public code: string | null,
    public status: number
  ) {
    super(message);
    this.name = "PlaybackRefused";
  }
}

export async function negotiate(itemId: string, options: NegotiateOptions = {}): Promise<Negotiation> {
  const codecSupport = await detectCodecSupport();
  const body = {
    itemId,
    maxBitrate: options.sdr ? Math.min(pickMaxBitrate(), SDR_BITRATE) : pickMaxBitrate(),
    ...(options.sdr ? { lighter: true } : {}),
    startTicks: options.resumeAt ? Math.floor(options.resumeAt * 10_000_000) : undefined,
    codecSupport,
    disableAudioCodecs: [],
    // Deux canaux au plus, toujours. Le son finit en une seule source posée sur la télévision : un 5.1
    // serait transcodé puis remélangé ici, pour rien. Ce champ de la route plafonne le profil à la
    // stéréo (`reencodeAudio: "stereo"` dans `buildDeviceProfile`) : une piste stéréo lisible est
    // copiée, tout le reste est ré-encodé en AAC stéréo par Jellyfin.
    forceAudioTranscode: true,
    ...(options.audioStreamIndex !== undefined ? { audioStreamIndex: options.audioStreamIndex } : {}),
    ...(options.videoH264Only ? { videoH264Only: true } : {}),
    forCast: false,
    // Toujours hls.js ici, même sur WebKit : le HLS natif ne donne ni texture fiable ni son au
    // graphe audio. La route peut donc sauter son préchauffage du manifeste.
    nativeHls: false,
  };
  const res = await api("/api/jellyfin/playback/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const failure = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new PlaybackRefused(failure?.error ?? `négociation refusée (${res.status})`, failure?.code ?? null, res.status);
  }
  return (await res.json()) as Negotiation;
}

/** Une image est HDR dès que Jellyfin lui donne une plage autre que SDR (HDR10, HDR10+, HLG, Dolby Vision). */
export function isHdrRange(rangeType: string | null | undefined): boolean {
  return !!rangeType && rangeType !== "SDR";
}

/**
 * Ce fichier est-il HDR ? Lu dans la description du fichier que le lecteur de l'application demande
 * lui-même (`/api/jellyfin/direct/<id>`, qui donne `video.isHdr`) : la question est posée **avant** de
 * négocier, pour ne pas lancer une séance qu'il faudrait refermer aussitôt. `null` si la réponse
 * manque — la plage que rend la négociation tranche alors (`playback.ts`).
 */
export async function isHdrFile(itemId: string): Promise<boolean | null> {
  try {
    const info = await apiJson<{ video?: { isHdr?: boolean; rangeType?: string | null } | null }>(`/api/jellyfin/direct/${itemId}`);
    if (!info.video) return null;
    return typeof info.video.isHdr === "boolean" ? info.video.isHdr : isHdrRange(info.video.rangeType);
  } catch (error) {
    if (error instanceof SessionExpired) throw error;
    return null;
  }
}

/**
 * La série d'un épisode (`/api/player/item/<id>`, la route du menu « Épisodes » du lecteur) ; `null` pour un
 * film, un titre hors des droits du compte, ou une route qui ne répond pas — il n'y a alors rien à enchaîner.
 */
export async function seriesOf(itemId: string): Promise<string | null> {
  try {
    const item = await apiJson<{ seriesId?: string | null }>(`/api/player/item/${itemId}`);
    return typeof item.seriesId === "string" && item.seriesId ? item.seriesId : null;
  } catch (error) {
    if (error instanceof SessionExpired) throw error;
    return null;
  }
}

export interface PlaybackState {
  resumeSeconds: number;
}

/** Où le compte s'est arrêté dans ce titre (0 : jamais commencé, ou terminé). */
export async function resumePosition(itemId: string): Promise<number> {
  try {
    const state = await apiJson<PlaybackState>(`/api/jellyfin/playback-state/${itemId}`);
    return Number.isFinite(state.resumeSeconds) && state.resumeSeconds > 0 ? state.resumeSeconds : 0;
  } catch {
    return 0;
  }
}

export interface ReportTarget {
  itemId: string;
  playSessionId: string;
  mediaSourceId: string;
  playMethod: PlayMethod;
}

const ticks = (seconds: number) => Math.max(0, Math.floor(seconds * 10_000_000));

/**
 * Les rapports de lecture. `playing` est annoncé par la négociation elle-même (la route le fait) ;
 * restent la position, régulièrement, et l'arrêt.
 *
 * L'arrêt part avec `keepalive` : il doit survivre à la fermeture de la page. Sans lui, Jellyfin
 * garde une séance fantôme et — pour un transcodage — un ffmpeg qui tourne pour personne.
 */
export function reportProgress(target: ReportTarget, position: number, paused: boolean): void {
  void fetch("/api/jellyfin/playback/progress", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...target, positionTicks: ticks(position), isPaused: paused, visible: document.visibilityState === "visible" }),
  }).catch(() => {});
}

export function reportStop(target: ReportTarget, position: number): void {
  void fetch("/api/jellyfin/playback/stop", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemId: target.itemId, playSessionId: target.playSessionId, mediaSourceId: target.mediaSourceId, positionTicks: ticks(position) }),
  }).catch(() => {});
}
