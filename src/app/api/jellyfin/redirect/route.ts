import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

export async function GET(req: NextRequest) {
  const itemId = req.nextUrl.searchParams.get("itemId");
  if (!itemId) {
    return NextResponse.json({ error: "itemId requis" }, { status: 400 });
  }

  const publicBase = config.jellyfin.publicUrl || config.jellyfin.url;
  const base = publicBase.replace(/\/$/, "");
  // No api_key in the URL — Jellyfin uses its own session cookie
  const jellyfinUrl = `${base}/web/index.html#!/details?id=${itemId}`;

  return NextResponse.redirect(jellyfinUrl);
}
