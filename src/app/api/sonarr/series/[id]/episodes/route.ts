import { NextRequest } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return withErrorHandling(() => sonarr.getEpisodes(Number(params.id)));
}
