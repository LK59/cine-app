import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { pictureFrameFor } from "@/lib/pictureFrame";
import { logError } from "@/lib/logger";

/**
 * Où est l'image dans le cadre d'un fichier — voir `pictureFrame`.
 *
 * Demandé par le lecteur une fois la lecture lancée, jamais avant : rien n'attend cette réponse.
 * `frame: null` dit « rien à agrandir », quelle qu'en soit la raison — pas de vignettes, pas assez
 * pour conclure, réglage coupé ou Jellyfin muet. Le lecteur montre alors le film comme avant.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "Élément inconnu" }, { status: 400 });
  if (!config.player.enabled || !config.player.autoFrame) return NextResponse.json({ frame: null });
  try {
    return NextResponse.json({ frame: await pictureFrameFor(itemId) });
  } catch (err) {
    logError("picture-frame", err, { itemId });
    return NextResponse.json({ frame: null });
  }
}
