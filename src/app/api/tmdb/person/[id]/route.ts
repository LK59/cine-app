import { NextRequest, NextResponse } from "next/server";
import { errorBody, renameNotFound } from "@/lib/apiErrorCodes";
import { verifySessionFull } from "@/lib/session";
import { SESSION_COOKIE } from "@/lib/auth";
import { createTmdbClient } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { withErrorHandling } from "@/lib/api-helpers";
import { personCreditsCached, personDetailsCached, personFilmography, personWithBiography } from "@/lib/tmdbPerson";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const locale = getTmdbLocale(req.cookies.get("cine-lang")?.value);
  const tmdb = createTmdbClient(locale);
  const personId = Number(params.id);
  if (!personId) return NextResponse.json(errorBody("Invalid ID", "invalid_request"), { status: 400 });
  if (!tmdb.isEnabled()) return NextResponse.json({ credits: [] });

  // Le chemin est partagé avec le panneau d'une personne d'« À l'écran » (`src/lib/tmdbPerson.ts`) :
  // mêmes appels, mêmes clés de cache, même repli de la biographie, mêmes titres cachés.
  return withErrorHandling(async () => {
    const [personFr, { cast }] = await Promise.all([
      personDetailsCached(tmdb, locale, personId),
      // Une personne inconnue de TMDB (lien ancien) : « Personne introuvable », pas le corps de TMDB
      // — voir `renameNotFound` (ROBUSTESSE-7).
      renameNotFound(personCreditsCached(tmdb, locale, personId), "Personne introuvable", "person_not_found"),
    ]);
    const person = await personWithBiography(personFr, locale, personId);
    const credits = await personFilmography(cast, (await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value))?.jfId);
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
