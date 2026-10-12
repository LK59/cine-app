import crypto from "node:crypto";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { isForcedTrack, titleSaysHearingImpaired, trackLanguage } from "@/lib/trackPreferences";
import { parseSubtitles } from "@/lib/webcodecs/externalSubtitles";
import type { JellyfinMediaStream } from "@/lib/clients/jellyfin";

/**
 * D'où vient le texte qu'on traduit (DECISIONS.md §69).
 *
 * Seulement une piste **texte** du titre, intérieure au fichier ou posée à côté : une piste image
 * (PGS, VobSub) n'a rien à lire. Jamais une piste forcée — elle ne couvre que quelques passages.
 * Mais les drapeaux mentent dans les deux sens : *Soy Luna* a un SDH complet marqué « forcé », et
 * *Wonka* trente-six pistes sans langue. Le drapeau ne sert donc qu'à l'ordre ; ce qui décide est
 * le **nombre de répliques** rapporté à la durée (`isFullTrack`), mesuré une fois la piste lue.
 */

/** Ce que Jellyfin sait rendre en WebVTT. Le reste est une image. Lu aussi par la route `direct`. */
export const TEXT_SUBTITLE_FORMATS = new Set(["srt", "subrip", "ass", "ssa", "vtt", "webvtt", "mov_text"]);

export interface SourceCandidate {
  index: number;
  external: boolean;
  /** Code à deux lettres, ou null : une piste sans langue, vérifiée par l'IA à la préparation. */
  language: string | null;
  /** Ce que disent le drapeau ou le titre — un indice, pas un verdict. */
  forcedFlag: boolean;
  hearingImpaired: boolean;
  /** Le chemin d'un fichier voisin, pour reconnaître le nôtre une fois posé par Jellyfin. */
  path: string | null;
}

export function isTextSubtitle(stream: Pick<JellyfinMediaStream, "Type" | "Codec" | "IsTextSubtitleStream">): boolean {
  if (stream.Type !== "Subtitle") return false;
  return TEXT_SUBTITLE_FORMATS.has((stream.Codec ?? "").toLowerCase()) || stream.IsTextSubtitleStream === true;
}

export function candidateOf(stream: JellyfinMediaStream): SourceCandidate {
  const named = { language: stream.Language ?? null, name: stream.Title ?? stream.DisplayTitle ?? null, isDefault: false, isForced: stream.IsForced === true };
  return {
    index: stream.Index,
    external: stream.IsExternal === true,
    language: trackLanguage(named),
    forcedFlag: isForcedTrack(named),
    hearingImpaired: stream.IsHearingImpaired === true || titleSaysHearingImpaired(named.name),
    path: stream.Path ?? null,
  };
}

/**
 * Les pistes texte, dans l'ordre où on les essaie : la langue de l'audio d'origine, puis l'anglais
 * complet, puis les SDH de ces deux langues, puis les autres langues, puis les pistes sans langue,
 * et les pistes marquées forcées en dernier — essayées quand même, au cas où le drapeau mente.
 * La langue cible est exclue : si elle existe, il n'y a rien à générer.
 */
export function orderCandidates(streams: JellyfinMediaStream[], target: string, original: string | null): SourceCandidate[] {
  const rank = (c: SourceCandidate): number => {
    let r: number;
    if (c.language === null) r = 6;
    else if (c.language === original) r = c.hearingImpaired ? 2 : 0;
    else if (c.language === "en") r = c.hearingImpaired ? 3 : 1;
    else r = c.hearingImpaired ? 5 : 4;
    return (c.forcedFlag ? 10 : 0) + r;
  };
  return streams
    .filter(isTextSubtitle)
    .map(candidateOf)
    .filter((c) => c.language !== target)
    .map((c, order) => ({ c, order, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.order - b.order)
    .map((x) => x.c);
}

/** Les langues déjà là en complet, d'après ce que disent les pistes texte (sans les lire). */
export function presentLanguages(streams: JellyfinMediaStream[]): string[] {
  const out = new Set<string>();
  for (const s of streams) {
    if (!isTextSubtitle(s)) continue;
    const c = candidateOf(s);
    if (c.language && !c.forcedFlag) out.add(c.language);
  }
  return [...out];
}

/** Seuils mesurés sur la bibliothèque : un sous-titre complet compte de 5 à 15 répliques par minute. */
const MIN_CUES = 50;
const MIN_PER_MINUTE = 2;

/**
 * Une piste lue est-elle complète ? Assez de répliques en tout, et assez par minute du titre — un
 * vrai forcé d'un film très parlé dans une autre langue peut compter 150 lignes, mais sur deux
 * heures. Sans durée connue, l'étendue des répliques en tient lieu.
 */
export function isFullTrack(cueCount: number, runtimeSeconds: number | null, lastCueEnd: number): boolean {
  if (cueCount < MIN_CUES) return false;
  const minutes = Math.max(1, (runtimeSeconds && runtimeSeconds > 0 ? runtimeSeconds : lastCueEnd) / 60);
  return cueCount / minutes >= MIN_PER_MINUTE;
}

export interface SourceCue {
  start: number;
  end: number;
  text: string;
}

/** L'empreinte d'un sous-titre source : son texte et ses minutages, rien d'autre. */
export function sourceHash(cues: SourceCue[]): string {
  const h = crypto.createHash("sha256");
  for (const c of cues) h.update(`${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text}\n`);
  return h.digest("hex").slice(0, 32);
}

/**
 * Lire une piste par Jellyfin, qui la convertit en WebVTT — intérieure ou voisine, la même adresse.
 * Une piste intérieure à un Matroska est extraite du fichier entier : 14 s mesurées sur *Dans ses
 * yeux* (12/10/2026), d'où le délai large. Jamais sur le chemin d'une requête : à la préparation.
 */
export async function fetchSourceCues(itemId: string, mediaSourceId: string, index: number, fetchImpl: typeof fetch = fetch): Promise<SourceCue[]> {
  const url = `${config.jellyfin.url}/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/Stream.vtt`;
  const res = await fetchImpl(url, { headers: jellyfinAuthHeaders(config.jellyfin.apiKey), signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`piste ${index} illisible (${res.status})`);
  return parseSubtitles(await res.text()).map((c) => ({ start: c.startSeconds, end: c.endSeconds, text: c.text }));
}
