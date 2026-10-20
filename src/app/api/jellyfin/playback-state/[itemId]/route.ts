import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { jellyfin } from "@/lib/clients/jellyfin";
import type { TrackPreferences } from "@/lib/trackPreferences";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { UpstreamUnreachableError, UPSTREAM_UNREACHABLE } from "@/lib/http";
import { seriesPreferredLanguage } from "@/lib/seriesLanguage";

/**
 * Ce qui change entre deux lectures du même fichier — et rien d'autre.
 *
 * Ces deux champs vivaient dans `/api/jellyfin/direct/[itemId]`, avec la description du fichier :
 * l'URL du flux, le conteneur, les codecs, les pistes. Or ces deux natures n'ont pas la même durée
 * de vie. La description ne bouge jamais, et le lecteur la garde en mémoire pour rouvrir un film
 * instantanément. La position et les préférences, elles, changent tout le temps — et se
 * retrouvaient gelées avec le reste jusqu'au rechargement de la page.
 *
 * Deux symptômes, l'un franc et l'autre rare :
 *
 * - Changer sa langue de sous-titres dans « Compte » puis relancer un film déjà lu dans la même
 *   session appliquait l'ancienne langue. À tous les coups. Le réglage semblait ne pas marcher.
 * - Lancer un film avant que l'interface ait fini d'apprendre où l'on en était pouvait le
 *   reprendre à une position d'il y a une heure.
 *
 * Pourquoi une route à part plutôt qu'une revalidation de l'autre : la description du fichier est
 * ce dont dépend la construction de tout le pipeline de lecture. La rafraîchir en cours de film le
 * reconstruirait — et comme elle contenait la position, que le lecteur met à jour toutes les dix
 * secondes, elle se serait invalidée toute seule en boucle. Le fichier et le spectateur ne se
 * demandent donc plus dans la même question.
 */
export interface PlaybackState {
  /** Où reprendre, en secondes. Zéro quand le film n'a jamais été commencé. */
  resumeSeconds: number;
  /** Les langues que le compte demande, ou `null` si Jellyfin n'a pas répondu. */
  preferences: TrackPreferences | null;
  /**
   * Posé côté client seulement (`fetchPlaybackState`) quand la route a répondu 502
   * `upstream_unreachable` : `resumeSeconds` ne vaut alors rien, et le lecteur n'ouvre pas à zéro.
   */
  positionUnknown?: true;
}

export async function GET(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  if (!isJellyfinId(itemId)) return new NextResponse(null, { status: 400 });

  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  // Sans identité Jellyfin — l'administrateur local — il n'y a ni position ni préférences, et
  // c'est une réponse valable : le film s'ouvre à son début, sur ses pistes par défaut.
  if (!session?.jfId) {
    return NextResponse.json<PlaybackState>({ resumeSeconds: 0, preferences: null });
  }

  // Les deux en parallèle, et chacune tolérante à son propre échec. Un serveur qui refuse de dire
  // dans quelle langue quelqu'un regarde est une raison d'ouvrir le fichier sur ses défauts, pas
  // une raison de ne pas le lire — c'est déjà le raisonnement que tenait l'ancienne route.
  //
  // Sauf la position quand Jellyfin est injoignable (14/10/2026, relecture de §92) : répondre zéro,
  // c'était affirmer « jamais commencé » — le lecteur ouvrait au début et ses rapports de progression
  // effaçaient la reprise chez Jellyfin dès son retour. Un 502 nommé dit « position inconnue », et
  // les deux lecteurs n'ouvrent pas à zéro sur une telle réponse (`playbackPrefetch.ts`,
  // `resolveResumeAt`). Une autre erreur (élément refusé, réponse illisible) garde l'ancienne règle.
  let unreachable: UpstreamUnreachableError | null = null;
  const [item, configuration] = await Promise.all([
    jellyfin.getItemUserData(session.jfId, itemId).catch((err: unknown) => {
      if (err instanceof UpstreamUnreachableError) unreachable = err;
      return null;
    }),
    session.jfToken
      ? jellyfin
          .getUserConfiguration(session.jfId, session.jfToken)
          .then((user) => user.Configuration ?? null)
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  if (unreachable) {
    return NextResponse.json({ error: (unreachable as UpstreamUnreachableError).message, code: UPSTREAM_UNREACHABLE }, { status: 502 });
  }

  // La langue retenue pour cette série (`seriesLanguage.ts`) passe avant celle du compte : deux
  // épisodes passés à la main vers la même langue ont dit ce que ce compte veut pour elle. Une
  // lecture de la base qui échoue laisse la préférence du compte, comme avant.
  let seriesLanguage: string | null = null;
  if (item?.Type === "Episode" && item.SeriesId && session.u) {
    try {
      seriesLanguage = seriesPreferredLanguage(session.u, item.SeriesId);
    } catch {
      seriesLanguage = null;
    }
  }

  return NextResponse.json<PlaybackState>({
    resumeSeconds: (item?.UserData?.PlaybackPositionTicks ?? 0) / 10_000_000,
    preferences: configuration
      ? {
          audioLanguage: seriesLanguage ?? configuration.AudioLanguagePreference ?? null,
          subtitleLanguage: configuration.SubtitleLanguagePreference ?? null,
          subtitleMode: (configuration.SubtitleMode as TrackPreferences["subtitleMode"]) ?? null,
          // Une langue retenue pour la série n'est pas à céder à la piste par défaut du fichier.
          playDefaultAudioTrack: seriesLanguage === null && configuration.PlayDefaultAudioTrack === true,
        }
      : null,
  });
}
