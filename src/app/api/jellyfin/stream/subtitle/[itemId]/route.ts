import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isJellyfinId, isSubtitleStreamIndex, isUnderJellyfinPrefix } from "@/lib/jellyfinPath";
import { castPassFor, castPreflightFor } from "@/lib/castToken";
import { castPreflightResponse, withCastCors } from "@/lib/castCors";
import { assertVisible } from "@/lib/itemVisibility";

type SubtitleParams = { params: Promise<{ itemId: string }> };

/**
 * Les en-têtes CORS de diffusion sur toute réponse servie au seul laissez-passer — le récepteur
 * Chromecast charge les sous-titres depuis son propre domaine (DECISIONS.md §64, `castCors.ts`).
 * Servie à une session, la réponse sort exactement telle qu'avant.
 */
export async function GET(req: NextRequest, context: SubtitleParams) {
  const { res, castPass } = await serveSubtitle(req, context);
  return castPass ? withCastCors(res) : res;
}

/** La question préalable du récepteur, avec son laissez-passer — voir la route des segments. */
export async function OPTIONS(req: NextRequest, { params }: SubtitleParams) {
  const { itemId } = await params;
  if (!isJellyfinId(itemId)) return new NextResponse(null, { status: 400 });
  if (!(await castPreflightFor(req))) return new NextResponse(null, { status: 403 });
  return castPreflightResponse();
}

async function serveSubtitle(req: NextRequest, context: SubtitleParams): Promise<{ res: NextResponse; castPass: string | null }> {
  let castPass: string | null = null;
  const res = await subtitle(req, context, (pass) => {
    castPass = pass;
  });
  return { res, castPass };
}

async function subtitle(req: NextRequest, { params }: SubtitleParams, notePass: (pass: string | null) => void) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });

  const { itemId } = await params;
  if (!isJellyfinId(itemId)) return new NextResponse(null, { status: 400 });

  /**
   * Le cookie, ou le laissez-passer de diffusion — la même règle que la route des segments.
   *
   * Un téléviseur qui reçoit l'image par AirPlay va chercher les pistes de sous-titres lui-même,
   * sans notre cookie et sans moyen d'en avoir un. Il n'obtenait donc que des 401, et ce qu'on
   * voyait à l'écran n'était plus que ce que le téléviseur devinait seul. Voir `castItemOf` : le
   * titre n'est pas au même rang dans cette adresse que dans celle des segments, et c'est
   * exactement ce que la règle ne reconnaissait pas.
   */
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  const castPass = session?.jfId ? null : await castPassFor(req);
  if (!session?.jfId && !castPass) return new NextResponse(null, { status: 403 });
  notePass(castPass);
  // Signé avec la clé d'administration : le droit du compte sur ce titre est demandé à Jellyfin
  // d'abord — voir `assertVisible` (le laissez-passer de diffusion n'y passe pas, voir là-bas).
  if (session?.jfId) {
    const refused = await assertVisible(session, itemId);
    if (refused) return refused;
  }

  const mediaSourceId = req.nextUrl.searchParams.get("mediaSourceId");
  const index = req.nextUrl.searchParams.get("index");
  // Ces deux valeurs arrivent en clair dans la query string — pas besoin d'un `%2F` pour y
  // glisser un `/`. Les seuls appelants passent `source.Id` (un identifiant Jellyfin) et
  // `s.Index` (un entier) : la forme est connue, donc exigée.
  if (!isJellyfinId(mediaSourceId) || !isSubtitleStreamIndex(index)) {
    return new NextResponse(null, { status: 400 });
  }

  const target = `${config.jellyfin.url}/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/Stream.vtt`;
  // Ceinture et bretelles, comme sur la route de flux : la vérification porte sur l'URL
  // assemblée, celle que `fetch` normalisera.
  if (!isUnderJellyfinPrefix(target, `${config.jellyfin.url}/Videos/${itemId}/`)) {
    return new NextResponse(null, { status: 400 });
  }

  try {
    const res = await fetch(target, {
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(8000)]),
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
    });
    if (!res.ok) return new NextResponse(null, { status: 404 });

    const blob = await res.blob();
    return new NextResponse(blob, {
      headers: {
        "Content-Type": "text/vtt",
        // `private` : servi à une session seulement — voir le relais de flux.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
