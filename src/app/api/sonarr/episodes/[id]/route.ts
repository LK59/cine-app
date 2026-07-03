import { NextRequest } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const payload = await req.json();
  return withErrorHandling(() => sonarr.updateEpisode(Number(params.id), payload));
}
