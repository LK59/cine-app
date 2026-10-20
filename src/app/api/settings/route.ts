import { NextRequest, NextResponse } from "next/server";
import {
  SECRET_REQUIRED,
  SECRET_REQUIRED_CODE,
  allSettingViews,
  missingRequiredSettings,
  resetSetting,
  saveSettings,
  secretsToResubmit,
  settingValue,
  setupDone,
  urlForLog,
} from "@/lib/settings/setup";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { logAdminAction } from "@/lib/logger";
import { invalidateByPrefix } from "@/lib/server-cache";
import { checkMoviesMount } from "@/lib/repliques/library";

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
  const values = body.values as Record<string, unknown>;
  // La recherche de répliques ne s'allume que si le dossier des films est monté et lisible (§88) :
  // la page grise l'interrupteur, et le serveur refuse quand même — l'interface n'est pas une garde.
  if (values.REPLIQUES_ENABLED === "true") {
    const mount = await checkMoviesMount().catch(() => null);
    if (!mount?.ok) return NextResponse.json({ error: "invalid", errors: { REPLIQUES_ENABLED: "unavailable" } }, { status: 400 });
  }
  // Les adresses qui changent, lues avant l'écriture : après, la nouvelle est déjà « en vigueur ».
  const given = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : "");
  const { changed } = secretsToResubmit(given);
  const previous = changed.map(({ urlKey }) => ({ urlKey, from: settingValue(urlKey) }));
  const { errors } = saveSettings(values);
  if (Object.keys(errors).length > 0) {
    // Un secret à ressaisir a son propre code : l'adresse a changé, la clé enregistrée n'y suit pas.
    const fields = Object.keys(errors).filter((key) => errors[key] === SECRET_REQUIRED);
    const coded = fields.length > 0 ? { code: SECRET_REQUIRED_CODE, fields } : {};
    return NextResponse.json({ error: "invalid", ...coded, errors }, { status: 400 });
  }
  if (previous.length > 0) {
    // Qui a déplacé un service, d'où vers où — jamais le secret ni un identifiant dans l'adresse.
    // Gardé : un journal illisible ne défait pas un enregistrement réussi.
    try {
      const session = await verifySessionFull(req.cookies?.get(SESSION_COOKIE)?.value).catch(() => null);
      for (const { urlKey, from } of previous) {
        logAdminAction(session?.u ?? "?", "adresse d'un service changée", { setting: urlKey, from: urlForLog(from), to: urlForLog(given(urlKey)) });
      }
    } catch {
      /* rien : l'enregistrement est fait */
    }
  }
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
