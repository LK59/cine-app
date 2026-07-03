import { NextRequest } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return withErrorHandling(() => radarr.searchReleases(Number(params.id)));
}
