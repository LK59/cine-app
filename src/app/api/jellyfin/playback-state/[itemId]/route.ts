import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { jellyfin } from "@/lib/clients/jellyfin";
import type { TrackPreferences } from "@/lib/trackPreferences";

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
}

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

export async function GET(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  if (!JELLYFIN_ID_RE.test(itemId)) return new NextResponse(null, { status: 400 });

  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  // Sans identité Jellyfin — l'administrateur local — il n'y a ni position ni préférences, et
  // c'est une réponse valable : le film s'ouvre à son début, sur ses pistes par défaut.
  if (!session?.jfId) {
    return NextResponse.json<PlaybackState>({ resumeSeconds: 0, preferences: null });
  }

  // Les deux en parallèle, et chacune tolérante à son propre échec. Un serveur qui refuse de dire
  // dans quelle langue quelqu'un regarde est une raison d'ouvrir le fichier sur ses défauts, pas
  // une raison de ne pas le lire — c'est déjà le raisonnement que tenait l'ancienne route.
  const [item, configuration] = await Promise.all([
    jellyfin.getItemUserData(session.jfId, itemId).catch(() => null),
    session.jfToken
      ? jellyfin
          .getUserConfiguration(session.jfId, session.jfToken)
          .then((user) => user.Configuration ?? null)
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  return NextResponse.json<PlaybackState>({
    resumeSeconds: (item?.UserData?.PlaybackPositionTicks ?? 0) / 10_000_000,
    preferences: configuration
      ? {
          audioLanguage: configuration.AudioLanguagePreference ?? null,
          subtitleLanguage: configuration.SubtitleLanguagePreference ?? null,
          subtitleMode: (configuration.SubtitleMode as TrackPreferences["subtitleMode"]) ?? null,
          playDefaultAudioTrack: configuration.PlayDefaultAudioTrack === true,
        }
      : null,
  });
}
