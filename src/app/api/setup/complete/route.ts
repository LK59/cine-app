import { NextResponse } from "next/server";
import { completeSetup, missingRequiredSettings } from "@/lib/settings/setup";

/**
 * « Terminer » l'assistant (DECISIONS.md §48) — réservé à l'administrateur (le proxy refuse toute
 * écriture d'un autre compte, et toute requête sans session). Refusé tant qu'il manque l'un des
 * réglages indispensables ; posé, le drapeau ne se rouvre plus.
 */
export async function POST() {
  const missing = missingRequiredSettings();
  if (missing.length > 0) return NextResponse.json({ error: "missing", missing }, { status: 400 });
  completeSetup();
  return NextResponse.json({ ok: true });
}
