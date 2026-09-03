import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { HttpError } from "@/lib/http";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { buildDeviceProfile } from "@/lib/deviceProfile";
import type { CodecSupport } from "@/lib/codecSupport";
import { displayTitle } from "@/lib/displayTitle";

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

// Both "no Jellyfin identity in session" and "Jellyfin rejected our stored
// token" boil down to the same user-facing action: log back in with Jellyfin
// credentials. A single status + code lets the client show one clear message
// instead of a dead-end error (see PlayerHost + /login?reason=playback).
function reauthRequired() {
  return NextResponse.json(
    { error: "Ta session Jellyfin a expiré", code: "jellyfin_reauth_required" },
    { status: 401 }
  );
}

// TranscodeReasons only ever comes back embedded in TranscodingUrl's own query string in this
// Jellyfin version (verified against the real server — MediaSourceInfo has no such field of
// its own), never as a separate JSON field — so it has to be parsed out of the URL rather than
// read directly.
function parseTranscodingUrlInfo(transcodingUrl: string): { videoCodecs: string[]; reasons: string[] } {
  const parsed = new URL(transcodingUrl, "http://internal");
  const videoCodecs = (parsed.searchParams.get("VideoCodec") ?? "").split(",").filter(Boolean);
  const reasons = (parsed.searchParams.get("TranscodeReasons") ?? "").split(",").filter(Boolean);
  return { videoCodecs, reasons };
}

// Jellyfin's PlayMethod isn't handed to us directly by PlaybackInfo (unlike /Sessions, which
// only exists once playback has actually started) — the client is expected to derive it, same
// as jellyfin-web: DirectPlay when the source plays untouched, otherwise DirectStream when the
// video stream itself is copied (not re-encoded), otherwise a real Transcode.
//
// Deliberately NOT guessed from whether TranscodeReasons contains a "Video*"-prefixed reason —
// verified against the real server that this mis-predicts: the exact same file, negotiated for
// two different browsers, produced TranscodeReasons with no Video* entry in both cases, yet one
// browser's actual ffmpeg job did `-codec:v:0 copy` (a real DirectStream) while the other's did
// a full `-codec:v:0 h264_qsv` re-encode (a real Transcode) — the reason string alone doesn't
// reliably capture that. Comparing the source's own video codec against the VideoCodec list
// Jellyfin was asked to accept is what ffmpeg itself actually keys its copy-vs-encode decision
// on, so it can't disagree with reality the way the reason-parsing heuristic did.
type PlayMethod = "DirectPlay" | "DirectStream" | "Transcode";
function derivePlayMethod(isDirectPlay: boolean, isVideoCopied: boolean): PlayMethod {
  if (isDirectPlay) return "DirectPlay";
  return isVideoCopied ? "DirectStream" : "Transcode";
}

