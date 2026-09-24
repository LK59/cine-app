import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { reportsDb } from "@/lib/db";
import { summarize, whoIs } from "@/lib/reports";

export const dynamic = "force-dynamic";

/** Tous les signalements envoyés, pour l'administrateur — jamais les brouillons. */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const who = whoIs(session);
  const reports = reportsDb.listSent().map((r) => summarize(r, who, "admin"));
  return NextResponse.json({ reports, unread: reportsDb.unreadForAdmin() });
}
