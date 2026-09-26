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
          { title: "🎬 Cine App", body: "Les notifications push fonctionnent !", icon: "/icon-192.png", badge: "/icon-192.png", tag: "test", url: "/" }
        );
        return { endpoint: sub.endpoint.slice(0, 40) + "…", status: res.statusCode, ok: true };
      } catch (err: unknown) {
        const e = err as { statusCode?: number };
        if (shouldRemovePushSubscription(err)) pushDb.remove(sub.endpoint);
        // Le statut seul, jamais le corps de la réponse ni le message de l'exception : c'était
        // lire, depuis le navigateur, ce que répondait l'adresse enregistrée — n'importe laquelle
        // avant que `isAllowedPushEndpoint` ne les borne (26/09/2026). L'écran ne lit que `ok`.
        return { endpoint: sub.endpoint.slice(0, 40) + "…", status: e.statusCode, error: "Échec de l'envoi", ok: false, removed: shouldRemovePushSubscription(err) };
      }
    })
  );

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results });
}
