import { NextRequest, NextResponse } from "next/server";
import { getStorageStats, type StorageStats } from "@/lib/storage-scan";

export type { StorageStats };

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
  return NextResponse.json(getStorageStats(forceRefresh));
}
