import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { describeFileTracks, prettyCodec, type FileTracks } from "@/lib/fileTracks";

export interface FileStreamsResponse extends FileTracks {
  container: string | null;
  video: { codec: string | null; width: number | null; height: number | null; rangeType: string | null } | null;
}

/**
 * Les pistes d'un fichier, telles que le conteneur les déclare.
 *
 * Une lecture seule, volontairement séparée de `/api/jellyfin/direct/[itemId]` : celle-ci sert
 * le lecteur natif, décide d'un chemin de lecture et se refuse aux comptes restés sur le lecteur
 * stable. Décrire un fichier n'a rien à voir avec le lire, et tout le monde peut le faire.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await ctx.params;
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

    return NextResponse.json({
      container: source.Container ?? null,
      video: video
        ? {
            codec: prettyCodec(video.Codec),
            width: video.Width ?? null,
            height: video.Height ?? null,
            rangeType: video.VideoRangeType ?? video.VideoRange ?? null,
          }
        : null,
      ...describeFileTracks(streams),
    } satisfies FileStreamsResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Jellyfin injoignable" },
      { status: 502 }
    );
  }
}
