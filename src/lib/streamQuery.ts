import { logError } from "@/lib/logger";

/**
 * Les paramètres qu'une requête du relais de flux peut porter jusqu'à Jellyfin.
 *
 * Revue de sécurité du 20/10/2026 : le relais (`/api/jellyfin/stream/…`) recopiait n'importe quelle
 * chaîne de requête vers Jellyfin, signée de la clé d'administration. Les paramètres d'un
 * transcodage — débit, définition, codecs — étaient donc ceux que le navigateur voulait, sans la
 * politique que Jellyfin applique au compte. La liste reste **large** exprès (décision du
 * propriétaire) : tout ce que les points HLS, `stream.*` et sous-titres de Jellyfin comprennent et
 * que ses propres adresses (`TranscodingUrl`, manifestes, listes de sous-titres) écrivent, pour
 * qu'aucune lecture ne casse. Ce qui borne vraiment l'abus est le nombre de transcodages par compte
 * (`transcodeBudget.ts`) ; cette liste retire ce que Jellyfin n'a aucune raison de recevoir de nous
 * (`CpuCoreLimit`, `LiveStreamId`, `UserId`, et `Params`, l’ancienne forme qui empaquette tous les autres
 * en un seul et contournerait la liste).
 *
 * Noms comparés sans la casse : Jellyfin (ASP.NET) lie ses paramètres ainsi, et ses adresses
 * mélangent `MediaSourceId` et `mediaSourceId`.
 */
const ALLOWED = new Set(
  [
    // Identité de la lecture.
    "MediaSourceId", "PlaySessionId", "DeviceId", "DeviceProfileId", "Tag", "static", "Container", "Context",
    // Codecs et pistes.
    "VideoCodec", "AudioCodec", "SubtitleCodec", "AudioStreamIndex", "VideoStreamIndex", "SubtitleStreamIndex", "SubtitleMethod",
    // Débits, définition, cadence, profondeur.
    "VideoBitrate", "AudioBitrate", "MaxStreamingBitrate", "Width", "Height", "MaxWidth", "MaxHeight", "Framerate", "MaxFramerate",
    "MaxVideoBitDepth", "MaxRefFrames", "Profile", "Level", "AudioChannels", "MaxAudioChannels", "TranscodingMaxAudioChannels",
    "AudioSampleRate", "MaxAudioBitDepth", "EnableAudioVbrEncoding",
    // Segmentation HLS.
    "SegmentContainer", "SegmentLength", "MinSegments", "BreakOnNonKeyFrames", "runtimeTicks", "actualSegmentLengthTicks",
    "EnableAdaptiveBitrateStreaming", "EnableTrickplay", "EnableMpegtsM2TsMode",
    // Contraintes et copie.
    "RequireAvc", "RequireNonAnamorphic", "DeInterlace", "TranscodeReasons", "EnableAutoStreamCopy", "AllowVideoStreamCopy",
    "AllowAudioStreamCopy", "CopyTimestamps", "StartTimeTicks",
    // Sous-titres.
    "EnableSubtitlesInManifest", "AlwaysBurnInSubtitleWhenTranscoding", "AddVttTimeMap", "StartPositionTicks", "EndPositionTicks",
    "Index", "Format",
  ].map((name) => name.toLowerCase())
);

/** Les options propres à un codec que Jellyfin écrit dans ses adresses : `h264-profile`, `hevc-rangetype`, `aac-audiochannels`… */
const CODEC_OPTION = /^[a-z0-9]+-[a-z0-9]+$/i;

/**
 * Retirés en amont par le relais lui-même (laissez-passer, jetons) : jamais « écartés » au journal,
 * puisque leur absence est voulue — voir `withoutCastToken` et `stripAccessToken`.
 */
const SILENT = new Set(["casttoken", "api_key", "apikey"]);

export function isAllowedStreamParam(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED.has(lower) || CODEC_OPTION.test(name);
}

function decodedName(pair: string): string {
  const raw = pair.split("=", 1)[0].replace(/\+/g, " ");
  try {
    return decodeURIComponent(raw);
  } catch {
    // Un `%` mal formé : un nom que rien n'accepte, donc écarté.
    return raw;
  }
}

export interface FilteredStreamQuery {
  /** La chaîne à envoyer, `?…` ou vide — les paires gardées le sont octet pour octet. */
  search: string;
  /** Les paramètres gardés, décodés, au premier exemplaire de chaque nom (sans la casse). */
  params: Map<string, string>;
  /** Les noms écartés parce qu'inconnus (les jetons retirés exprès n'y sont pas). */
  dropped: string[];
}

/**
 * La chaîne de requête réduite aux paramètres permis.
 *
 * Les paires gardées ne sont ni décodées ni réencodées : la chaîne part telle que Jellyfin l'a
 * écrite. Un nom répété (`PlaySessionId=a&playsessionid=b`) ne garde que son premier exemplaire —
 * celui que Jellyfin lit —, pour que le relais et lui ne comptent jamais deux séances différentes.
 */
export function filterStreamQuery(search: string): FilteredStreamQuery {
  const body = search.startsWith("?") ? search.slice(1) : search;
  const kept: string[] = [];
  const params = new Map<string, string>();
  const dropped: string[] = [];
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const name = decodedName(pair);
    const lower = name.toLowerCase();
    if (!isAllowedStreamParam(name)) {
      if (!SILENT.has(lower)) dropped.push(name);
      continue;
    }
    if (params.has(lower)) continue;
    const rawValue = pair.includes("=") ? pair.slice(pair.indexOf("=") + 1) : "";
    let value: string;
    try {
      value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    } catch {
      value = rawValue;
    }
    params.set(lower, value);
    kept.push(pair);
  }
  return { search: kept.length ? `?${kept.join("&")}` : "", params, dropped };
}

/**
 * Chaque nom écarté, journalisé une fois par processus (`server.log`, `stream.param-dropped`) : si
 * Jellyfin se met à écrire un paramètre que la liste ne connaît pas et qu'une lecture casse, la
 * ligne dit lequel. La valeur n'est jamais écrite — elle pourrait être un secret. Le nombre de noms
 * retenus est borné : un client qui invente des noms en boucle ne fait pas grossir la mémoire.
 */
const LOGGED_KEY = Symbol.for("cine-app.streamParamDropped");
const MAX_LOGGED_NAMES = 500;

export function logDroppedStreamParams(dropped: string[], context: Record<string, unknown>): void {
  if (dropped.length === 0) return;
  const holder = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  const logged = (holder[LOGGED_KEY] ??= new Set());
  for (const raw of dropped) {
    const name = raw.slice(0, 64);
    const key = name.toLowerCase();
    if (logged.has(key) || logged.size >= MAX_LOGGED_NAMES) continue;
    logged.add(key);
    logError("stream.param-dropped", `Paramètre de flux écarté : ${name}`, { param: name, ...context });
  }
}

/** Pour les tests. */
export function resetDroppedStreamParamLog(): void {
  (globalThis as unknown as Record<symbol, Set<string> | undefined>)[LOGGED_KEY]?.clear();
}
