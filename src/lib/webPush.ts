import webpush from "web-push";
import { config } from "@/lib/config";

type PushSubscriptionInput = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

/**
 * Le contact posé avec les clés, ou `null` tant que rien n'est posé. Retenu pour être comparé : le
 * contact (`VAPID_SUBJECT`) se règle dans la Configuration (§48), et il n'était lu qu'au premier
 * envoi — un contact changé n'aurait pris effet qu'au redémarrage, sans que rien ne le dise
 * (13/10/2026, DECISIONS.md §81). Les clés, elles, viennent de l'environnement et ne changent pas.
 */
let vapidSubject: string | null = null;

function ensureVapidInit(): boolean {
  const subject = config.push.subject;
  if (vapidSubject === subject) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    vapidSubject = subject;
    return true;
  } catch {
    return false;
  }
}

export function isWebPushConfigured(): boolean {
  return ensureVapidInit();
}

export async function sendWebPush(
  subscription: PushSubscriptionInput,
  payload: unknown,
) {
  if (!ensureVapidInit()) throw new Error("VAPID non configuré");
  return webpush.sendNotification(subscription, JSON.stringify(payload));
}

export function shouldRemovePushSubscription(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const statusCode = "statusCode" in err ? (err as { statusCode?: number }).statusCode : undefined;
  return statusCode === 404 || statusCode === 410;
}
