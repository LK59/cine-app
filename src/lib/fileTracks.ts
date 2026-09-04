import { normaliseLanguage } from "@/lib/trackPreferences";

/**
 * Ce qu'un fichier contient vraiment, dit avec les mots de Jellyfin.
 *
 * La carte Fichier décrivait ses pistes avec ce que renvoie Bazarr : un nom de langue, `forced`
 * et `hi`. Vérifié en direct sur cette bibliothèque, quatre pistes d'un même film reviennent
 * alors « English, English, French, French », toutes à `forced=false, hi=false` — quatre
 * vignettes rigoureusement identiques dont deux sont des doublons apparents. L'information qui
 * les sépare existe pourtant : elle est dans le conteneur, et Jellyfin l'expose (`MediaStreams`)
 * — c'est déjà elle que le lecteur utilise pour construire son sélecteur de pistes. La fiche en
 * savait donc moins que le lecteur sur le même fichier.
 */
export interface FileTrack {
  /** Code de langue réduit — "fr", "en" — ou null quand la piste n'en déclare pas. */
  language: string | null;
  /** Le nom que la piste se donne, quand il ajoute quelque chose au reste. */
  title: string | null;
  codec: string | null;
  channels: number | null;
  forced: boolean;
  hearingImpaired: boolean;
  /** Dolby Atmos : le seul attribut audio qu'aucun nom de codec ne porte. */
  atmos: boolean;
  isDefault: boolean;
  /** Fichier posé à côté du film (un .srt) plutôt que piste du conteneur. */
  external: boolean;
}

export interface FileTracks {
  audio: FileTrack[];
  subtitles: FileTrack[];
}

/** La forme d'un flux Jellyfin, réduite à ce qui sert ici. */
export interface RawStream {
  Type?: string;
  Language?: string;
  Title?: string;
  DisplayTitle?: string;
  Codec?: string;
  Channels?: number;
  IsForced?: boolean;
  IsDefault?: boolean;
  IsExternal?: boolean;
  IsHearingImpaired?: boolean;
}

const HEARING_IMPAIRED = /\b(sdh|hi|hoh|malentendant|hearing)\b/i;
const FORCED = /\bforc(e|é|ed)s?\b/i;

/**
 * Les noms de codecs, dits d'une seule façon.
 *
 * Radarr renvoie « x265 », qui est le nom d'un encodeur et non celui d'un codec ; le lecteur et
 * son panneau disent « hevc ». Deux mots pour la même chose sur deux écrans de la même app.
 */
export function prettyCodec(codec: string | null | undefined): string | null {
  if (!codec) return null;
  const c = codec.trim().toLowerCase();
  if (/^(x265|hevc|h\.?265)$/.test(c)) return "HEVC";
  if (/^(x264|avc|h\.?264)$/.test(c)) return "H.264";
  if (/^av1$/.test(c)) return "AV1";
  if (/^vp9$/.test(c)) return "VP9";
  if (/^mpeg-?2(video)?$/.test(c)) return "MPEG-2";
  if (/^eac3$/.test(c)) return "EAC3";
  if (/^ac3$/.test(c)) return "AC3";
  if (/^truehd$/.test(c)) return "TrueHD";
  if (/^dts.*$/.test(c)) return codec.toUpperCase();
  if (/^opus$/.test(c)) return "Opus";
  if (/^subrip$/.test(c)) return "SRT";
  if (/^pgssub$/.test(c)) return "PGS";
  if (/^ass|ssa$/.test(c)) return c.toUpperCase();
  return codec.toUpperCase();
}

/** 6 canaux se dit « 5.1 » partout sauf dans un JSON. */
export function channelLayout(channels: number | null | undefined): string | null {
  if (!channels) return null;
  if (channels === 1) return "1.0";
  if (channels === 2) return "2.0";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  return `${channels} ch`;
}

/**
 * Le nom propre d'une piste, ou rien.
 *
 * Jellyfin recompose un `DisplayTitle` qui répète la langue, le codec et « Default » — tout ce
 * que la vignette affiche déjà par ailleurs. On ne garde donc que le `Title` du conteneur, et
 * seulement s'il dit autre chose que la langue elle-même.
 */
function ownTitle(stream: RawStream, language: string | null): string | null {
  const raw = (stream.Title ?? "").trim();
  if (!raw) return null;
  const bare = raw.toLowerCase().replace(/[()[\]]/g, " ").replace(/\s+/g, " ").trim();
  if (language && (bare === language || bare.startsWith(`${language} `))) {
    const rest = raw.slice(language.length).replace(/^[\s(:_-]+/, "").replace(/[)\]]+$/, "").trim();
    return rest || null;
  }
  return raw;
}

function toTrack(stream: RawStream): FileTrack {
  const language = normaliseLanguage(stream.Language);
  const title = ownTitle(stream, language);
  const said = `${stream.Title ?? ""} ${stream.DisplayTitle ?? ""}`;
  return {
    language,
    title,
    codec: prettyCodec(stream.Codec),
    channels: stream.Channels ?? null,
    // Le drapeau du conteneur d'abord ; à défaut ce que la piste dit d'elle-même, parce que
    // beaucoup de fichiers ne posent pas le drapeau et écrivent « forced » dans le nom.
    forced: stream.IsForced === true || FORCED.test(said),
    hearingImpaired: stream.IsHearingImpaired === true || HEARING_IMPAIRED.test(said),
    atmos: /\batmos\b/i.test(said),
    isDefault: stream.IsDefault === true,
    external: stream.IsExternal === true,
  };
}

export function describeFileTracks(streams: RawStream[]): FileTracks {
  return {
    audio: streams.filter((s) => s.Type === "Audio").map(toTrack),
    subtitles: streams.filter((s) => s.Type === "Subtitle").map(toTrack),
  };
}
