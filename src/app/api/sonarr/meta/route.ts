import { NextResponse } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";

export async function GET() {
  try {
    const [qualityProfiles, rootFolders] = await Promise.all([
      sonarr.getQualityProfiles(),
      sonarr.getRootFolders(),
    ]);
    return NextResponse.json({ qualityProfiles, rootFolders }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
