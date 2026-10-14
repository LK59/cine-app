import type { JellyfinItem } from "@/lib/clients/jellyfin";
import type { Locale } from "@/lib/i18n";

/**
 * Ce qu'un épisode affiche quand Jellyfin le sait mal (DECISIONS.md §89) — le rangement vient du
 * disque, donc de Jellyfin, mais un fichier qu'il n'a pas su identifier arrive sans numéro, ou sous
 * son nom de fichier (« La Casa de Papel - S04E01 », relevé le 14/10/2026 sur les saisons 4 et 5).
 *
 * - **Pas de numéro** : celui que le nom du fichier porte (`S04E01`), sinon après le dernier de sa
 *   saison — jamais « É0 » en tête de liste, où il passait devant le premier épisode.
 * - **Un titre qui n'en est pas un** — le nom du fichier, le nom de la série : un titre de
 *   remplissage (« Épisode 3 »), que `fillEpisodeText` sait ensuite compléter par TMDB.
 */

/** Le nom de fichier, sans dossier ni extension. */
export function fileStem(path: string | null | undefined): string | null {
  if (!path) return null;
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return name.replace(/\.[a-z0-9]{2,4}$/i, "") || null;
}

/** Le nom de fichier en minuscules, extension comprise — ce que Sonarr et Jellyfin voient tous deux. */
export function fileKey(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() || null;
}

/** Saison et épisode écrits dans le nom du fichier (`S04E01`, `s4e1`), s'il y en a. */
export function episodeNumbersFromPath(path: string | null | undefined): { season: number; episode: number } | null {
  const stem = fileStem(path);
  const match = stem ? /(?:^|[^a-z0-9])s(\d{1,3})[ ._-]?e(\d{1,4})(?![0-9])/i.exec(stem) : null;
  return match ? { season: Number(match[1]), episode: Number(match[2]) } : null;
}

const flat = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Le titre n'est-il que le nom du fichier, ou celui de la série ? */
export function isMeaninglessTitle(title: string | null | undefined, path: string | null | undefined, seriesName: string | null | undefined): boolean {
  if (!title?.trim()) return true;
  const t = flat(title);
  if (!t) return true;
  const stem = fileStem(path);
  if (stem && flat(stem) === t) return true;
  return !!seriesName && flat(seriesName) === t;
}

const PLACEHOLDER_WORD: Record<Locale, string> = { fr: "Épisode", en: "Episode", es: "Episodio", de: "Folge" };

/** « Épisode 3 » dans la langue de qui regarde — reconnu ensuite par `isPlaceholderTitle`. */
export function placeholderEpisodeTitle(episode: number, locale: Locale): string {
  return `${PLACEHOLDER_WORD[locale] ?? PLACEHOLDER_WORD.fr} ${episode}`;
}

export interface ArrangedEpisode {
  item: JellyfinItem;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
}

/**
 * Numéros et titres d'affichage de chaque épisode, dans l'ordre de la liste reçue. Seuls les
 * épisodes sans numéro sont renumérotés — un numéro de Jellyfin n'est jamais remplacé.
 */
export function arrangeEpisodes(items: readonly JellyfinItem[], seriesName: string | null | undefined, locale: Locale): ArrangedEpisode[] {
  const arranged = items.map((item) => {
    const fromFile = episodeNumbersFromPath(item.Path);
    const seasonNumber = item.ParentIndexNumber ?? fromFile?.season ?? 0;
    // Le numéro du fichier ne vaut que pour la saison où Jellyfin a rangé l'épisode.
    const episodeNumber = item.IndexNumber ?? (fromFile && fromFile.season === seasonNumber ? fromFile.episode : null);
    return { item, seasonNumber, episodeNumber };
  });
  // Les épisodes encore sans numéro vont après le dernier de leur saison, dans l'ordre des fichiers.
  const highest = new Map<number, number>();
  for (const a of arranged) if (a.episodeNumber !== null) highest.set(a.seasonNumber, Math.max(highest.get(a.seasonNumber) ?? 0, a.episodeNumber));
  const unnumbered = arranged
    .filter((a) => a.episodeNumber === null)
    .sort((a, b) => (fileStem(a.item.Path) ?? a.item.Name ?? "").localeCompare(fileStem(b.item.Path) ?? b.item.Name ?? "", undefined, { numeric: true }));
  for (const a of unnumbered) {
    const next = (highest.get(a.seasonNumber) ?? 0) + 1;
    highest.set(a.seasonNumber, next);
    a.episodeNumber = next;
  }
  return arranged.map((a) => {
    const episodeNumber = a.episodeNumber!;
    const title = isMeaninglessTitle(a.item.Name, a.item.Path, seriesName) ? placeholderEpisodeTitle(episodeNumber, locale) : a.item.Name;
    return { item: a.item, seasonNumber: a.seasonNumber, episodeNumber, title };
  });
}
