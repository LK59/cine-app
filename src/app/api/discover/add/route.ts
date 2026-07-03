import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { invalidateLibrary } from "@/lib/server-cache";

function vfProfile(profiles: { id: number; name: string }[]) {
  return (
    profiles.find((p) => p.name.toLowerCase().includes("vf")) ?? profiles[0]
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const type = body?.type as "movie" | "series" | undefined;
  const tmdbId = body?.tmdbId as number | undefined;

  if (!type || !tmdbId) {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }

  try {
    if (type === "movie") {
      const [results, profiles, folders] = await Promise.all([
        radarr.lookupMovie(`tmdb:${tmdbId}`),
        radarr.getQualityProfiles(),
        radarr.getRootFolders(),
      ]);

      const movie = results[0];
      if (!movie) return NextResponse.json({ error: "Film introuvable sur TMDB" }, { status: 404 });

      if (movie.id) return NextResponse.json({ radarrId: movie.id });

      const added = await radarr.addMovie({
        ...movie,
        qualityProfileId: vfProfile(profiles)?.id,
        rootFolderPath: folders[0]?.path,
        monitored: true,
        addOptions: { searchForMovie: false },
      });
      invalidateLibrary();
      return NextResponse.json({ radarrId: added.id });
    }

    if (type === "series") {
      const [results, profiles, folders] = await Promise.all([
        sonarr.lookupSeries(`tmdb:${tmdbId}`),
        sonarr.getQualityProfiles(),
        sonarr.getRootFolders(),
      ]);

      const series = results[0];
      if (!series) return NextResponse.json({ error: "Série introuvable sur TMDB" }, { status: 404 });

      if (series.id) return NextResponse.json({ sonarrId: series.id });

      const added = await sonarr.addSeries({
        ...series,
        qualityProfileId: vfProfile(profiles)?.id,
        rootFolderPath: folders[0]?.path,
        monitored: true,
        addOptions: { searchForMissingEpisodes: false },
      });
      invalidateLibrary();
      return NextResponse.json({ sonarrId: added.id });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur" },
      { status: 502 }
    );
  }
}
