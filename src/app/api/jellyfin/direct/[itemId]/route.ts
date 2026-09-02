import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { userPrefsDb } from "@/lib/db";

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

// Containers the experimental player's demuxer understands. Matroska is 99.7% of this library;
// anything else is refused with a reason rather than half-played.
const SUPPORTED_CONTAINERS = new Set(["mkv", "webm"]);

// HDR ranges the WebGL tone-mapping path can handle. Dolby Vision profile 5 is deliberately
// absent: it has no HDR10 base layer, so there is nothing standard to tone-map from and the
// picture would come out with inverted-looking colours rather than merely flat ones.
const TONE_MAPPABLE_RANGES = new Set(["HDR10", "HDR10Plus", "HLG", "DOVIWithHDR10", "DOVIWithHDR10Plus", "DOVIWithSDR"]);

export interface DirectPlayAudioTrack {
  index: number;
  codec: string;
  language: string | null;
  displayTitle: string | null;
  channels: number | null;
  isDefault: boolean;
}

export interface DirectPlayInfo {
  /** Range-seekable URL for the untouched file, through this app's own proxy. */
  streamUrl: string;
  container: string;
  sizeBytes: number | null;
  runtimeSeconds: number | null;
  resumeSeconds: number;
  video: {
    codec: string | null;
    width: number | null;
    height: number | null;
    bitDepth: number | null;
    rangeType: string | null;
    isHdr: boolean;
  } | null;
  audio: DirectPlayAudioTrack[];
  /** Null when the file can be attempted; a user-facing explanation when it cannot. */
  refusedReason: string | null;
}

export async function GET(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  if (!config.player.enabled) return NextResponse.json({ error: "Lecteur intégré désactivé" }, { status: 404 });

  const { itemId } = await props.params;
  if (!JELLYFIN_ID_RE.test(itemId)) return NextResponse.json({ error: "itemId invalide" }, { status: 400 });

  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  // Gated on the same per-user flag the UI toggles, checked server-side: the experimental path
  // must not be reachable by anyone who hasn't opted in, whatever the client asks for.
  const prefs = userPrefsDb.getExperimentalPlayer(session.jfId ?? session.u);
  if (!prefs.enabled) return NextResponse.json({ error: "Lecteur expérimental désactivé" }, { status: 403 });

  const item = await jellyfin.getItemMediaSources(session.jfId, itemId).catch(() => null);
  const source = item?.MediaSources?.[0];
  if (!source) return NextResponse.json({ error: "Fichier introuvable côté Jellyfin" }, { status: 404 });

  const streams = source.MediaStreams ?? [];
  const videoStream = streams.find((s) => s.Type === "Video") ?? null;
  const container = (source.Container ?? "").split(",")[0].toLowerCase();
  const rangeType = videoStream?.VideoRangeType ?? null;
  const isHdr = !!rangeType && rangeType !== "SDR";

  let refusedReason: string | null = null;
  if (!SUPPORTED_CONTAINERS.has(container)) {
    refusedReason = `Le lecteur expérimental ne lit que les conteneurs Matroska pour l'instant (ce fichier est en « ${container || "inconnu"} »).`;
  } else if (isHdr && !prefs.hdr) {
    refusedReason = `Ce fichier est en ${rangeType}. Active « Lire le HDR avec le lecteur expérimental » dans les paramètres pour l'essayer.`;
  } else if (isHdr && !TONE_MAPPABLE_RANGES.has(rangeType)) {
    refusedReason = `Le Dolby Vision sans couche HDR10 (${rangeType}) n'a pas de base standard à convertir — ce fichier ne peut être lu que par le lecteur stable.`;
  }

  const payload: DirectPlayInfo = {
    // The same static endpoint DirectPlay already uses: the proxy forwards Range headers for it,
    // which is exactly what a demuxer jumping around a 40 GB file needs.
    streamUrl: `/api/jellyfin/stream/${itemId}/stream.${container || "mkv"}?static=true&mediaSourceId=${source.Id}`,
    container,
    sizeBytes: null,
    runtimeSeconds: item?.RunTimeTicks ? item.RunTimeTicks / 10_000_000 : null,
    resumeSeconds: (item?.UserData?.PlaybackPositionTicks ?? 0) / 10_000_000,
    video: videoStream
      ? {
          codec: videoStream.Codec ?? null,
          width: videoStream.Width ?? null,
          height: videoStream.Height ?? null,
          bitDepth: videoStream.BitDepth ?? null,
          rangeType,
          isHdr,
        }
      : null,
    audio: streams
      .filter((s) => s.Type === "Audio")
      .map((s) => ({
        index: s.Index,
        codec: s.Codec ?? "",
        language: s.Language ?? null,
        displayTitle: s.DisplayTitle ?? null,
        channels: s.Channels ?? null,
        isDefault: s.IsDefault ?? false,
      })),
    refusedReason,
  };

  return NextResponse.json(payload);
}
