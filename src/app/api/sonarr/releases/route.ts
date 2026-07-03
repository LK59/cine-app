import { NextRequest, NextResponse } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { guid, indexerId } = body ?? {};
  if (!guid || !indexerId) return NextResponse.json({ error: "guid et indexerId requis" }, { status: 400 });
  return withErrorHandling(() => sonarr.grabRelease(guid, indexerId));
}
