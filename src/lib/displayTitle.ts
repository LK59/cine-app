/**
 * What to write across the top of the player.
 *
 * Built from what Jellyfin knows about the item rather than from what the caller passed, because
 * the callers do not agree: eight places open the player and each hands over whatever title it
 * had to hand — which for an episode is usually the series, or usually the episode, depending on
 * which list the viewer happened to click. Deriving it here means every one of them is right,
 * including the next one somebody adds.
 */

export interface NamedItem {
  Name?: string | null;
  Type?: string | null;
  SeriesName?: string | null;
  /** The season. Zero is not missing — it is where a server keeps specials. */
  ParentIndexNumber?: number | null;
  IndexNumber?: number | null;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "S02E05", or null when the server does not number this episode. */
export function episodeCode(item: NamedItem): string | null {
  const season = item.ParentIndexNumber;
  const episode = item.IndexNumber;
  if (typeof episode !== "number") return null;
  return typeof season === "number" ? `S${pad(season)}E${pad(episode)}` : `E${pad(episode)}`;
}

/**
 * "La Petite Maison dans la prairie — S00E01 · La Genèse", and the shorter forms a file with
 * less metadata can support. Anything that is not an episode is simply its own name.
 */
export function displayTitle(item: NamedItem | null | undefined, fallback: string): string {
  if (!item) return fallback;
  const own = item.Name?.trim() || null;
  if (item.Type !== "Episode" || !item.SeriesName) return own ?? fallback;

  const code = episodeCode(item);
  // The series name always leads: it is what the viewer went looking for, and on a small screen
  // it is the half that survives being cut off.
  const tail = [code, own].filter(Boolean).join(" · ");
  return tail ? `${item.SeriesName} — ${tail}` : item.SeriesName;
}
