import { NextRequest } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const seasonNumber = req.nextUrl.searchParams.get("seasonNumber");
  const episodeId = req.nextUrl.searchParams.get("episodeId");
  return withErrorHandling(() =>
    sonarr.searchReleases({
      seriesId: Number(params.id),
      seasonNumber: seasonNumber !== null ? Number(seasonNumber) : undefined,
      episodeId: episodeId !== null ? Number(episodeId) : undefined,
    })
  );
}
