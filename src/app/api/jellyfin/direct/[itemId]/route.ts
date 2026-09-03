import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { userPrefsDb } from "@/lib/db";

/** What Jellyfin can hand back as WebVTT. Anything else is a picture and has nothing to read. */
const TEXT_SUBTITLE_FORMATS = new Set(["srt", "subrip", "ass", "ssa", "vtt", "webvtt", "mov_text"]);

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

// Containers the experimental player's demuxer understands. Matroska is 99.7% of this library;
// anything else is refused with a reason rather than half-played.
// mkv and webm are read by the remuxer; mp4 and m4v need nothing read at all — the browser
// opens them itself, which is the whole of what the remuxer spends its time producing.
const SUPPORTED_CONTAINERS = new Set(["mkv", "webm", "mp4", "m4v"]);

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

export interface ExternalSubtitle {
  /** Negative in the player's menus, so it can never collide with a track number from the file. */
  id: number;
  language: string | null;
  title: string | null;
  /** Through this app's own proxy, which asks Jellyfin for it as WebVTT. */
  url: string;
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
  /**
   * Applies only if playback falls back to decoding on a canvas. The native path shows HDR
   * without converting anything, so this is enforced by the client rather than here.
   */
  canvasHdrRefusal: string | null;
  /**
   * Subtitle files sitting beside the film rather than inside it.
   *
   * Nothing in the container names them, so without this they simply do not exist for a player
   * that reads the file directly — while Jellyfin, which lists them, shows them. On this library
   * that is the difference between subtitles and none on the forty-six films whose only embedded
   * tracks are images, which this player does not render.
   */
  externalSubtitles: ExternalSubtitle[];
  /** Where the opening titles run, when Jellyfin has analysed the episode. Null otherwise. */
  introSkip: { start: number; end: number } | null;
  /** Where the closing credits begin, which is when the next episode is offered. */
  creditsStart: number | null;
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

  // Fetched together: the timestamps 404 for films and for episodes nobody has analysed, which
  // simply means no skip-intro and no next-up prompt for this one.
  const [item, timestamps] = await Promise.all([
    jellyfin.getItemMediaSources(session.jfId, itemId).catch(() => null),
    jellyfin.getEpisodeTimestamps(itemId).catch(() => null),
  ]);
  const source = item?.MediaSources?.[0];
  if (!source) return NextResponse.json({ error: "Fichier introuvable côté Jellyfin" }, { status: 404 });

  const streams = source.MediaStreams ?? [];
  const videoStream = streams.find((s) => s.Type === "Video") ?? null;
  // Jellyfin reports whatever ffmpeg's demuxer is called, and one demuxer covers several
  // containers: an ordinary MP4 comes back as "mov,mp4,m4a,3gp,3g2,mj2". Reading only the first
  // name called every MP4 in the library a "mov" and refused it.
  const containers = (source.Container ?? "").toLowerCase().split(",").filter(Boolean);
  const container = containers.find((name) => SUPPORTED_CONTAINERS.has(name)) ?? containers[0] ?? "";
  const rangeType = videoStream?.VideoRangeType ?? null;
  const isHdr = !!rangeType && rangeType !== "SDR";

  // Refused outright: either the remuxer reads the container, or the browser opens it unaided.
  // Anything else — AVI above all, whose codecs no browser decodes — belongs to the server.
  const refusedReason = SUPPORTED_CONTAINERS.has(container)
    ? null
    : `Le lecteur expérimental ne lit pas les fichiers « ${container || "inconnu"} » (Matroska et MP4 seulement).`;

  // HDR is a different matter now, and the server is the wrong place to decide it. Repackaging the
  // file for the browser's own decoder carries the HDR signalling through untouched and the
  // display handles it — there is nothing to tone map and nothing to warn about. It is only the
  // canvas pipeline that has to convert the picture by hand, so this is passed down as a reason
  // that *may* apply and is enforced by the client once it knows which path it is on.
  //
  // There is no longer anything to consent to, either. Converting HDR on the GPU was once a
  // setting because it was the only way HDR played at all and it costs the picture something;
  // now the native path shows it untouched and the conversion is what happens on the fallback
  // instead of nothing. A file that cannot be converted is still refused, and says why.
  let canvasHdrRefusal: string | null = null;
  if (isHdr && !TONE_MAPPABLE_RANGES.has(rangeType)) {
    canvasHdrRefusal = `Le Dolby Vision sans couche HDR10 (${rangeType}) n'a pas de base standard à convertir, et ce navigateur ne le lit pas nativement.`;
  }

  // Text only, and external only: an image subtitle has nothing to read, and an embedded text
  // track is already found by whichever pipeline opens the file.
  const externalSubtitles: ExternalSubtitle[] = streams
    .filter((s) => s.Type === "Subtitle" && s.IsExternal && TEXT_SUBTITLE_FORMATS.has((s.Codec ?? "").toLowerCase()))
    .map((s) => ({
      id: -1 - s.Index,
      language: s.Language ?? null,
      title: s.DisplayTitle ?? null,
      url: `/api/jellyfin/stream/subtitle/${itemId}?mediaSourceId=${encodeURIComponent(source.Id ?? itemId)}&index=${s.Index}`,
    }));

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
    canvasHdrRefusal,
    externalSubtitles,
    introSkip: timestamps?.Introduction?.Valid
      ? { start: timestamps.Introduction.Start, end: timestamps.Introduction.End }
      : null,
    creditsStart: timestamps?.Credits?.Valid ? timestamps.Credits.Start : null,
  };

  return NextResponse.json(payload);
}
