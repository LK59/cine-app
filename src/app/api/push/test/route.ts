import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { pushDb } from "@/lib/db";
import { isWebPushConfigured, sendWebPush, shouldRemovePushSubscription } from "@/lib/webPush";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const session = await verifySessionFull(token).catch(() => null);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });

  if (!isWebPushConfigured()) {
    return NextResponse.json({ error: "VAPID non configuré" }, { status: 503 });
  }

  const subs = pushDb.getByUser(session.u);
  if (subs.length === 0) {
    return NextResponse.json({ error: "Aucune subscription trouvée pour cet utilisateur" }, { status: 404 });
  }

  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        const res = await sendWebPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          { title: "🎬 Cine App", body: "Les notifications push fonctionnent !", icon: "/icon-192.png", badge: "/icon-192.png", tag: "test", url: "/health" }
        );
        return { endpoint: sub.endpoint.slice(0, 40) + "…", status: res.statusCode, ok: true };
      } catch (err: unknown) {
        const e = err as { statusCode?: number; body?: string; message?: string };
        if (shouldRemovePushSubscription(err)) pushDb.remove(sub.endpoint);
        return { endpoint: sub.endpoint.slice(0, 40) + "…", status: e.statusCode, error: e.body ?? e.message ?? String(err), ok: false, removed: shouldRemovePushSubscription(err) };
      }
    })
  );

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results });
}
