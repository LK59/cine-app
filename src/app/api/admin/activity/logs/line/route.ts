import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { LOG_SOURCES, readFullLine, type LogSource } from "@/lib/activity/logReader";

export const dynamic = "force-dynamic";

/** Une ligne en entier — traces et piles comprises, que la liste ne garde pas. */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const q = req.nextUrl.searchParams;
  const source = q.get("source") ?? "";
  const file = q.get("file") ?? "";
  const line = Number(q.get("line"));
  if (!(LOG_SOURCES as string[]).includes(source) || !/^[a-z-]+\.log(\.\d)?$/.test(file) || !Number.isInteger(line) || line < 0) {
    return NextResponse.json({ error: "Ligne introuvable" }, { status: 400 });
  }
  const entry = readFullLine(source as LogSource, file, line);
  if (!entry) return NextResponse.json({ error: "Ligne déplacée par une rotation du journal" }, { status: 404 });
  return NextResponse.json(entry);
}
