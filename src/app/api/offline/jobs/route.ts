import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { assertVisible } from "@/lib/itemVisibility";
import { contentDownloadingAllowed } from "@/lib/transcodePolicy";
import { errorBody } from "@/lib/apiErrorCodes";
import { OfflineRefusal, requestOfflineJob, type OfflineCodec, type OfflineQuality } from "@/lib/offline/jobs";

/**
 * Demander un téléchargement hors ligne (bêta) : Jellyfin prépare la version, l'appareil la suit par
 * `GET /api/offline/jobs/<id>`. Ouvert à tous les comptes sauf réglage de l'installation, et
 * seulement pour un titre que le compte voit.
 *
 * Revue de sécurité du 20/10/2026 : un compte ordinaire doit aussi avoir le droit Jellyfin
 * « Autoriser les téléchargements » (`contentDownloadingAllowed`, non dans le doute), comme pour le
 * fichier d'origine (`/api/player/download`) — une version légère reste le film entier qui sort de
 * la bibliothèque, et chaque demande coûte un transcodage complet. Les administrateurs passent. Et
 * au plus `OFFLINE_MAX_IN_FLIGHT` versions en vol par compte (429 `offline-limit`, `jobs.ts`).
 */
export async function POST(req: NextRequest) {
  if (!config.player.enabled || !config.player.offlineDownloads) return NextResponse.json({ error: "Téléchargement hors ligne désactivé" }, { status: 404 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.u) return new NextResponse(null, { status: 401 });
  // Le temps de la bêta, aux administrateurs seulement, sauf si l'installation l'a ouvert à tous.
  if (!config.player.offlineDownloadsForEveryone && session.role !== "admin") {
    return NextResponse.json({ error: "Téléchargement hors ligne réservé aux administrateurs" }, { status: 403 });
  }
  if (session.role !== "admin" && !(await contentDownloadingAllowed(session.jfId).catch(() => false))) {
    return NextResponse.json(errorBody("Téléchargement non autorisé pour ce compte", "offline-forbidden"), { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { itemId?: unknown; audioIndex?: unknown; quality?: unknown; codec?: unknown } | null;
  const itemId = body?.itemId;
  const audioIndex = body?.audioIndex;
  const quality = body?.quality;
  const codec = body?.codec ?? "hevc";
  if (!isJellyfinId(itemId) || typeof audioIndex !== "number" || !Number.isInteger(audioIndex) || audioIndex < 0) {
    return NextResponse.json({ error: "Demande invalide" }, { status: 400 });
  }
  if (quality !== "standard" && quality !== "high") return NextResponse.json({ error: "Qualité inconnue" }, { status: 400 });
  if (codec !== "hevc" && codec !== "h264") return NextResponse.json({ error: "Codec inconnu" }, { status: 400 });
  const refused = await assertVisible(session, itemId);
  if (refused) return refused;
  try {
    const job = await requestOfflineJob({ account: session.u, itemId, audioIndex, quality: quality as OfflineQuality, codec: codec as OfflineCodec });
    return NextResponse.json({ job }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof OfflineRefusal) {
      return NextResponse.json({ ...error.extra, error: error.message, ...(error.code && { code: error.code }) }, { status: error.status });
    }
    throw error;
  }
}
