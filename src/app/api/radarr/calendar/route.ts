import { NextRequest } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest) {
  const start = req.nextUrl.searchParams.get("start") ?? "";
  const end = req.nextUrl.searchParams.get("end") ?? "";
  return withErrorHandling(() => radarr.getCalendar(start, end));
}
