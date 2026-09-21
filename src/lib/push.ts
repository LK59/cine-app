import { notificationPrefsDb, pushDb } from "@/lib/db";
import { isWebPushConfigured, sendWebPush, shouldRemovePushSubscription } from "@/lib/webPush";
import type { NotificationCategory } from "@/lib/notifications";
import { jellyfin } from "@/lib/clients/jellyfin";
import { config } from "@/lib/config";

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

/** Plusieurs comptes nommés, chacun selon ses propres préférences. */
export async function sendPushToUsers(userIds: Iterable<string>, payload: PushPayload): Promise<void> {
  if (!isWebPushConfigured()) return;
  const wanted = new Set(userIds);
  if (wanted.size === 0) return;
  await dispatchPush(pushDb.getAll().filter((sub) => wanted.has(sub.userId)), payload);
}

/**
 * Les administrateurs seulement : les comptes que Jellyfin déclare administrateurs, plus le compte
 * local de secours.
 *
 * Ce qui touche à l'outillage — un torrent qui démarre, qui finit — partait à **tous** les abonnés
 * jusqu'au 21/09/2026, avec un lien vers la page qBittorrent qu'un spectateur ne peut pas ouvrir.
 * Un seul compte était abonné ce jour-là, donc personne d'autre ne l'avait encore reçu.
 */
export async function sendPushToAdmins(payload: PushPayload): Promise<void> {
  if (!isWebPushConfigured()) return;
  const users = await jellyfin.getUsers().catch(() => []);
  const admins = users.filter((u) => u.Policy?.IsAdministrator === true).map((u) => u.Name);
  await sendPushToUsers([...admins, config.app.adminUser], payload);
}
