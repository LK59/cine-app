/** Formats a byte count into a human-readable string (e.g. 1.4 GB) */
export function fmtSize(bytes: number): string {
  if (bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** Relative time from an ISO date string (e.g. "il y a 3 j") */
export function relativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  if (days < 365) return `il y a ${Math.floor(days / 30)} mois`;
  const years = Math.floor(days / 365);
  return `il y a ${years} an${years > 1 ? "s" : ""}`;
}

/** Relative time from a Unix timestamp (ms) */
export function relativeTimeAbs(ts: number): string {
  return relativeTime(new Date(ts).toISOString());
}

/** Relative time from an optional ISO date string, returns "—" if undefined */
export function relDate(iso?: string | null): string {
  if (!iso) return "—";
  return relativeTime(iso);
}

// ─── Bio selection ────────────────────────────────────────────────────────────

function isFrench(text: string): boolean {
  // Heuristic: common French function words / inflections
  const hits = (text.match(/\b(né|née|est|dans|les|des|une|son|sa|ses|qui|avec|pour|par|au|du|il|elle|leur|cette|être|avoir|aussi|plus|mais|dont|sur|comme|après|avant)\b/gi) ?? []).length;
  const words = text.split(/\s+/).length;
  return words > 10 && hits / words > 0.06;
}

/**
 * Pick the best biography between a TMDb bio and a Wikipedia bio.
 * Rules (in order):
 *   1. French > non-French, regardless of length
 *   2. Among bios of the same language: longer wins (TMDb wins on tie)
 */
export function selectBio(
  tmdbBio: string | null | undefined,
  wikiBio: string | null | undefined
): { text: string; source: "tmdb" | "wikipedia" } | null {
  const t = tmdbBio?.trim() || null;
  const w = wikiBio?.trim() || null;
  if (!t && !w) return null;
  if (!t) return { text: w!, source: "wikipedia" };
  if (!w) return { text: t, source: "tmdb" };

  const tFr = isFrench(t);
  const wFr = isFrench(w);

  if (tFr === wFr) {
    // Same language tier → longer wins, TMDb on tie
    return t.length >= w.length ? { text: t, source: "tmdb" } : { text: w, source: "wikipedia" };
  }
  // Different tiers → French wins
  return tFr ? { text: t, source: "tmdb" } : { text: w, source: "wikipedia" };
}
