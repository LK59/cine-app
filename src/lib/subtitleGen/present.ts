import path from "node:path";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { parseSubtitles } from "@/lib/webcodecs/externalSubtitles";
import type { JellyfinMediaSource, JellyfinMediaStream } from "@/lib/clients/jellyfin";
import { iso639_2, isTargetLanguage } from "./languages";
import { textHash } from "./files";
import { twoLetter } from "./languages";

/**
 * Présenter le sous-titre fini à Jellyfin (DECISIONS.md §69, décidé le 12/10/2026).
 *
 * `POST /Videos/{itemId}/Subtitles` (UploadSubtitleDto : Language, Format, IsForced,
 * IsHearingImpaired, Data en base64 — schéma lu sur l'instance, Jellyfin 12.2.0). Jellyfin écrit le
 * fichier **à côté du film**, sous le nom `<vidéo>.<langue>[.sdh].srt`, puis rafraîchit l'élément :
 * le sous-titre devient une piste voisine comme une autre, vue par tous les clients — et la
 * fonction ne dépend ni de Bazarr ni d'un montage de la bibliothèque dans ce conteneur.
 *
 * La langue part en ISO 639-2 terminologique (`fra`) : Jellyfin 12 rend ce code pour les fichiers
 * voisins, et il donne à notre fichier un autre nom que celui de Bazarr (`.fr.srt`). Un nom déjà
 * pris n'est **jamais** réutilisé : l'envoi écraserait un sous-titre qui n'est pas le nôtre.
 *
 * Reconnaître le nôtre : une piste externe dont le fichier n'existait pas avant l'envoi (la liste
 * en est gardée en base), dans le dossier de la vidéo, au nom attendu. La supprimer exige plus :
 * le chemin mémorisé **et** le même texte, relu chez Jellyfin (`textHash`).
 *
 * Toutes les requêtes passent par `jellyfinAuthHeaders` et la clé d'administration.
 */

export interface ItemSource {
  mediaSourceId: string;
  etag: string | null;
  size: number | null;
  videoPath: string | null;
  streams: JellyfinMediaStream[];
}

const headers = () => jellyfinAuthHeaders(config.jellyfin.apiKey);

/** La source média d'un élément, lue avec la clé d'administration (sans compte). */
export async function fetchItemSource(itemId: string, mediaSourceId: string): Promise<ItemSource | null> {
  const res = await fetch(`${config.jellyfin.url}/Items?Ids=${encodeURIComponent(itemId)}&Fields=MediaSources,Path`, {
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Jellyfin ${res.status}`);
  const body = (await res.json()) as { Items?: { MediaSources?: JellyfinMediaSource[] }[] };
  const source = body.Items?.[0]?.MediaSources?.find((s) => s.Id === mediaSourceId);
  if (!source) return null;
  return {
    mediaSourceId: source.Id,
    etag: source.ETag ?? null,
    size: typeof source.Size === "number" ? source.Size : null,
    videoPath: source.Path ?? null,
    streams: source.MediaStreams ?? [],
  };
}

export function externalSubtitlePaths(streams: JellyfinMediaStream[]): string[] {
  return streams.filter((s) => s.Type === "Subtitle" && s.IsExternal && s.Path).map((s) => s.Path as string);
}

/** Le début du nom que Jellyfin donnera au fichier : `<vidéo sans extension>.<fra>.` */
function expectedPrefix(videoPath: string, target: string): string | null {
  if (!isTargetLanguage(target)) return null;
  const stem = path.posix.basename(videoPath).replace(/\.[^.]+$/, "");
  return `${stem}.${iso639_2(target)}.`;
}

/**
 * Le nom est-il déjà pris par un fichier voisin ? Jellyfin écrirait par-dessus. Le nom exact et sa
 * variante SDH sont vérifiés, dans le dossier de la vidéo.
 */
export function nameTaken(videoPath: string, target: string, hearingImpaired: boolean, existing: string[]): boolean {
  const prefix = expectedPrefix(videoPath, target);
  if (!prefix) return true;
  const dir = path.posix.dirname(videoPath);
  const wanted = new Set([`${prefix}srt`, `${prefix}${hearingImpaired ? "sdh." : ""}srt`].map((n) => path.posix.join(dir, n)));
  return existing.some((p) => wanted.has(p));
}

export interface OurStreamFacts {
  videoPath: string | null;
  target: string;
  /** Les fichiers voisins avant l'envoi : aucun d'eux ne peut être le nôtre. */
  prePaths: string[];
  /** Le chemin reconnu une fois pour toutes, s'il l'a été. */
  knownPath: string | null;
}

/** Cette piste est-elle celle que nous avons fait poser ? */
export function isOurStream(stream: JellyfinMediaStream, facts: OurStreamFacts): boolean {
  if (stream.Type !== "Subtitle" || !stream.IsExternal || !stream.Path) return false;
  if (facts.knownPath) return stream.Path === facts.knownPath;
  if (!facts.videoPath || facts.prePaths.includes(stream.Path)) return false;
  const prefix = expectedPrefix(facts.videoPath, facts.target);
  if (!prefix) return false;
  if (path.posix.dirname(stream.Path) !== path.posix.dirname(facts.videoPath)) return false;
  const name = path.posix.basename(stream.Path);
  if (!name.startsWith(prefix) || !name.toLowerCase().endsWith(".srt")) return false;
  // La langue que Jellyfin a lue doit être la nôtre, si elle en a lu une.
  const lang = twoLetter(stream.Language);
  return lang === null || lang === facts.target;
}

export async function uploadSubtitle(itemId: string, target: string, hearingImpaired: boolean, srt: string): Promise<void> {
  if (!isTargetLanguage(target)) throw new Error("langue cible inconnue");
  const res = await fetch(`${config.jellyfin.url}/Videos/${encodeURIComponent(itemId)}/Subtitles`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({
      Language: iso639_2(target),
      Format: "srt",
      IsForced: false,
      IsHearingImpaired: hearingImpaired,
      Data: Buffer.from(srt, "utf8").toString("base64"),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`envoi refusé (${res.status})`);
}

/** Demander à Jellyfin de relire l'élément, quand le fichier tarde à apparaître dans ses pistes. */
export async function refreshItem(itemId: string): Promise<void> {
  await fetch(`${config.jellyfin.url}/Items/${encodeURIComponent(itemId)}/Refresh?MetadataRefreshMode=Default&ImageRefreshMode=None`, {
    method: "POST",
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

/** Le texte d'une piste tel que Jellyfin le sert, réduit à son empreinte. */
export async function streamTextHash(itemId: string, mediaSourceId: string, index: number): Promise<string | null> {
  const res = await fetch(`${config.jellyfin.url}/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/Stream.vtt`, {
    headers: headers(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return null;
  return textHash(parseSubtitles(await res.text()).map((c) => c.text));
}

export async function deleteSubtitle(itemId: string, index: number): Promise<boolean> {
  const res = await fetch(`${config.jellyfin.url}/Videos/${encodeURIComponent(itemId)}/Subtitles/${index}`, {
    method: "DELETE",
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok;
}
