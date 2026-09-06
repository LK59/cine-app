// hour12: false rather than relying on the browser locale to pick 24h — the locale can still be
// en-US-flavored (region/OS setting) even when the app itself is in French, which otherwise
// silently reintroduces AM/PM.
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

/** Formats a Date/timestamp/ISO string as a 24h HH:MM time, regardless of the browser's locale/region. */
export function fmtTime(d: Date | number | string): string {
  return new Date(d).toLocaleTimeString([], TIME_OPTS);
}

/** Formats a Date/timestamp/ISO string as a 24h date + time, regardless of the browser's locale/region. */
export function fmtDateTime(d: Date | number | string): string {
  return new Date(d).toLocaleString([], { ...TIME_OPTS, day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Formats Jellyfin ticks (100ns units) into a resume-point label (e.g. "23min05", "1h04min12") */
export function formatResumeTicks(ticks: number): string {
  const totalSeconds = Math.floor(ticks / 10_000_000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}min${ss}` : `${m}min${ss}`;
}

/** Formats Jellyfin ticks (100ns units) into a short, minute-precision duration (e.g. "1h10",
 *  "30min") — no seconds, unlike formatResumeTicks: this is for a REMAINING-time label (Cinema
 *  Mode's Continue Watching cards), where second-level precision would be noise. */
export function formatDurationShort(ticks: number): string {
  const totalMinutes = Math.round(ticks / 10_000_000 / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

/**
 * Une durée en minutes, dite comme on la dit : « 1h10 », pas « 70 min ».
 *
 * Au-delà d'une heure, personne ne compte en minutes — un épisode de 70 min oblige à faire la
 * division soi-même pour savoir ce qu'on s'engage à regarder. En dessous, la minute reste la
 * bonne unité et « 0h45 » serait une coquetterie.
 */
export function formatMinutes(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

/** Formats a qBittorrent ETA in seconds into a short label — qBittorrent uses 8640000 (100 days)
 *  as a sentinel for "no estimate" (seeding, stalled, paused), which reads as "—" instead of days. */
export function fmtEta(seconds: number): string {
  if (!seconds || seconds <= 0 || seconds >= 8640000) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}`;
  if (m > 0) return `${m}min`;
  return `${seconds % 60}s`;
}

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
