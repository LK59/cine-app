import { notificationPrefsDb, pushDb } from "@/lib/db";
import { taskLog } from "@/lib/taskLog";
import { isWebPushConfigured, sendWebPush, shouldRemovePushSubscription } from "@/lib/webPush";
import type { NotificationCategory } from "@/lib/notifications";
import { jellyfin } from "@/lib/clients/jellyfin";
import { config } from "@/lib/config";
import { logNotificationSent } from "@/lib/eventLogs";
import { LOCALES, type Locale } from "@/lib/i18n";

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  url?: string;
  category?: NotificationCategory;
}

/**
 * Une notification écrite dans chaque langue (25/10/2026) : chaque appareil reçoit celle de son
 * interface (`lang` de l'abonnement), le français quand elle est inconnue — un abonnement d'avant ce
 * jour, jusqu'à ce que l'appareil le renvoie.
 */
export type LocalizedPush = (locale: Locale) => PushPayload;

/**
 * Le même message, lisible aussi par le système (28/10/2026) — la « notification déclarative » de
 * WebKit (Safari 18.4 et plus, iOS et Mac) : `web_push: 8030` et une `notification` toute rédigée,
 * qu'iOS affiche lui-même si notre service worker ne le fait pas à temps. Sans elle, un worker qui
 * échoue à réveiller ou à répondre perd la notification, et iOS peut retirer l'abonnement d'un site
 * dont les messages n'aboutissent pas.
 *
 * `mutable` : le service worker reçoit toujours l'événement et affiche la sienne — icône, badge,
 * vibration, clic, exactement comme avant ; la version du système n'est qu'un filet. Les champs
 * d'avant restent au premier niveau : un navigateur qui ne connaît pas la forme déclarative (Chrome,
 * Firefox, un iPhone plus ancien) et un worker resté sur l'ancien code les lisent comme toujours.
 *
 * `navigate` doit être une adresse complète : celle du site où l'appareil s'est abonné
 * (`pushOrigin`). Une adresse qui en sortirait ramène à son accueil — comme le clic du worker.
 */
export function declarativePush(message: PushPayload, origin: string, lang: string | null) {
  let navigate = `${origin}/`;
  try {
    const target = new URL(message.url ?? "/", origin);
    if (target.origin === origin) navigate = target.href;
  } catch {
    /* l'accueil */
  }
  return {
    ...message,
    web_push: 8030,
    mutable: true,
    notification: {
      title: message.title,
      body: message.body,
      navigate,
      ...(message.tag ? { tag: message.tag } : {}),
      ...(lang ? { lang } : {}),
      silent: false,
    },
  };
}

function payloadFor(payload: PushPayload | LocalizedPush, lang: string | null): PushPayload {
  if (typeof payload !== "function") return payload;
  return payload(LOCALES.includes(lang as Locale) ? (lang as Locale) : "fr");
}

async function dispatchPush(subs: ReturnType<typeof pushDb.getAll>, input: PushPayload | LocalizedPush): Promise<void> {
  if (subs.length === 0) return;
  // Le journal garde la version française : il se lit ici, et une seule ligne par envoi.
  const payload = payloadFor(input, "fr");

  const userPrefs = new Map<string, Record<string, boolean>>();
  const uniqueUsers = [...new Set(subs.map((s) => s.userId))];
  for (const uid of uniqueUsers) {
    userPrefs.set(uid, notificationPrefsDb.getForUser(uid));
  }
  // Ce qu'il est advenu de l'envoi, par compte — pour le journal des notifications.
  const outcome = new Map(uniqueUsers.map((user) => [user, { user, sent: 0, failed: 0, removed: 0, muted: false }]));

  await Promise.allSettled(
    subs.map(async (sub) => {
      const tally = outcome.get(sub.userId)!;
      try {
        if (payload.category && !userPrefs.get(sub.userId)?.[payload.category]) {
          tally.muted = true;
          return;
        }
        const own = payloadFor(input, sub.lang);
        const message = { ...own, icon: own.icon ?? "/icon-192.png", badge: "/badge-96.png" };
        await sendWebPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          sub.origin ? declarativePush(message, sub.origin, sub.lang) : message
        );
        tally.sent += 1;
      } catch (err: unknown) {
        if (shouldRemovePushSubscription(err)) {
          pushDb.remove(sub.endpoint);
          tally.removed += 1;
        } else tally.failed += 1;
      }
    })
  );
  logNotificationSent({ category: payload.category ?? null, title: payload.title, body: payload.body, recipients: [...outcome.values()] });
  const who = [...outcome.values()].map((o) => (o.muted && o.sent === 0 ? `${o.user} (coupée)` : o.failed > 0 ? `${o.user} (${o.sent} envoyée, ${o.failed} en échec)` : o.user));
  taskLog("notifications", `${payload.title} — ${payload.body}`, { pour: who });
}

export async function sendPushToAll(payload: PushPayload): Promise<void> {
  if (!isWebPushConfigured()) return;
  await dispatchPush(pushDb.getAll(), payload);
}

export async function sendPushToUser(userId: string, payload: PushPayload | LocalizedPush): Promise<void> {
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
