import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { isJellyfinId, jellyfinIdSegment } from "@/lib/jellyfinPath";
import { assertVisible } from "@/lib/itemVisibility";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { passJellyfinFetch } from "@/lib/jellyfinBreaker";
import { TEXT_SUBTITLE_FORMATS } from "@/lib/subtitleGen/source";

/**
 * Les sous-titres texte d'un titre, pour les garder avec son téléchargement (Louis, 19/10/2026 —
 * « inclure les sous-titres ») : ceux du conteneur comme ceux posés à côté, tous ceux que Jellyfin
 * rend en WebVTT (`TEXT_SUBTITLE_FORMATS`). Les sous-titres image (PGS) n'ont pas de texte à garder.
 * Chacun se télécharge ensuite par la route des sous-titres du lecteur, qui fait la conversion.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  if (!isJellyfinId(itemId)) return new NextResponse(null, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId) return new NextResponse(null, { status: 401 });
  const refused = await assertVisible(session, itemId);
  if (refused) return refused;
  const res = await passJellyfinFetch(`${config.jellyfin.url}/Items?ids=${jellyfinIdSegment(itemId)}&fields=MediaSources`, {
    headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return new NextResponse(null, { status: 502 });
  const page = (await res.json()) as {
    Items?: {
      MediaSources?: {
        Id?: string;
        MediaStreams?: { Type?: string; Index?: number; Codec?: string; Language?: string; Title?: string; IsForced?: boolean; IsHearingImpaired?: boolean; IsExternal?: boolean }[];
      }[];
    }[];
  };
  const source = page.Items?.[0]?.MediaSources?.[0];
  const mediaSourceId = source?.Id ?? itemId;
  const subtitles = (source?.MediaStreams ?? [])
    .filter((s) => s.Type === "Subtitle" && typeof s.Index === "number" && TEXT_SUBTITLE_FORMATS.has((s.Codec ?? "").toLowerCase()))
    .map((s) => ({
      index: s.Index!,
      language: s.Language ?? null,
      title: s.Title ?? null,
      isForced: s.IsForced === true,
      isHearingImpaired: s.IsHearingImpaired === true,
      isExternal: s.IsExternal === true,
      url: `/api/jellyfin/stream/subtitle/${itemId}?mediaSourceId=${encodeURIComponent(mediaSourceId)}&index=${s.Index}`,
    }));
  return NextResponse.json({ subtitles }, { headers: { "Cache-Control": "private, no-store" } });
}
