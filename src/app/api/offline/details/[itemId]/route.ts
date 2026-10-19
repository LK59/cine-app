import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { isJellyfinId, jellyfinIdSegment } from "@/lib/jellyfinPath";
import { assertVisible } from "@/lib/itemVisibility";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { passJellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfin } from "@/lib/clients/jellyfin";
import { playerMarkers, type PlayerMarkers } from "@/lib/episodeMarkers";

/**
 * Ce qu'une fiche montre d'un titre, gardé avec son téléchargement pour la fiche hors ligne et
 * l'ouverture de la lecture sans réseau (Louis, 19/10/2026 : « pas de fiche série en full hors
 * ligne ? juste les épisodes bruts ? ») : le résumé, l'année, les genres, et quel titre porte le
 * logo et le grand visuel — la série pour un épisode. Les images se téléchargent ensuite par la
 * route d'images (`kind=logo`, `kind=backdrop`).
 */
/** Ce qu'une fiche dit d'un titre — texte seul : la distribution sans liens ni photos, pour rester légère. */
export interface OfflineFacts {
  overview: string | null;
  year: number | null;
  genres: string[];
  /** Les premiers rôles, leurs noms seulement (six au plus). */
  cast: string[];
}

export interface OfflineDetails extends OfflineFacts {
  /** Le titre dont le logo se demande, s'il en a un. */
  logoItemId: string | null;
  /** Le titre dont le grand visuel se demande, s'il en a un. */
  backdropItemId: string | null;
  /** Pour un épisode : l'affiche de sa série, pour la grille de la page (celle d'un film est déjà gardée). */
  posterItemId: string | null;
  /** Pour un épisode : ce que dit la fiche de sa série. */
  series: OfflineFacts | null;
  /**
   * Les repères de Jellyfin — générique d'ouverture, récap, générique de fin — pour « Passer l'intro »
   * et la carte « Épisode suivant » dès le générique, sans réseau : le lecteur hors ligne ne la
   * montrait qu'à la dernière seconde (Louis, 20/10/2026).
   */
  markers: PlayerMarkers;
}

interface JellyfinItem {
  Id?: string;
  Type?: string;
  Overview?: string;
  ProductionYear?: number;
  Genres?: string[];
  SeriesId?: string;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  People?: { Name?: string; Type?: string }[];
}

function factsOf(item: JellyfinItem): OfflineFacts {
  return {
    overview: item.Overview?.trim() || null,
    year: item.ProductionYear ?? null,
    genres: item.Genres ?? [],
    cast: (item.People ?? [])
      .filter((p) => p.Type === "Actor" && p.Name)
      .slice(0, 6)
      .map((p) => p.Name!),
  };
}

async function readItem(itemId: string): Promise<JellyfinItem | null> {
  const res = await passJellyfinFetch(`${config.jellyfin.url}/Items?ids=${jellyfinIdSegment(itemId)}&fields=Overview,Genres,ProductionYear,People`, {
    headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Jellyfin ${res.status}`);
  const page = (await res.json()) as { Items?: JellyfinItem[] };
  return page.Items?.[0] ?? null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  if (!isJellyfinId(itemId)) return new NextResponse(null, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  // Une session suffit : un administrateur local n'a pas d'identité Jellyfin (`jfId`) et recevait
  // 401, alors que `assertVisible` le laisse passer — c'est elle qui décide de ce que le compte voit.
  if (!session?.u) return new NextResponse(null, { status: 401 });
  const refused = await assertVisible(session, itemId);
  if (refused) return refused;
  try {
    const item = await readItem(itemId);
    if (!item) return new NextResponse(null, { status: 404 });
    const series = item.Type === "Episode" && item.SeriesId && isJellyfinId(item.SeriesId) ? await readItem(item.SeriesId).catch(() => null) : null;
    // Le logo et le grand visuel d'un épisode sont ceux de sa série.
    const art = series ?? item;
    const details: OfflineDetails = {
      ...factsOf(item),
      logoItemId: art.ImageTags?.Logo && art.Id ? art.Id : null,
      backdropItemId: art.BackdropImageTags?.length && art.Id ? art.Id : null,
      posterItemId: series?.ImageTags?.Primary && series.Id ? series.Id : null,
      series: series ? factsOf(series) : null,
      markers: playerMarkers(await jellyfin.getEpisodeTimestamps(itemId).catch(() => null)),
    };
    return NextResponse.json(details, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
