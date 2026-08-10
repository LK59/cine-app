/** Formats a byte count into a human-readable string (e.g. 1.4 GB) */
export function fmtSize(bytes: number): string {
  if (bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** Relative time from an ISO date string (e.g. "il y a 3 j") — pass the current useT() translator. */
export function relativeTime(dateStr: string, t: TFn): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return t("common.time.justNow");
  if (minutes < 60) return t("common.time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("common.time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("common.time.daysAgo", { n: days });
  if (days < 365) return t("common.time.monthsAgo", { n: Math.floor(days / 30) });
  const years = Math.floor(days / 365);
  return years > 1 ? t("common.time.yearsAgo", { n: years }) : t("common.time.yearAgo", { n: years });
}

/** Relative time from a Unix timestamp (ms) */
export function relativeTimeAbs(ts: number, t: TFn): string {
  return relativeTime(new Date(ts).toISOString(), t);
}

/** Relative time from an optional ISO date string, returns "—" if undefined */
export function relDate(iso: string | null | undefined, t: TFn): string {
  if (!iso) return "—";
  return relativeTime(iso, t);
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
