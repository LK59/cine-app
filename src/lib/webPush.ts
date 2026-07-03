import webpush from "web-push";

type PushSubscriptionInput = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

function getVapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@cine-app.local";

  if (!publicKey || !privateKey) return null;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return { publicKey, privateKey, subject };
}

export function isWebPushConfigured(): boolean {
  return getVapidConfig() !== null;
}

export async function sendWebPush(
  subscription: PushSubscriptionInput,
  payload: unknown,
) {
  const config = getVapidConfig();
  if (!config) throw new Error("VAPID non configuré");

  return webpush.sendNotification(subscription, JSON.stringify(payload));
}

export function shouldRemovePushSubscription(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const statusCode = "statusCode" in err ? (err as { statusCode?: number }).statusCode : undefined;
  const body = "body" in err ? String((err as { body?: unknown }).body ?? "") : "";

  return (
    statusCode === 404 ||
    statusCode === 410 ||
    (statusCode === 403 && body.includes("BadJwtToken"))
  );
}
