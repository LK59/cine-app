import { notificationPrefsDb, pushDb } from "@/lib/db";
import { isWebPushConfigured, sendWebPush, shouldRemovePushSubscription } from "@/lib/webPush";
import type { NotificationCategory } from "@/lib/notifications";

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  url?: string;
  category?: NotificationCategory;
}

async function dispatchPush(subs: ReturnType<typeof pushDb.getAll>, payload: PushPayload): Promise<void> {
  if (subs.length === 0) return;

  const userPrefs = new Map<string, Record<string, boolean>>();
  const uniqueUsers = [...new Set(subs.map((s) => s.userId))];
  for (const uid of uniqueUsers) {
    userPrefs.set(uid, notificationPrefsDb.getForUser(uid));
  }

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        if (payload.category && !userPrefs.get(sub.userId)?.[payload.category]) return;
        await sendWebPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          { ...payload, icon: payload.icon ?? "/icon-192.png", badge: "/icon-192.png" }
        );
      } catch (err: unknown) {
        if (shouldRemovePushSubscription(err)) pushDb.remove(sub.endpoint);
      }
    })
  );
}

export async function sendPushToAll(payload: PushPayload): Promise<void> {
  if (!isWebPushConfigured()) return;
  await dispatchPush(pushDb.getAll(), payload);
}

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!isWebPushConfigured()) return;
  await dispatchPush(pushDb.getByUser(userId), payload);
}
