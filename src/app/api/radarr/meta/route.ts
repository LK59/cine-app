import { NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";

export async function GET() {
  try {
    const [qualityProfiles, rootFolders] = await Promise.all([
      radarr.getQualityProfiles(),
      radarr.getRootFolders(),
    ]);
    return NextResponse.json({ qualityProfiles, rootFolders }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
