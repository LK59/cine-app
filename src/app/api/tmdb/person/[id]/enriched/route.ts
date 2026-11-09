import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient } from "@/lib/clients/tmdb";
import { getTmdbLocale, LOCALES } from "@/lib/i18n";
import { EMPTY_ENRICHED, enrichedPerson, type EnrichedPersonData } from "@/lib/tmdbPerson";

export type { EnrichedPersonData };

/**
 * Photos, liens et biographie de Wikipédia d'une personne. Le travail et son cache d'une semaine sont
 * dans `enrichedPerson` (`src/lib/tmdbPerson.ts`), partagé avec le panneau d'une personne d'« À
 * l'écran » (DECISIONS.md §138).
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // Une langue connue ou le français : la valeur du cookie entre dans la clé de cache, et une
  // valeur libre permettait de fabriquer autant d'entrées — et d'appels à TMDB — qu'on voulait.
  const cookieLang = req.cookies.get("cine-lang")?.value ?? "fr";
  const rawLang = (LOCALES as string[]).includes(cookieLang) ? cookieLang : "fr";
  const tmdb = createTmdbClient(getTmdbLocale(rawLang));
  const personId = Number(params.id);
  if (!personId || !tmdb.isEnabled()) return NextResponse.json<EnrichedPersonData>({ ...EMPTY_ENRICHED });
  return NextResponse.json(await enrichedPerson(tmdb, rawLang, personId));
}
