import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { readFullLines, readRecords } from "@/lib/activity/logReader";
import { buildSeances } from "@/lib/activity/seances";

export const dynamic = "force-dynamic";

/**
 * Une séance de lecture, ligne par ligne et en entier : la chronologie de ce qu'a vécu le lecteur,
 * traces comprises. Une séance d'avant le 23/09/2026 (sans identifiant) est retrouvée par son
 * compte, son titre et ses bornes.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const { id } = await params;
  const records = readRecords("player");
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
    : records.filter((r) => r.session === id);
  const lines = readFullLines("player", mine.map((r) => ({ file: r._file, line: r._line })));
  const stamp = (l: Record<string, unknown>) => Date.parse(String(l.timestamp ?? "")) || 0;
  lines.sort((a, b) => stamp(a) - stamp(b));
  return NextResponse.json({ seance, lines });
}
