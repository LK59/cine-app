import { NextRequest } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest) {
  const start = req.nextUrl.searchParams.get("start") ?? "";
  const end = req.nextUrl.searchParams.get("end") ?? "";
  return withErrorHandling(() => sonarr.getCalendar(start, end));
}
