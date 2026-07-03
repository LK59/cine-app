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

export async function sendPushToAll(payload: PushPayload): Promise<void> {
  if (!isWebPushConfigured()) return;
  const subs = pushDb.getAll();
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        if (payload.category && !notificationPrefsDb.isEnabled(sub.userId, payload.category)) return;
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

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!isWebPushConfigured()) return;
  const subs = pushDb.getByUser(userId);
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        if (payload.category && !notificationPrefsDb.isEnabled(sub.userId, payload.category)) return;
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
