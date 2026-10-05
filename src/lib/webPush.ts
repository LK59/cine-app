import webpush from "web-push";
import { config } from "@/lib/config";

type PushSubscriptionInput = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

let vapidConfigured = false;

function ensureVapidInit(): boolean {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = config.push.subject;
  if (!publicKey || !privateKey) return false;
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    vapidConfigured = true;
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
