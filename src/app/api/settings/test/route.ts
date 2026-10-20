import { NextRequest, NextResponse } from "next/server";
import { SECRET_REQUIRED, SECRET_REQUIRED_CODE, secretsToResubmit, settingValue } from "@/lib/settings/setup";
import { SETTINGS_BY_KEY, TESTABLE_GROUPS, type TestableGroup } from "@/lib/settings/schema";
import { testService } from "@/lib/settings/testService";

/**
 * Teste un service avec les valeurs en cours de saisie, complétées par les réglages actuels — un
 * secret laissé vide reprend celui qui est enregistré (DECISIONS.md §48). Réservé à
 * l'administrateur : une écriture (POST), que le proxy refuse à tout autre compte.
 *
 * Sauf vers une adresse nouvelle (20/10/2026) : le secret enregistré partait alors vers l'hôte saisi,
 * et un cookie administrateur volé suffisait à faire envoyer chaque clé chez soi. Il faut le ressaisir
 * (`secretsToResubmit`, la même règle que l'enregistrement).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { group?: unknown; values?: unknown } | null;
  const group = body?.group;
  if (typeof group !== "string" || !(TESTABLE_GROUPS as readonly string[]).includes(group)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const given = (body?.values && typeof body.values === "object" ? body.values : {}) as Record<string, unknown>;
  const typed = (key: string) => {
    const v = given[key];
    return typeof v === "string" && SETTINGS_BY_KEY.get(key)?.group === group ? v : "";
  };
  const { missing } = secretsToResubmit(typed, [group]);
  if (missing.length > 0) {
    return NextResponse.json({ ok: false, detail: SECRET_REQUIRED, code: SECRET_REQUIRED_CODE, fields: missing }, { status: 400 });
  }
  const valueOf = (key: string) => {
    const v = given[key];
    if (typeof v === "string" && v.trim() !== "" && SETTINGS_BY_KEY.get(key)?.group === group) return v.trim();
    return settingValue(key);
  };
  return NextResponse.json(await testService(group as TestableGroup, valueOf));
}
