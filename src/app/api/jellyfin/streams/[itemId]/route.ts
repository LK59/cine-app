import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { describeFileTracks, prettyCodec, type FileTrack, type FileTracks } from "@/lib/fileTracks";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { dynamicRangeOf, type DynamicRange } from "@/lib/titleDetails";
import { generatedForDirect } from "@/lib/subtitleGen/direct";
import { cachedMovies } from "@/lib/server-cache";
import { originalLanguageCode } from "@/lib/originalLanguage";

/**
 * Une piste décrite pour la fenêtre « Détails » (§152, 13/11/2026) : la description commune
 * (`FileTrack`, que la page de gestion affiche), plus ce que `trackLabel` lit pour nommer la piste
 * comme les menus du lecteur. **Tous les ajouts sont facultatifs** : la page de gestion
 * (`(dashboard)/radarr/[id]`) lit la même réponse et n'en sait rien.
 */
export interface FileStreamTrack extends FileTrack {
  /** Le numéro de la piste dans le fichier (`Index` Jellyfin). */
  index?: number;
  /** Le `Title` brut du conteneur — ce que le lecteur donne à `trackLabel` comme nom. */
  name?: string | null;
  /** Le profil que Jellyfin a lu (« Dolby TrueHD + Dolby Atmos », « DTS-HD MA »…). */
  profile?: string | null;
  /** Un sous-titre que Laterna a fait générer et poser à côté du film (§69). */
  generated?: boolean;
}

export interface FileStreamsResponse extends FileTracks {
  container: string | null;
  video: {
    codec: string | null;
    width: number | null;
    height: number | null;
    rangeType: string | null;
    /** 8, 10, 12 — absent quand Jellyfin ne le dit pas (§152). */
    bitDepth?: number | null;
    /** La dynamique nommée (`dynamicRangeOf`) : « Dolby Vision », « HDR10+ », « SDR »… (§152). */
    dynamicRange?: DynamicRange | null;
    /** Le profil Dolby Vision (5, 7, 8…) quand Jellyfin l'a lu (§152). */
    dvProfile?: number | null;
  } | null;
  /** Le débit moyen du fichier, image et son compris, en bits par seconde (`MediaSource.Bitrate`) — §152. */
  bitrate?: number | null;
  /**
   * La langue de tournage, quand l'appel nomme le film par son identifiant TMDB (`?tmdb=`) : ce qui fait
   * écrire « (VO) » dans l'étiquette d'une piste, comme dans le menu du lecteur (§152).
   */
  originalLanguage?: string | null;
  audio: FileStreamTrack[];
  subtitles: FileStreamTrack[];
}

/**
 * Les pistes d'un fichier, telles que le conteneur les déclare.
 *
 * Une lecture seule, volontairement séparée de `/api/jellyfin/direct/[itemId]` : celle-ci sert
 * le lecteur natif, décide d'un chemin de lecture et se refuse aux comptes restés sur le lecteur
 * stable. Décrire un fichier n'a rien à voir avec le lire, et tout le monde peut le faire.
 *
 * Lue avec le compte Jellyfin de la session : un titre masqué par un tag bloqué reste introuvable.
 * Deux lecteurs : la carte Fichier de la page de gestion, et la fenêtre « Détails » d'une fiche de
 * film (§152), qui ne la demande qu'à son ouverture.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await ctx.params;
  // Le paramètre part tel quel dans l'URL amont, signée avec la clé d'administration : un `..`
  // ou un `?` y réécrirait le chemin. Refusé avant l'appel client.
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "Identifiant invalide" }, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);

  if (!session?.jfId) {
    return NextResponse.json({ error: "Compte Jellyfin requis" }, { status: 403 });
  }

  try {
    const item = await jellyfin.getItemMediaSources(session.jfId, itemId);
    const source = item.MediaSources?.[0];
    if (!source) return NextResponse.json({ error: "Fichier introuvable" }, { status: 404 });

    const streams = source.MediaStreams ?? [];
    const video = streams.find((s) => s.Type === "Video") ?? null;
    const tracks = describeFileTracks(streams);
    const audioStreams = streams.filter((s) => s.Type === "Audio");
    const subtitleStreams = streams.filter((s) => s.Type === "Subtitle");
    // Les sous-titres que Laterna a fait poser : une lecture de `cine.db`, aucune requête de plus, et
    // qui ne lève jamais (`generatedForDirect`, la même que la route du lecteur natif).
    const generated = generatedForDirect(itemId, source, streams);

    return NextResponse.json({
      container: source.Container ?? null,
      video: video
        ? {
            codec: prettyCodec(video.Codec),
            width: video.Width ?? null,
            height: video.Height ?? null,
            rangeType: video.VideoRangeType ?? video.VideoRange ?? null,
            bitDepth: video.BitDepth ?? null,
            dynamicRange: dynamicRangeOf(video.VideoRangeType, video.VideoRange),
            dvProfile: typeof video.DvProfile === "number" ? video.DvProfile : null,
          }
        : null,
      bitrate: typeof source.Bitrate === "number" && Number.isFinite(source.Bitrate) && source.Bitrate > 0 ? source.Bitrate : null,
      // `describeFileTracks` garde l'ordre du fichier : la n-ième piste décrite est le n-ième flux.
      audio: tracks.audio.map((t, i) => ({
        ...t,
        index: audioStreams[i].Index,
        name: audioStreams[i].Title ?? null,
        profile: audioStreams[i].Profile ?? null,
      })),
      subtitles: tracks.subtitles.map((t, i) => ({
        ...t,
        index: subtitleStreams[i].Index,
        name: subtitleStreams[i].Title ?? null,
        ...(generated.ours.has(subtitleStreams[i].Index) ? { generated: true } : {}),
      })),
      ...(await originalLanguageParam(req)),
    } satisfies FileStreamsResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Jellyfin injoignable" },
      { status: 502 }
    );
  }
}

/**
 * La langue de tournage d'un film nommé par `?tmdb=` — une recherche dans le catalogue déjà en mémoire
 * (`cachedMovies`), comme la route du lecteur natif. Sans paramètre, rien n'est ajouté : la réponse de la
 * page de gestion reste celle d'avant. Toute incertitude rend `null`, et « (VO) » disparaît simplement.
 */
async function originalLanguageParam(req: NextRequest): Promise<{ originalLanguage?: string | null }> {
  const raw = req.nextUrl.searchParams.get("tmdb");
  if (raw === null) return {};
  const tmdbId = Number(raw);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return { originalLanguage: null };
  const originalLanguage = await cachedMovies()
    .then((films) => originalLanguageCode(films.find((f) => f.tmdbId === tmdbId)?.originalLanguage?.name))
    .catch(() => null);
  return { originalLanguage };
}
