import { NextRequest, NextResponse } from "next/server";
import { tmdb, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { withPersistentCache } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export interface PersonPhoto {
  filePath: string;    // full URL w780
  fullPath: string;    // full URL original
  aspectRatio: number;
  voteAverage: number;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const personId = Number(params.id);
  if (!tmdb.isEnabled()) return NextResponse.json({ photos: [] });

  // Une semaine, sur disque. L'échec n'est plus transformé en liste vide *dans* le cache : gardée
  // une semaine, une coupure réseau aurait laissé l'acteur sans photos pendant sept jours.
  const photos = await withPersistentCache<PersonPhoto[]>(`person:photos:${personId}`, 7 * 24 * 3600_000, async () => {
    const data = await tmdb.getPersonImages(personId);
    return (data.profiles ?? [])
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 24)
      .map((p) => ({
        filePath: `${TMDB_IMAGE_BASE}/w780${p.file_path}`,
        fullPath: `${TMDB_IMAGE_BASE}/original${p.file_path}`,
        aspectRatio: p.width / p.height,
        voteAverage: p.vote_average,
      }));
  }).catch(() => [] as PersonPhoto[]);

  return NextResponse.json({ photos });
}
