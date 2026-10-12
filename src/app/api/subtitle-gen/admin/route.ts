import { NextResponse } from "next/server";
import { adminSummary } from "@/lib/subtitleGen/service";

/**
 * Le panneau des sous-titres générés dans la gestion (DECISIONS.md §69) : réglages effectifs, dépense
 * du mois, tâches. Réservé à l'administrateur (`ADMIN_ONLY_READS` du proxy). La clé n'en sort
 * jamais : seulement `hasKey`.
 */
export async function GET() {
  return NextResponse.json(adminSummary(), { headers: { "Cache-Control": "no-store" } });
}
