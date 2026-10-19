import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isJellyfinId, jellyfinIdSegment } from "@/lib/jellyfinPath";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { passJellyfinFetch } from "@/lib/jellyfinBreaker";
import { assertVisible } from "@/lib/itemVisibility";
import { contentDownloadingAllowed } from "@/lib/transcodePolicy";
import { jellyfin } from "@/lib/clients/jellyfin";
import { displayTitle } from "@/lib/displayTitle";
import { logDownload } from "@/lib/logger";
import { noteMediaRead } from "@/lib/repliques/playbackActivity";

export const dynamic = "force-dynamic";

/** Comme le relais du flux : borne l'attente des en-têtes de Jellyfin, jamais le transfert. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;

/**
 * « Télécharger le fichier » (⋮ du lecteur, au bureau — 19/10/2026) : le fichier d'origine, tel que
 * la bibliothèque le garde, servi par Jellyfin (`/Items/{id}/Download`) et relayé ici.
 *
 * Trois verrous, dans cet ordre, et aucun n'est l'interface : une session ; le titre visible pour
 * ce compte (`assertVisible` — la clé d'administration qui signe l'appel voit tout, tags bloqués
 * compris) ; et le droit de télécharger que Jellyfin donne au compte (`EnableContentDownloading`,
 * non dans le doute). Les plages passent telles quelles : le navigateur reprend un téléchargement
 * coupé, et un fichier de 60 Go ne se recommence pas du début.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  if (!isJellyfinId(itemId)) return new NextResponse(null, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId) return new NextResponse(null, { status: 401 });
  const refused = await assertVisible(session, itemId);
  if (refused) return refused;
  if (!(await contentDownloadingAllowed(session.jfId).catch(() => false))) {
    return NextResponse.json({ error: "Téléchargement non autorisé pour ce compte" }, { status: 403 });
  }

  noteMediaRead();
  const range = req.headers.get("range");
  const ifRange = req.headers.get("if-range");
  const headerWait = new AbortController();
  const headerTimer = setTimeout(() => headerWait.abort(new DOMException("Jellyfin n'a pas répondu", "TimeoutError")), UPSTREAM_HEADERS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await passJellyfinFetch(`${config.jellyfin.url}/Items/${jellyfinIdSegment(itemId)}/Download`, {
      headers: { ...jellyfinAuthHeaders(config.jellyfin.apiKey), ...(range ? { Range: range } : {}), ...(ifRange ? { "If-Range": ifRange } : {}) },
      signal: AbortSignal.any([req.signal, headerWait.signal]),
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  } finally {
    clearTimeout(headerTimer);
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    return new NextResponse(null, { status: res.status === 404 ? 404 : 502 });
  }

  // Le début du fichier seulement : une reprise (une plage plus loin) n'est pas un second téléchargement.
  if (!range || /^bytes=0-/.test(range)) {
    const length = Number(res.headers.get("Content-Length"));
    void jellyfin
      .getItemNaming(session.jfId, itemId)
      .catch(() => null)
      .then((naming) =>
        logDownload(session.u, {
          itemId,
          title: naming ? displayTitle(naming, "") || null : null,
          sizeBytes: Number.isFinite(length) && length > 0 ? length : null,
        })
      );
  }

  const headers: Record<string, string> = {
    "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream",
    // `private, no-store` : ni un cache partagé, ni celui du navigateur — le fichier va sur le disque
    // de qui le télécharge, et nulle part ailleurs.
    "Cache-Control": "private, no-store",
    // Le nom du fichier vient de Jellyfin ; sans lui, le navigateur l'appellerait « itemId ».
    "Content-Disposition": res.headers.get("Content-Disposition") ?? "attachment",
  };
  for (const name of ["Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"]) {
    const value = res.headers.get(name);
    if (value) headers[name] = value;
  }
  return new NextResponse(res.body, { status: res.status, headers });
}
