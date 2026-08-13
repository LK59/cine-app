import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { HttpError } from "@/lib/http";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

// Both "no Jellyfin identity in session" and "Jellyfin rejected our stored
// token" boil down to the same user-facing action: log back in with Jellyfin
// credentials. A single status + code lets the client show one clear message
// instead of a dead-end error (see PlayerModal + /login?reason=playback).
function reauthRequired() {
  return NextResponse.json(
    { error: "Ta session Jellyfin a expiré", code: "jellyfin_reauth_required" },
    { status: 401 }
  );
}

export async function POST(req: NextRequest) {
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

  if (!itemId || !JELLYFIN_ID_RE.test(itemId)) {
    return NextResponse.json({ error: "itemId invalide" }, { status: 400 });
  }

  try {
    const info = await jellyfin.getPlaybackInfo(session.jfId, itemId, session.jfToken, {
      maxBitrate,
      mediaSourceId: itemId,
      audioStreamIndex,
      subtitleStreamIndex,
      startTicks,
    });
    const source = info.MediaSources?.[0];
    if (!source?.TranscodingUrl) {
      return NextResponse.json({ error: "Jellyfin n'a renvoyé aucun flux" }, { status: 502 });
    }

    // TranscodingUrl is a Jellyfin-relative path like "/videos/{itemId}/master.m3u8?...",
    // but Jellyfin writes the id there in dashed UUID form while ours is the bare
    // 32-char hex used everywhere else in the app — match generically instead of
    // rebuilding its dashed form. Keep only what comes after that prefix and re-root
    // it under our own stream proxy, so the browser never talks to Jellyfin directly.
    const parsed = new URL(source.TranscodingUrl, "http://internal");
    const restPath = parsed.pathname.replace(/^\/videos\/[0-9a-f-]{32,36}\//i, "");
    const manifestUrl = `/api/jellyfin/stream/${itemId}/${restPath}${parsed.search}`;

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
    const [, timestamps] = await Promise.all([
      jellyfin.reportPlaybackStart(session.jfId, itemId, session.jfToken, info.PlaySessionId, source.Id).catch(() => {}),
      jellyfin.getEpisodeTimestamps(itemId).catch(() => null),
    ]);

    const introSkip =
      timestamps?.Introduction?.Valid ? { start: timestamps.Introduction.Start, end: timestamps.Introduction.End } : null;
    const creditsStart = timestamps?.Credits?.Valid ? timestamps.Credits.Start : null;

    return NextResponse.json({
      playSessionId: info.PlaySessionId,
      mediaSourceId: source.Id,
      manifestUrl,
      subtitleTracks,
      audioTracks,
      introSkip,
      creditsStart,
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
