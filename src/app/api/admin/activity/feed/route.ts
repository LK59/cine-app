import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { alertsClearedAt } from "@/lib/activity/alertsCleared";
import { feedOf, type FeedFilter } from "@/lib/activity/dashboard";
import { preparedUnkept, respondPrepared } from "@/lib/cachedJson";

export const dynamic = "force-dynamic";

const PATHS = new Set(["natif", "serveur", "tv", "horsLigne"]);

/**
 * Le fil des séances filtré par ce qu'on a touché sur le tableau de bord de l'Activité (07/11/2026) :
 * une barre (jour ou heure), un appareil, un titre, un chemin, un compte. Lu dans les séances déjà
 * construites (`seancesSince`) — rien n'est relu des journaux.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const q = req.nextUrl.searchParams;
  const text = (name: string) => {
    const v = q.get(name);
    return v ? v.slice(0, 200) : undefined;
  };
  const period = q.get("period");
  const hour = Number(q.get("hour"));
  const path = q.get("path");
  const filter: FeedFilter = {
    period: period === "day" || period === "month" ? period : "week",
    day: /^\d{4}-\d{2}-\d{2}$/.test(q.get("day") ?? "") ? (q.get("day") as string) : undefined,
    hour: q.has("hour") && Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : undefined,
    device: text("device"),
    title: text("title"),
    path: path && PATHS.has(path) ? (path as FeedFilter["path"]) : undefined,
    user: text("user"),
  };
  return respondPrepared(req, preparedUnkept({ seances: feedOf(filter, Date.now(), alertsClearedAt()) }));
}
