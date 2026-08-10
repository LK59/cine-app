export interface ImportEvent {
  id: string;
  date: string;
  type: "movie" | "series";
  title: string;
  detail: string | null;
  posterPath: string | null;
  href: string | null;
  source: "radarr" | "sonarr";
  eventKind: "import" | "grab";
}

type TFn = (key: string, vars?: Record<string, string | number>) => string;

export function dateLabel(dateStr: string, t: TFn, dateLocale: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  if (diff === 0) return t("timeline.dateLabel.today");
  if (diff === 1) return t("timeline.dateLabel.yesterday");
  if (diff < 7) return t("timeline.dateLabel.daysAgo", { n: diff });
  return d.toLocaleDateString(dateLocale, { weekday: "long", day: "numeric", month: "long" });
}

export function groupByDay(events: ImportEvent[], t: TFn, dateLocale: string): { label: string; items: ImportEvent[] }[] {
  const groups: Map<string, ImportEvent[]> = new Map();
  for (const ev of events) {
    const label = dateLabel(ev.date, t, dateLocale);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(ev);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}
