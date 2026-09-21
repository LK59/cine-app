import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * « Ce processus est-il vivant ? » — la sonde du `healthcheck` de Docker, et rien d'autre.
 *
 * Pas `/api/health` : celle-là interroge sept services, et un Jellyfin en redémarrage ne rend pas
 * cette application malade — la marquer comme telle, c'est apprendre à ignorer l'alerte. Ici on
 * ne demande que ce qui dépend de ce processus seul :
 *
 * - qu'il réponde, ce qui dit que la boucle d'événements n'est pas prise — une requête SQLite
 *   synchrone qui s'éterniserait la bloquerait, et la sonde avec elle ;
 * - que la base s'ouvre et réponde. `data/` est le seul volume écrit ; un montage perdu ou une
 *   base verrouillée y apparaissent ici en premier.
 *
 * Publique, parce que la sonde n'a pas de cookie : elle ne dit rien d'autre que « oui » ou « non ».
 */
export function GET() {
  try {
    getDb().prepare("SELECT 1").get();
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
