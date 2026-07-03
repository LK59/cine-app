import { NextRequest } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { cachedSeries } from "@/lib/server-cache";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(() => cachedSeries());
}

export async function POST(req: NextRequest) {
  const payload = await req.json();
  return withErrorHandling(() => sonarr.addSeries(payload));
}
