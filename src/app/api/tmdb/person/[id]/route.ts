import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { playableLibrary } from "@/lib/playerLibrary";
import { withErrorHandling } from "@/lib/api-helpers";
import { withPersistentCache } from "@/lib/server-cache";

/**
 * Une semaine, sur disque (23/09/2026) : une fiche personne coûtait deux appels à TMDB à chaque
 * ouverture, et une filmographie ne change pas d'un jour à l'autre. Seules les réponses de TMDB
 * sont gardées — ce qui est dans la bibliothèque est recalculé à chaque fois, pour qu'un film
 * arrivé hier y apparaisse aujourd'hui. Un échec n'est pas gardé (voir `withPersistentCache`).
 */
const WEEK_MS = 7 * 24 * 3600_000;

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const locale = getTmdbLocale(req.cookies.get("cine-lang")?.value);
  const tmdb = createTmdbClient(locale);
  const personId = Number(params.id);
  if (!personId) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  if (!tmdb.isEnabled()) return NextResponse.json({ credits: [] });

  return withErrorHandling(async () => {
    const [personFr, { cast }, lib] = await Promise.all([
      withPersistentCache(`tmdb:person:details:${locale}:${personId}`, WEEK_MS, () => tmdb.getPersonDetails(personId)).catch(() => null),
      withPersistentCache(`tmdb:person:credits:${locale}:${personId}`, WEEK_MS, () => tmdb.getPersonCredits(personId)),
      // Ouvrable, et pas seulement connu de Radarr/Sonarr : une filmographie est pleine de titres
      // surveillés sans fichier, et les annoncer comme présents menait à un clic qui ne faisait
      // rien. Voir playableLibrary.
      playableLibrary(),
    ]);

    // If TMDB has no French biography, fall back to English
    const person =
      personFr?.biography
        ? personFr
        : await tmdb.getPersonDetails(personId).catch(() => personFr);

    const movieByTmdb = new Map([...lib.movies].map(([tmdbId, m]) => [tmdbId, m.id]));
    const seriesByTmdb = new Map([...lib.series].map(([tmdbId, s]) => [tmdbId, s.id]));

    // Deduplicate (same title can appear as multiple roles), keep highest popularity
    const seen = new Map<string, (typeof cast)[0]>();
    for (const c of cast) {
      const key = `${c.media_type}:${c.id}`;
      const existing = seen.get(key);
      if (!existing || c.popularity > existing.popularity) seen.set(key, c);
    }

    const credits = [...seen.values()]
      .map((c) => {
        const isMovie = c.media_type === "movie";
        const libraryId = isMovie ? movieByTmdb.get(c.id) : seriesByTmdb.get(c.id);
        return {
          tmdbId: c.id,
          title: (isMovie ? c.title : c.name) ?? "",
          year: new Date((isMovie ? c.release_date : c.first_air_date) ?? "").getFullYear() || null,
          posterPath: c.poster_path,
          mediaType: c.media_type,
          character: c.character,
          voteAverage: c.vote_average,
          inLibrary: Boolean(libraryId),
          libraryHref: libraryId
            ? isMovie ? `/radarr/${libraryId}` : `/sonarr/${libraryId}`
            : null,
          // Le même identifiant, nu : le lecteur ouvre une fiche par son id, pas par une adresse
          // de la partie gestion — et il ne doit surtout pas avoir à découper une URL pour ça.
          libraryId: libraryId ?? null,
        };
      })
      .sort((a, b) => {
        if (a.inLibrary !== b.inLibrary) return a.inLibrary ? -1 : 1;
        return b.voteAverage - a.voteAverage;
      });

    return {
      credits,
      name: personFr?.name ?? null,
      profilePath: personFr?.profile_path ?? null,
      biography: person?.biography ?? null,
      birthday: person?.birthday ?? null,
      deathday: person?.deathday ?? null,
      placeOfBirth: person?.place_of_birth ?? null,
      knownFor: person?.known_for_department ?? null,
    };
  });
}
