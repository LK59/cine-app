import { NextRequest, NextResponse } from "next/server";
import { dashboard } from "@/lib/activity/dashboard";
import { preparedUnkept, respondPrepared } from "@/lib/cachedJson";
import { adminOnly } from "@/lib/activity/adminOnly";
import { household, listAccounts, recentSeances, weekSignals } from "@/lib/activity/accounts";
import { alertsClearedAt } from "@/lib/activity/alertsCleared";
import { statusHistoryDb } from "@/lib/db";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** La vue d'ensemble : qui est là, qui regarde quoi, les comptes, et la semaine en chiffres. */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const now = Date.now();
  // Lue une fois et passée à chaque calcul : les quatre parties voient la même date d'effacement.
  const clearedAt = alertsClearedAt();
  const [accounts, signals] = await Promise.all([listAccounts(now, clearedAt), Promise.resolve(weekSignals(now, clearedAt))]);
  // Compressée, avec son étiquette : relue toutes les dix secondes page ouverte, elle partait en clair
  // (35 Ko) et sans 304 possible (07/11/2026).
  return respondPrepared(
    req,
    preparedUnkept({
      now,
      accounts,
      signals,
      recent: recentSeances(20, now, clearedAt),
      household: household(now, clearedAt),
      dashboard: dashboard(now, clearedAt),
      alertsClearedAt: clearedAt,
      jellyfinDownSince: jellyfinDownSince(),
    })
  );
}

/**
 * Jellyfin injoignable, d'après les relevés de santé de chaque minute (§92) — l'alerte en tête de
 * l'Activité. Dans sa garde : une lecture qui échoue ne doit pas emporter la vue d'ensemble.
 */
function jellyfinDownSince(): number | null {
  try {
    return statusHistoryDb.serviceDownSince("jellyfin");
  } catch (err) {
    logError("activity-jellyfin-down", err);
    return null;
  }
}
