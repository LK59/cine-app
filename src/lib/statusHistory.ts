export type IncidentType = "maintenance" | "incident" | "ongoing";

export interface Incident {
  type: IncidentType;
  start: number; // epoch ms
  end: number | null; // null while still ongoing
  durationMs: number | null;
}

export interface HistoryAnalysis {
  uptimePct: number;
  incidents: Incident[];
}

// A run of bad readings gets classified as routine "maintenance" rather than a real incident
// when it's a single isolated reading bracketed by ok checks close together in time — the
// signature of a container restart/update, not an actual outage. Anything longer or still
// ongoing is a real incident.
const MAINTENANCE_MAX_RUN = 1;
const MAINTENANCE_MAX_SPAN_MULTIPLIER = 3;

export function analyzeHistory(
  rows: { status: string; checkedAt: number }[],
  pollIntervalMs: number
): HistoryAnalysis {
  if (rows.length === 0) return { uptimePct: 100, incidents: [] };

  const okCount = rows.filter((r) => r.status === "ok").length;
  const uptimePct = Math.round((okCount / rows.length) * 1000) / 10;

  const incidents: Incident[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].status === "ok") {
      i++;
      continue;
    }
    const runStart = i;
    while (i < rows.length && rows[i].status !== "ok") i++;
    const runEnd = i - 1; // inclusive
    const runLength = runEnd - runStart + 1;
    const prevOkAt = runStart > 0 ? rows[runStart - 1].checkedAt : rows[runStart].checkedAt;
    const nextOkAt = i < rows.length ? rows[i].checkedAt : null;

    if (nextOkAt === null) {
      incidents.push({ type: "ongoing", start: rows[runStart].checkedAt, end: null, durationMs: null });
      continue;
    }

    const observedSpan = nextOkAt - prevOkAt;
    const isMaintenance = runLength <= MAINTENANCE_MAX_RUN && observedSpan <= MAINTENANCE_MAX_SPAN_MULTIPLIER * pollIntervalMs;

    incidents.push({
      type: isMaintenance ? "maintenance" : "incident",
      start: rows[runStart].checkedAt,
      end: nextOkAt,
      durationMs: observedSpan,
    });
  }

  return { uptimePct, incidents: incidents.reverse() };
}
