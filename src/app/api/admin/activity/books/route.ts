import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * « Lectures » dans l'activité (option des livres, DECISIONS.md §129) : ce que chaque compte lit — en
 * cours, terminé, et le temps de lecture sur sept et trente jours (`readingsOverview`). Réservée à
 * l'administrateur, au proxy (`ADMIN_ONLY_READS`) et ici ; l'option coupée, la route n'existe pas (404) et
 * aucun module des livres n'est chargé.
 *
 * Les titres viennent de l'index commun, vu avec tous les droits (celui de l'administrateur) : un titre
 * caché à un compte par ses tags bloqués reste nommé ici, comme dans les autres vues de l'activité.
 */
export async function GET(req: NextRequest) {
  if (config.books?.enabled !== true) return new NextResponse(null, { status: 404 });
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const [{ bookIndex }, { readingsOverview }] = await Promise.all([import("@/lib/books/bookIndex"), import("@/lib/activity/readings")]);
  // L'index en panne (Jellyfin injoignable) n'empêche pas de lire l'activité : les titres viennent alors du journal.
  const all = await bookIndex({ role: "admin" })
    .then((index) => index.all)
    .catch(() => new Map());
  return NextResponse.json(readingsOverview(all), { headers: { "Cache-Control": "private, no-store" } });
}