export async function POST(req: NextRequest) {
  if (!config.player.enabled) {
    return NextResponse.json({ error: "Lecteur intégré désactivé" }, { status: 404 });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  if (!session?.jfId || !session?.jfToken) {
    return reauthRequired();
  }

  const body = await req.json().catch(() => null);
  const itemId = body?.itemId as string | undefined;
  const maxBitrate = Number(body?.maxBitrate) || 8_000_000;
  const audioStreamIndex = body?.audioStreamIndex as number | undefined;
  const subtitleStreamIndex = body?.subtitleStreamIndex as number | undefined;
  const startTicks = body?.startTicks as number | undefined;
  const codecSupport = (body?.codecSupport as CodecSupport | undefined) ?? { video: {}, audio: {} };
  // Client-driven audio-codec exclusions, on top of the browser's own claimed support: real
  // playback attempts are the only trustworthy probe of what a device actually decodes (its
  // canPlayType can overreport — verified live with an iPhone claiming E-AC-3 support whose
  // native HLS pipeline then rejects any ec-3 stream). The client's fallback ladder retries a
  // failed load with codecs disabled here, which makes Jellyfin negotiate a genuine server-side
  // audio transcode to a codec the device has actually proven it can play.
  // Whether the client will play the HLS stream with the browser's own pipeline (Safari, iOS)
  // rather than hls.js. Defaults to TRUE when absent, so a client from before this field existed
  // keeps the pre-warm it has always had — see where it's used below.
  const nativeHls = body?.nativeHls !== false;
  const disableAudioCodecs = Array.isArray(body?.disableAudioCodecs)
    ? (body.disableAudioCodecs as unknown[]).filter((c): c is string => typeof c === "string" && /^[a-z0-9]{1,16}$/.test(c))
    : [];

  if (!itemId || !JELLYFIN_ID_RE.test(itemId)) {
    return NextResponse.json({ error: "itemId invalide" }, { status: 400 });
  }

  try {
    const effectiveSupport: CodecSupport = {
      video: codecSupport.video,
      audio: Object.fromEntries(
        Object.entries(codecSupport.audio ?? {}).map(([codec, ok]) => [codec, disableAudioCodecs.includes(codec) ? false : ok])
      ),
    };
    const deviceProfile = buildDeviceProfile(effectiveSupport, maxBitrate);
    const info = await jellyfin.getPlaybackInfo(session.jfId, itemId, session.jfToken, {
      maxBitrate,
      mediaSourceId: itemId,
      audioStreamIndex,
      subtitleStreamIndex,
      startTicks,
      deviceProfile,
    });
    const source = info.MediaSources?.[0];
    if (!source) {
      return NextResponse.json({ error: "Jellyfin n'a renvoyé aucun flux" }, { status: 502 });
    }

    const isDirectPlay = source.SupportsDirectPlay === true;

    let manifestUrl: string;
    let videoCodecs: string[] = [];
    let transcodeReasons: string[] = [];

    if (isDirectPlay) {
      // No TranscodingUrl is returned for DirectPlay — jellyfin-web builds this same static
      // endpoint itself; we just re-root it under our own stream proxy like the HLS case below,
      // so the browser never talks to Jellyfin directly.
      const container = (source.Container ?? "mp4").split(",")[0];
      manifestUrl = `/api/jellyfin/stream/${itemId}/stream.${container}?static=true&mediaSourceId=${source.Id}`;
      videoCodecs = (source.MediaStreams ?? [])
        .filter((s) => s.Type === "Video")
        .map((s) => s.Codec)
        .filter((c): c is string => !!c);
    } else {
      if (!source.TranscodingUrl) {
        return NextResponse.json({ error: "Jellyfin n'a renvoyé aucun flux" }, { status: 502 });
      }
      // TranscodingUrl is a Jellyfin-relative path like "/videos/{itemId}/master.m3u8?...",
      // but Jellyfin writes the id there in dashed UUID form while ours is the bare
      // 32-char hex used everywhere else in the app — match generically instead of
      // rebuilding its dashed form. Keep only what comes after that prefix and re-root
      // it under our own stream proxy, so the browser never talks to Jellyfin directly.
      const parsed = new URL(source.TranscodingUrl, "http://internal");
      const restPath = parsed.pathname.replace(/^\/videos\/[0-9a-f-]{32,36}\//i, "");
      manifestUrl = `/api/jellyfin/stream/${itemId}/${restPath}${parsed.search}`;
      ({ videoCodecs, reasons: transcodeReasons } = parseTranscodingUrlInfo(source.TranscodingUrl));

      // Found live: a track switch that needs a genuine transcode (not just a remux copy — e.g.
      // Dolby TrueHD/Atmos audio, which nothing in our codec-support detection claims, forcing a
      // real re-encode down to AAC/AC3 alongside the video) took long enough for Jellyfin to spin
      // up a fresh ffmpeg job that the client's own request for the manifest timed out client-side
      // before ever getting a response — Safari's native HLS bootstrap appears far less patient
      // for this than hls.js, which is why Firefox never surfaced it. Pre-fetching the manifest
      // ourselves, server-side, before responding to the client absorbs that startup cost here —
      // by the time the client makes its own request through the proxy, ffmpeg is already running
      // and Jellyfin can answer near-instantly. Best-effort and bounded: if this itself times out,
      // fall through anyway and let the client's own request (plus the proxy's existing retry) be
      // the fallback, rather than hanging the whole "start playback" action indefinitely.
      //
      // Only for the clients it was written for. On the hls.js path this wait buys nothing — that
      // library retries a slow first manifest on its own, patiently, which is exactly why Firefox
      // never hit the bug — and blocking here delays the response that lets the browser get on
      // with downloading hls.js itself. Skipping it there lets ffmpeg warm up in parallel with
      // that download instead of in front of it. Safari's behaviour is unchanged.
      if (nativeHls) {
        try {
          const warmup = await fetch(`${config.jellyfin.url}${source.TranscodingUrl}`, {
            headers: { "X-Emby-Token": session.jfToken },
            signal: AbortSignal.timeout(15_000),
          });
          // Read it to completion (a ~700 byte playlist) rather than dropping the response on the
          // floor: an unconsumed body holds its connection open until the GC gets to it.
          await warmup.text().catch(() => "");
        } catch {
          // Fall through — see comment above.
        }
      }
    }

    const videoStream = (source.MediaStreams ?? []).find((s) => s.Type === "Video") ?? null;
    const isVideoCopied = isDirectPlay || (!!videoStream?.Codec && videoCodecs.includes(videoStream.Codec));
    const playMethod = derivePlayMethod(isDirectPlay, isVideoCopied);

    const audioStreamForPlayback = (source.MediaStreams ?? []).find(
      (s) => s.Type === "Audio" && (audioStreamIndex === undefined || s.Index === audioStreamIndex)
    );

    // External VTT delivery works the same regardless of PlayMethod (Jellyfin extracts embedded
    // subtitles server-side on demand, via the SubtitleProfiles "External" method declared in
    // deviceProfile.ts) — this is the client's primary subtitle source in every case, with
    // real DisplayTitle/Language from the source file rather than hls.js's own less complete
    // SUBTITLE_TRACKS_UPDATED-derived names.
    const subtitleTracks = (source.MediaStreams ?? [])
      .filter((s) => s.Type === "Subtitle")
      .map((s) => ({
        index: s.Index,
        language: s.Language,
        label: s.DisplayTitle ?? s.Language ?? `Piste ${s.Index}`,
        isDefault: s.IsDefault ?? false,
        url: `/api/jellyfin/stream/subtitle/${itemId}?mediaSourceId=${source.Id}&index=${s.Index}`,
      }));

    const audioTracks = (source.MediaStreams ?? [])
      .filter((s) => s.Type === "Audio")
      .map((s) => ({
        index: s.Index,
        language: s.Language,
        label: s.DisplayTitle ?? s.Language ?? `Piste ${s.Index}`,
        isDefault: s.IsDefault ?? false,
      }));

    // Best-effort: a failed "now playing" report shouldn't block playback itself.
    // Same for intro/credits timestamps — 404s for movies and unanalyzed
    // episodes, which just means no skip-intro / next-up prompt for this item.
    const [, timestamps, naming] = await Promise.all([
      jellyfin
        .reportPlaybackStart(session.jfId, itemId, session.jfToken, info.PlaySessionId, source.Id, playMethod)
        .catch(() => {}),
      jellyfin.getEpisodeTimestamps(itemId).catch(() => null),
      // Alongside the others, so naming the film costs nothing on the way to its first frame.
      jellyfin.getItemNaming(session.jfId, itemId).catch(() => null),
    ]);

    const introSkip =
      timestamps?.Introduction?.Valid ? { start: timestamps.Introduction.Start, end: timestamps.Introduction.End } : null;
    const creditsStart = timestamps?.Credits?.Valid ? timestamps.Credits.Start : null;

    return NextResponse.json({
      playSessionId: info.PlaySessionId,
      mediaSourceId: source.Id,
      manifestUrl,
      isDirectPlay,
      subtitleTracks,
      audioTracks,
      introSkip,
      creditsStart,
      /** "Série — S02E05 · Titre", from the server rather than from whoever opened the player. */
      title: naming ? displayTitle(naming, "") || null : null,
      // Everything below is purely for the Playback Info panel (Phase 4) — no extra request,
      // all derived from the PlaybackInfo response already fetched above.
      playbackInfo: {
        playMethod,
        transcodeReasons,
        container: source.Container ?? null,
        requestedVideoCodecs: videoCodecs,
        video: videoStream && {
          codec: videoStream.Codec ?? null,
          profile: videoStream.Profile ?? null,
          width: videoStream.Width ?? null,
          height: videoStream.Height ?? null,
          bitDepth: videoStream.BitDepth ?? null,
          frameRate: videoStream.AverageFrameRate ?? null,
          bitRate: videoStream.BitRate ?? null,
        },
        audio: audioStreamForPlayback && {
          codec: audioStreamForPlayback.Codec ?? null,
          channels: audioStreamForPlayback.Channels ?? null,
          bitRate: audioStreamForPlayback.BitRate ?? null,
          language: audioStreamForPlayback.Language ?? null,
        },
      },
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      return reauthRequired();
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur Jellyfin" },
      { status: 502 }
    );
  }
}
