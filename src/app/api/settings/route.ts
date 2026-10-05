import { NextRequest, NextResponse } from "next/server";
import { allSettingViews, missingRequiredSettings, resetSetting, saveSettings, setupDone } from "@/lib/settings/setup";
import { invalidateByPrefix } from "@/lib/server-cache";

/**
 * Les réglages de l'installation (DECISIONS.md §48) — lecture réservée à l'administrateur
 * (`ADMIN_ONLY_READS` du proxy), écriture aussi (le proxy refuse toute écriture d'un autre compte).
 * Un secret ne sort jamais : seulement s'il est renseigné, et ses quatre derniers caractères.
 */
export async function GET() {
  return NextResponse.json(
    { settings: allSettingViews(), missing: missingRequiredSettings(), setupDone: setupDone() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** Enregistre des valeurs ; tout ou rien. Les caches des services sont vidés : l'adresse a pu changer. */
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { values?: unknown } | null;
  if (!body || typeof body.values !== "object" || body.values === null) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { errors } = saveSettings(body.values as Record<string, unknown>);
  if (Object.keys(errors).length > 0) return NextResponse.json({ error: "invalid", errors }, { status: 400 });
  invalidateByPrefix("");
  return NextResponse.json({ ok: true, settings: allSettingViews(), missing: missingRequiredSettings() });
}

/** « Revenir à la valeur du .env » : `?key=RADARR_URL`. */
export async function DELETE(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") ?? "";
  if (!resetSetting(key)) return NextResponse.json({ error: "unknown" }, { status: 400 });
  invalidateByPrefix("");
  return NextResponse.json({ ok: true, settings: allSettingViews(), missing: missingRequiredSettings() });
}
