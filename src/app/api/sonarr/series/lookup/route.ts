import { NextRequest } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest) {
  const term = req.nextUrl.searchParams.get("term") || "";
  return withErrorHandling(() => sonarr.lookupSeries(term));
}
