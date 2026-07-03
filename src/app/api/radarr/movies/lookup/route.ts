import { NextRequest } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest) {
  const term = req.nextUrl.searchParams.get("term") || "";
  return withErrorHandling(() => radarr.lookupMovie(term));
}
