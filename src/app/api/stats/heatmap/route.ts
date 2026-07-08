import { NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { withCache } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export interface HeatmapData {
  days: { date: string; count: number }[];
  max: number;
}

const KEEP_RADARR = new Set(["grabbed", "downloadFolderImported", "movieFolderImported"]);
const KEEP_SONARR = new Set(["grabbed", "downloadFolderImported"]);

export async function GET() {
  const data = await withCache<HeatmapData>("heatmap:365", 30 * 60_000, async () => {
    const cutoff = new Date(Date.now() - 365 * 24 * 3600_000);

    const [radarrHist, sonarrHist] = await Promise.all([
      radarr.getHistory(1000).catch(() => ({ records: [] })),
      sonarr.getHistory(1000).catch(() => ({ records: [] })),
    ]);

    const byDay = new Map<string, number>();

    for (const r of radarrHist.records) {
      if (!KEEP_RADARR.has(r.eventType)) continue;
      if (!r.date) continue;
      const d = new Date(r.date);
      if (d < cutoff) continue;
      const key = d.toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }

    for (const r of sonarrHist.records) {
      if (!KEEP_SONARR.has(r.eventType)) continue;
      if (!r.date) continue;
      const d = new Date(r.date);
      if (d < cutoff) continue;
      const key = d.toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }

    // Fill all 365 days including zeros
    const days: { date: string; count: number }[] = [];
    const now = new Date();
    for (let i = 364; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({ date: key, count: byDay.get(key) ?? 0 });
    }

    const max = Math.max(1, ...days.map((d) => d.count));
    return { days, max };
  });

  return NextResponse.json(data);
}
