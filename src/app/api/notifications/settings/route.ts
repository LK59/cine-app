import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { notificationPrefsDb } from "@/lib/db";
import { isNotificationCategory, type NotificationCategory } from "@/lib/notifications";

async function getUser(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token).catch(() => null);
}

export async function GET(req: NextRequest) {
  const session = await getUser(req);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });

  return NextResponse.json({ preferences: notificationPrefsDb.getForUser(session.u) });
}

export async function PUT(req: NextRequest) {
  const session = await getUser(req);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const preferences = body?.preferences as Partial<Record<NotificationCategory, boolean>> | undefined;
  if (!preferences || typeof preferences !== "object") {
    return NextResponse.json({ error: "Préférences invalides" }, { status: 400 });
  }

  for (const [category, enabled] of Object.entries(preferences)) {
    if (isNotificationCategory(category) && typeof enabled === "boolean") {
      notificationPrefsDb.set(session.u, category, enabled);
    }
  }

  return NextResponse.json({ preferences: notificationPrefsDb.getForUser(session.u) });
}
