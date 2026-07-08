import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { withCache } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export interface HeatmapData {
  days: { date: string; count: number }[];
  max: number;
}

export async function GET() {
  const data = await withCache<HeatmapData>("heatmap:365", 30 * 60_000, async () => {
    const db = getDb();
    const cutoff = Date.now() - 365 * 24 * 3600_000;
    const rows = db.prepare(`
      SELECT date(event_date / 1000, 'unixepoch') AS day, COUNT(*) AS count
      FROM timeline_events
      WHERE event_date > ?
      GROUP BY day
      ORDER BY day ASC
    `).all(cutoff) as { day: string; count: number }[];

    const byDay = new Map(rows.map((r) => [r.day, r.count]));
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
