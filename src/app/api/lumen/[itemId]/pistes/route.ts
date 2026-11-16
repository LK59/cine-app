import { NextResponse, type NextRequest } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { goneResponse, lumenAccess, NO_STORE } from "@/lib/lumenServer/service";
import { subtitleSyncByIndex } from "@/lib/subtitleSync/store";
import { subtitleTrackFacts } from "@/lib/subtitleTrackFacts";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ itemId: string }> };

/**
 * `GET /api/lumen/{itemId}/pistes` — les sous-titres que `LumenServerHost` pose en `<track>` (étape 4,
 * DECISIONS.md §180) : la même liste, la même forme et les mêmes adresses que la négociation du lecteur
 * serveur (`subtitleTrackFacts`, écrite une fois pour les deux), synchro §141 comprise, plus l'identifiant de
 * la source média que ces adresses portent. Lumen serveur ne négocie rien avec Jellyfin — il lit le fichier
 * lui-même — mais la conversion d'une piste du conteneur en WebVTT reste celle de Jellyfin, par la route des
 * sous-titres existante.
 *
 * Lu avec le compte Jellyfin de la session (`getItemMediaSources`), comme la fenêtre « Détails » : un titre
 * caché reste caché. Administrateur seul (`lumenAccess`, comme toute route sous `/api/lumen`). Toujours 200 :
 * Jellyfin injoignable ou sans source, la liste est vide et l'hôte lit le film sans sous-titres plutôt que de
 * renoncer — c'est une absence attendue sur une route appelée par titre, jamais un 404 (CrowdSec).
 */
/**
 * L'essai du son multiplexé dans les segments vidéo (levier a de l'étape 3e, `trials.ts`, version `m1`) pour les
 * lectures de l'application : `LUMEN_MUX_AUDIO=1` dans l'environnement du conteneur, **coupé par défaut** — il
 * n'est pas prouvé (un banc concluant est en préparation) et la spécification d'Apple le déconseille (9.5–9.7).
 * Un réglage de déploiement seulement, lu ici pour que l'hôte n'ait rien à demander de plus.
 */
function lumenMuxAudio(): boolean {
  return process.env.LUMEN_MUX_AUDIO === "1";
}

export async function GET(req: NextRequest, { params }: Params) {
  const { itemId } = await params;
  if (!isJellyfinId(itemId)) return goneResponse("lumen-inconnu", "Élément inconnu");
  const session = await lumenAccess(req, itemId);
  if (session instanceof NextResponse) return session;
  if (!session.jfId) return NextResponse.json({ mediaSourceId: null, subtitleTracks: [] }, { headers: NO_STORE });
  try {
    const item = await jellyfin.getItemMediaSources(session.jfId, itemId, { pass: true });
    const source = item.MediaSources?.[0];
    if (!source) return NextResponse.json({ mediaSourceId: null, subtitleTracks: [] }, { headers: NO_STORE });
    const syncByIndex = subtitleSyncByIndex(itemId, source.ETag, source.MediaStreams ?? []);
    return NextResponse.json(
      { mediaSourceId: source.Id, subtitleTracks: subtitleTrackFacts(itemId, source, { syncByIndex }), ...(lumenMuxAudio() ? { mux: true } : {}) },
      { headers: NO_STORE }
    );
  } catch (error) {
    logError("lumen/pistes", error, { itemId });
    return NextResponse.json({ mediaSourceId: null, subtitleTracks: [], unavailable: true }, { headers: NO_STORE });
  }
}
