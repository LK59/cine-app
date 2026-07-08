import { NextRequest, NextResponse } from "next/server";
import { tmdb, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { withCache } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export interface PersonPhoto {
  filePath: string;    // full URL w780
  fullPath: string;    // full URL original
  aspectRatio: number;
  voteAverage: number;
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const personId = Number(params.id);
  if (!tmdb.isEnabled()) return NextResponse.json({ photos: [] });

  const photos = await withCache<PersonPhoto[]>(`person:photos:${personId}`, 24 * 60 * 60_000, async () => {
    const data = await tmdb.getPersonImages(personId).catch(() => ({ profiles: [] }));
    return (data.profiles ?? [])
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 24)
      .map((p) => ({
        filePath: `${TMDB_IMAGE_BASE}/w780${p.file_path}`,
        fullPath: `${TMDB_IMAGE_BASE}/original${p.file_path}`,
        aspectRatio: p.width / p.height,
        voteAverage: p.vote_average,
      }));
  });

  return NextResponse.json({ photos });
}
