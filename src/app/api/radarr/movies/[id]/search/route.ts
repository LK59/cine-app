import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const movieId = Number(params.id);
  if (!movieId) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  return withErrorHandling(() => radarr.triggerSearch(movieId));
}
