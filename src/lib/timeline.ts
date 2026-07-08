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

export function dateLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return "Hier";
  if (diff < 7) return `Il y a ${diff} jours`;
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

export function groupByDay(events: ImportEvent[]): { label: string; items: ImportEvent[] }[] {
  const groups: Map<string, ImportEvent[]> = new Map();
  for (const ev of events) {
    const label = dateLabel(ev.date);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(ev);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}
