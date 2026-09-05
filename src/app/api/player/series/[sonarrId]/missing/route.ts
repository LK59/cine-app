import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { sonarr } from "@/lib/clients/sonarr";
import { withCache, TTL } from "@/lib/server-cache";
import { withErrorHandling } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export interface MissingEpisode {
  /** L'identifiant Sonarr de l'épisode — ce qu'il faut pour lancer sa recherche. */
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  /** ISO, ou `null` quand la date n'est pas annoncée. */
  airDate: string | null;
  /** Diffusé : c'est ce qui décide si l'on peut demander ou non. */
  released: boolean;
}

export interface MissingSeason {
  seasonNumber: number;
  episodes: MissingEpisode[];
  /** Au moins un épisode diffusé et absent : la saison entière vaut la peine d'être demandée. */
  requestable: boolean;
}

export interface MissingPayload {
  seasons: MissingSeason[];
}

/**
 * Ce qui manque à une série, saison par saison.
 *
 * L'écran des épisodes se construit à partir de Jellyfin, qui ne connaît par définition que ce
 * qu'on possède : un épisode absent n'y existe pas du tout, et une saison entière manquante non
 * plus. Sonarr, lui, connaît la grille complète — et c'est aussi lui qui ira la chercher, ce qui
 * en fait la bonne source. TMDB dirait la même chose, mais il faudrait ensuite faire coïncider sa
 * numérotation avec celle de Sonarr pour lancer quoi que ce soit.
 *
 * La saison 0 est écartée : c'est le fourre-tout des bonus et des hors-séries, que personne ne
 * cherche en demandant une série.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ sonarrId: string }> }) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const seriesId = Number.parseInt((await props.params).sonarrId, 10);
  if (!Number.isFinite(seriesId) || seriesId <= 0) {
    return NextResponse.json({ error: "Série introuvable" }, { status: 400 });
  }

  return withErrorHandling(async () => {
    const now = Date.now();
    // Mise en cache : cette liste est demandée à chaque ouverture d'une fiche de série, et elle
    // ne bouge qu'au rythme des téléchargements. Quinze secondes suffisent à ce qu'un aller-retour
    // entre deux fiches ne réinterroge pas Sonarr.
    const episodes = await withCache(`sonarr:episodes:${seriesId}`, TTL.SHORT, () =>
      sonarr.getEpisodes(seriesId)
    );

    const bySeason = new Map<number, MissingEpisode[]>();
    for (const ep of episodes) {
      if (ep.hasFile || ep.seasonNumber === 0) continue;
      const airDate = ep.airDateUtc || ep.airDate || null;
      (bySeason.get(ep.seasonNumber) ?? bySeason.set(ep.seasonNumber, []).get(ep.seasonNumber)!).push({
        id: ep.id,
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
        title: ep.title,
        airDate,
        // Une date absente veut dire « pas encore annoncé », donc pas encore diffusé. Une date
        // illisible ne doit rien bloquer : on la considère passée.
        released: airDate ? Date.parse(airDate) <= now || Number.isNaN(Date.parse(airDate)) : false,
      });
    }

    const seasons: MissingSeason[] = [...bySeason.entries()]
      .map(([seasonNumber, eps]) => ({
        seasonNumber,
        episodes: eps.sort((a, b) => a.episodeNumber - b.episodeNumber),
        requestable: eps.some((e) => e.released),
      }))
      .sort((a, b) => a.seasonNumber - b.seasonNumber);

    return { seasons } satisfies MissingPayload;
  }, "player-series-missing");
}
