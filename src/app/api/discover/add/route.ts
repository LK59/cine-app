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

      // Unmonitored: this add is always immediately followed by an interactive search the user
      // can abandon without picking anything — reported live as leaving a monitored, empty entry
      // that Radarr kept auto-searching for indefinitely. Grabbing a release (see
      // /api/radarr/releases) flips this back to monitored; abandoning it just leaves an inert
      // entry instead of one that keeps hitting indexers for nothing.
      const added = await radarr.addMovie({
        ...movie,
        qualityProfileId: vfProfile(profiles)?.id,
        rootFolderPath: folders[0]?.path,
        monitored: false,
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

      // Monitored (unlike the movie branch above): this is now only ever called from the
      // deliberate "Ajouter" action, not paired with an immediate interactive search a user
      // could abandon — the orphan-risk this whole unmonitored pattern exists for doesn't apply
      // here. Per-season interactive/automatic search happen afterward, on the series' own sheet.
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

    // Unreachable in practice — the guard above narrows `type` to "movie" | "series" — but the
    // two ifs don't say so, and without this the function has a path that falls off the end and
    // returns nothing at all. A route handler that resolves to undefined is a 500 with no
    // message; an explicit 400 is both honest and typed.
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur" },
      { status: 502 }
    );
  }
}
