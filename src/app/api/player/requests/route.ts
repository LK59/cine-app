import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { createTmdbClient } from "@/lib/clients/tmdb";
import { getTmdbLocale, LOCALE_COOKIE } from "@/lib/i18n";
import { withErrorHandling } from "@/lib/api-helpers";
import { getPlayerRequests, type PlayerRequest } from "@/lib/playerRequests";
import { pendingRequestDb } from "@/lib/db";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export interface PlayerRequestsPayload {
  requests: PlayerRequest[];
}

export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  if (!config.jellyseerr.apiKey) return NextResponse.json({ requests: [] });

  return withErrorHandling(async () => ({ requests: await getPlayerRequests(session) }), "player-requests");
}

/**
 * Demander un titre — un seul geste, sans choix à faire.
 *
 * Côté série, Jellyseerr exige la liste des saisons et plante sans elle (constaté en production).
 * L'interface end-user n'a pas de sélecteur de saisons, et c'est délibéré : on demande une série,
 * pas un sous-ensemble. Les saisons sont donc résolues ici, saison 0 exclue — c'est le fourre-tout
 * des bonus et des hors-séries, que personne ne veut recevoir en demandant une série.
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  if (!config.jellyseerr.apiKey) {
    return NextResponse.json({ error: "Les demandes ne sont pas disponibles" }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  const type = body?.type === "series" ? "series" : body?.type === "movie" ? "movie" : null;
  const tmdbId = Number(body?.tmdbId);
  if (!type || !Number.isFinite(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }

  return withErrorHandling(async () => {
    let seasons: number[] | undefined;
    if (type === "series") {
      const media = await jellyseerr.getTvMedia(tmdbId, session.jsCookie).catch(() => null);
      seasons = (media?.seasons ?? []).map((s) => s.seasonNumber).filter((n) => n > 0);
      if (seasons.length === 0) {
        // Jellyseerr n'a pas répondu : TMDB sait aussi combien de saisons existent, et une série
        // sans saison connue vaut mieux demandée à la saison 1 que pas demandée du tout.
        const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get(LOCALE_COOKIE)?.value));
        const detail = tmdb.isEnabled() ? await tmdb.getTv(tmdbId).catch(() => null) : null;
        const count = detail?.number_of_seasons ?? 1;
        seasons = Array.from({ length: Math.max(1, count) }, (_, i) => i + 1);
      }
    }

    const result = await jellyseerr.createRequest(
      type === "movie" ? "movie" : "tv",
      tmdbId,
      undefined,
      session.jsCookie,
      seasons
    );

    // Ce qui permettra de prévenir cette personne — et elle seule — quand le fichier arrivera,
    // sans avoir à redemander à Jellyseerr de qui était la demande.
    if (session.u) pendingRequestDb.add(session.u, type, tmdbId, seasons ?? null);
    return result;
  }, "player-request-create");
}
