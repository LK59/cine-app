import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { generationsNewestFirst, readFullLines, readGenerationRecords, readRecords, type LogRecord } from "@/lib/activity/logReader";
import { buildSeances } from "@/lib/activity/seances";

export const dynamic = "force-dynamic";

/**
 * Une séance de lecture, ligne par ligne et en entier : la chronologie de ce qu'a vécu le lecteur,
 * traces comprises.
 *
 * Les journaux gardent des années : on remonte génération par génération jusqu'à trouver la
 * séance, et on s'arrête à la première génération qui n'en contient plus rien après l'avoir
 * trouvée (une séance peut chevaucher une rotation, jamais deux). Une séance d'avant le 23/09/2026
 * — sans identifiant — porte sa date dans le sien : on relit à partir de là.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const { id } = await params;

  let records: LogRecord[] = [];
  if (id.startsWith("ancienne:")) {
    const start = Number(id.slice(id.lastIndexOf(":") + 1));
    records = Number.isFinite(start) ? readRecords("player", start - 60_000) : [];
  } else {
    const parts: LogRecord[][] = [];
    let found = false;
    for (const { file } of generationsNewestFirst("player")) {
      const mine = readGenerationRecords(file).filter((r) => r.session === id);
      if (mine.length) {
        found = true;
        parts.push(mine);
      } else if (found) break;
    }
    records = parts.reverse().flat();
  }

  const seance = buildSeances(records).find((s) => s.id === id);
  if (!seance) return NextResponse.json({ error: "Séance introuvable" }, { status: 404 });
  const mine = seance.legacy
    ? records.filter(
        (r) =>
          !r.session &&
          String(r.user ?? "") === seance.user &&
          (r.itemId ?? r.title) === (seance.itemId ?? seance.title) &&
          r._t >= seance.start &&
          r._t <= seance.end
      )
    : records;
  const lines = readFullLines("player", mine.map((r) => ({ file: r._file, line: r._line })));
  const stamp = (l: Record<string, unknown>) => Date.parse(String(l.timestamp ?? "")) || 0;
  lines.sort((a, b) => stamp(a) - stamp(b));
  return NextResponse.json({ seance, lines });
}
