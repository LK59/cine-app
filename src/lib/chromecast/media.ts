/**
 * Ce qu'on demande au récepteur de lire, et comment lire ce qu'il répond — DECISIONS.md §64.
 *
 * Des fonctions pures, et c'est voulu : aucun appareil Cast n'est là pour les éprouver, donc ce
 * qu'elles décident — l'adresse, le type annoncé, la position, les pistes, le sens d'un code
 * d'erreur — se vérifie ici, sans récepteur (`chromecast-media.test.ts`). Seule la traduction en
 * objets du kit (`toLoadRequest`) touche à Google, et elle ne décide rien.
 */

import type { CastGlobals } from "./framework";

/** Une piste de sous-titres telle que la négociation la décrit (`/api/jellyfin/playback/start`). */
export interface ChromecastSubtitleFacts {
  index: number;
  url: string;
  label: string;
  language: string | null;
  /** `false` : une piste en images (PGS…), que le serveur doit incruster. `null` : inconnu. */
  isText: boolean | null;
}

/** La demande de chargement, en données — traduite par `toLoadRequest`. */
export interface ChromecastMediaSpec {
  url: string;
  contentType: string;
  hls: boolean;
  title: string;
  startSeconds: number;
  /** Les pistes texte, chargées à côté du flux ; on les allume sans relancer la lecture. */
  textTracks: { trackId: number; url: string; name: string; language: string | null }[];
  activeTrackIds: number[];
}

/**
 * L'identifiant d'une piste de sous-titres chez le récepteur : un entier strictement positif, et
 * stable — l'index du flux chez Jellyfin, plus un (l'index 0 existe, l'identifiant 0 non).
 */
export function subtitleTrackId(index: number): number {
  return index + 1;
}

/**
 * Une piste que le récepteur sait afficher lui-même — du texte. Inconnu (`null`) compte comme du
 * texte : Jellyfin le sert en WebVTT de toute façon (`External`), et se tromper dans ce sens donne
 * au pire une piste vide, jamais une image transcodée pour rien.
 */
export function isSideLoadable(track: Pick<ChromecastSubtitleFacts, "isText">): boolean {
  return track.isText !== false;
}

/**
 * La demande de chargement d'un flux négocié pour le Chromecast.
 *
 * - L'adresse est celle que le serveur a signée (`castUrl`) : absolue, avec son laissez-passer.
 * - Le type annoncé dit au récepteur quel lecteur prendre : HLS pour un flux transcodé ou
 *   remultiplexé, MP4 pour un fichier servi tel quel.
 * - Les sous-titres texte voyagent à côté, avec des adresses rendues absolues sur l'origine de la
 *   page : ce sont les mêmes que celles du lecteur serveur, laissez-passer compris.
 * - Le sous-titre choisi n'est allumé que s'il est en texte : une piste en images est déjà dans
 *   l'image (incrustée à la négociation), il n'y a rien à allumer.
 */
export function chromecastMediaSpec(args: {
  castUrl: string;
  isDirectPlay: boolean;
  title: string;
  startSeconds: number;
  subtitles: ChromecastSubtitleFacts[];
  selectedSubtitle: number | null;
  origin: string;
}): ChromecastMediaSpec {
  const textTracks = args.subtitles.filter(isSideLoadable).map((st) => ({
    trackId: subtitleTrackId(st.index),
    url: new URL(st.url, args.origin).toString(),
    name: st.label,
    language: st.language,
  }));
  const selected = args.selectedSubtitle === null ? null : args.subtitles.find((st) => st.index === args.selectedSubtitle) ?? null;
  return {
    url: args.castUrl,
    contentType: args.isDirectPlay ? "video/mp4" : "application/x-mpegurl",
    hls: !args.isDirectPlay,
    title: args.title,
    startSeconds: Math.max(0, Number.isFinite(args.startSeconds) ? args.startSeconds : 0),
    textTracks,
    activeTrackIds: selected && isSideLoadable(selected) ? [subtitleTrackId(selected.index)] : [],
  };
}

/** Traduit la demande en objets du kit. Ne décide rien — voir `chromecastMediaSpec`. */
export function toLoadRequest(cast: CastGlobals["chromeCast"], spec: ChromecastMediaSpec): Record<string, unknown> {
  const media = cast.media;
  const info = new media.MediaInfo(spec.url, spec.contentType);
  info.streamType = media.StreamType.BUFFERED;
  if (spec.hls) {
    // Jellyfin produit du HLS en fMP4 (`buildChromecastProfile`). Sans le dire, le récepteur
    // suppose des segments MPEG-TS et échoue au premier.
    if (media.HlsSegmentFormat) info.hlsSegmentFormat = media.HlsSegmentFormat.FMP4;
    if (media.HlsVideoSegmentFormat) info.hlsVideoSegmentFormat = media.HlsVideoSegmentFormat.FMP4;
  }
  const metadata = new media.GenericMediaMetadata();
  metadata.title = spec.title;
  info.metadata = metadata;
  info.tracks = spec.textTracks.map((t) => {
    const track = new media.Track(t.trackId, media.TrackType.TEXT);
    track.trackContentId = t.url;
    track.trackContentType = "text/vtt";
    track.subtype = media.TextTrackType.SUBTITLES;
    track.name = t.name;
    if (t.language) track.language = t.language;
    return track;
  });
  const request = new media.LoadRequest(info);
  request.currentTime = spec.startSeconds;
  request.autoplay = true;
  request.activeTrackIds = spec.activeTrackIds;
  return request;
}

/**
 * Pourquoi le récepteur s'est arrêté, d'après son `idleReason`.
 *
 * `finished` : la fin du film ; `error` : il n'a pas pu lire (format, réseau, adresse refusée) ;
 * `stopped` : arrêté de l'extérieur (télécommande, autre appareil) ; `interrupted` : un autre média
 * a pris sa place. `null` : pas un arrêt.
 */
export type ChromecastIdleOutcome = "finished" | "error" | "stopped" | "interrupted";

export function idleOutcome(idleReason: string | null | undefined): ChromecastIdleOutcome | null {
  switch (idleReason) {
    case "FINISHED":
      return "finished";
    case "ERROR":
      return "error";
    case "CANCELLED":
      return "stopped";
    case "INTERRUPTED":
      return "interrupted";
    default:
      return null;
  }
}

/**
 * Le code d'erreur du kit, dit en mots pour le journal — la page Activité les lit tels quels.
 * Un code inconnu est gardé tel quel plutôt que tu.
 */
const CAST_ERROR_REASONS: Record<string, string> = {
  cancel: "liste des récepteurs fermée sans choix",
  timeout: "le récepteur n'a pas répondu à temps",
  api_not_initialized: "kit Cast non initialisé",
  invalid_parameter: "demande refusée par le kit (paramètre invalide)",
  extension_not_compatible: "navigateur incompatible",
  receiver_unavailable: "récepteur indisponible",
  session_error: "session impossible à ouvrir ou perdue",
  channel_error: "liaison avec le récepteur perdue",
  load_media_failed: "le récepteur n'a pas pu charger le flux",
};

export function chromecastErrorReason(code: string): string {
  return CAST_ERROR_REASONS[code] ?? `erreur Cast : ${code}`;
}
