import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { jellyfin } from "@/lib/clients/jellyfin";
import { contentDownloadingAllowed } from "@/lib/transcodePolicy";

export const dynamic = "force-dynamic";

export interface PlayerItemPayload {
  /** La série d'un épisode — le menu « Épisodes » du lecteur la liste. Nulle pour un film. */
  seriesId: string | null;
  /** Présent seulement si le compte a le droit de télécharger (Jellyfin) : la taille du fichier. */
  download: { sizeBytes: number | null } | null;
}

/**
 * Ce que le lecteur sait d'un titre à côté du film, pour deux gestes ajoutés le 19/10/2026 : le menu
 * « Épisodes » (la série de l'épisode) et « Télécharger le fichier » (le droit du compte et la taille).
 *
 * Une route à elle, pas un champ de plus dans `direct` : les deux lecteurs (natif, serveur) ouvrent
 * un film par deux routes différentes, et ces deux gestes vivent dans leurs commandes communes. Rien
 * ici n'est sur le chemin de la première image.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "itemId invalide" }, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const [item, mayDownload] = await Promise.all([
    jellyfin.getItemFile(session.jfId, itemId).catch(() => null),
    contentDownloadingAllowed(session.jfId).catch(() => false),
  ]);
  // Hors des droits du compte (tags bloqués, bibliothèque non permise) : comme s'il n'existait pas.
  if (!item) return NextResponse.json({ error: "Titre introuvable" }, { status: 404 });
  const size = item.MediaSources?.[0]?.Size;
  const payload: PlayerItemPayload = {
    seriesId: item.Type === "Episode" && item.SeriesId && isJellyfinId(item.SeriesId) ? item.SeriesId : null,
    download: mayDownload ? { sizeBytes: typeof size === "number" && size > 0 ? size : null } : null,
  };
  return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}
