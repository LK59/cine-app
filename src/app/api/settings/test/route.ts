import { NextRequest, NextResponse } from "next/server";
import { settingValue } from "@/lib/settings/setup";
import { SETTINGS_BY_KEY, TESTABLE_GROUPS, type TestableGroup } from "@/lib/settings/schema";
import { testService } from "@/lib/settings/testService";

/**
 * Teste un service avec les valeurs en cours de saisie, complétées par les réglages actuels — un
 * secret laissé vide reprend celui qui est enregistré (DECISIONS.md §48). Réservé à
 * l'administrateur : une écriture (POST), que le proxy refuse à tout autre compte.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { group?: unknown; values?: unknown } | null;
  const group = body?.group;
  if (typeof group !== "string" || !(TESTABLE_GROUPS as readonly string[]).includes(group)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const given = (body?.values && typeof body.values === "object" ? body.values : {}) as Record<string, unknown>;
  const valueOf = (key: string) => {
    const v = given[key];
    if (typeof v === "string" && v.trim() !== "" && SETTINGS_BY_KEY.get(key)?.group === group) return v.trim();
    return settingValue(key);
  };
  return NextResponse.json(await testService(group as TestableGroup, valueOf));
}
