// Le journal des suppressions du tri (DECISIONS.md §198), dans `cine.db` : ce qui est parti, quand, à la
// demande de qui, et l'espace effectivement rendu. Il survit aux redéploiements, contrairement à
// `docker logs`.
import { getDb } from "@/lib/db";
import type { TriRemoval } from "./types";

export function recordRemoval(entry: TriRemoval): void {
  getDb().prepare("INSERT INTO tri_removals (at, entry) VALUES (?, ?)").run(Date.parse(entry.at) || Date.now(), JSON.stringify(entry));
}

export function listRemovals(limit = 200): TriRemoval[] {
  const rows = getDb().prepare("SELECT entry FROM tri_removals ORDER BY at DESC, id DESC LIMIT ?").all(limit) as { entry: string }[];
  const out: TriRemoval[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.entry) as TriRemoval);
    } catch {
      // Une ligne illisible ne cache pas les autres.
    }
  }
  return out;
}

export function freedTotal(): number {
  let total = 0;
  for (const r of listRemovals(100_000)) total += r.freedBytes ?? 0;
  return total;
}
