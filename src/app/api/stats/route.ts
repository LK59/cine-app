import { NextResponse } from "next/server";
import { getDiskStats } from "@/lib/disk-stats";

export const dynamic = "force-dynamic";

export async function GET() {
  const { moviesBytes, tvBytes, disk } = getDiskStats();
  return NextResponse.json({ moviesBytes, tvBytes, disk });
}
