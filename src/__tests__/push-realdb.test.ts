import { describe, it, expect, vi, beforeEach } from "vitest";

// Une vraie base SQLite, à ce fichier seul : le défaut que ce test garde n'existait que là.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-push-realdb-`);
});

// Seuls l'envoi réel, Jellyfin et le journal sont doublés — `pushDb` et les préférences sont les vrais.
const sendWebPush = vi.fn(async () => {});
vi.mock("@/lib/webPush", () => ({
  isWebPushConfigured: () => true,
  sendWebPush: (...a: unknown[]) => sendWebPush(...(a as [])),
  shouldRemovePushSubscription: () => false,
}));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: { getUsers: async () => [{ Id: "1", Name: "alice", Policy: { IsAdministrator: true } }] },
}));
const logNotificationSent = vi.fn();
vi.mock("@/lib/eventLogs", () => ({ logNotificationSent: (...a: unknown[]) => logNotificationSent(...a) }));

/**
 * `pushDb.getAll` / `getByUser` faisaient `SELECT *` : les rangées portaient `user_id`, le type et
 * `push.ts` lisaient `userId` — toujours `undefined`. Les notifications réservées aux
 * administrateurs ne partaient vers personne, les catégories coupées par un compte partaient
 * quand même, et le journal des notifications n'avait aucun destinataire nommé. Les tests de
 * `push.ts` doublaient `db` avec des objets déjà en `userId`, d'où le silence.
 */
describe("notifications — lecture des abonnements sur la vraie base", () => {
  beforeEach(() => {
    sendWebPush.mockClear();
    logNotificationSent.mockClear();
  });

  it("getAll et getByUser rendent userId et createdAt", async () => {
    const { pushDb } = await import("@/lib/db");
    pushDb.upsert("alice", "https://web.push.apple.com/e1", "p", "a");
    for (const row of [pushDb.getAll()[0], pushDb.getByUser("alice")[0]]) {
      expect(row.userId).toBe("alice");
      expect(typeof row.createdAt).toBe("number");
      expect(row).not.toHaveProperty("user_id");
    }
  });

  it("sendPushToAdmins atteint l'abonnement de l'administrateur, nommé au journal", async () => {
    const { sendPushToAdmins } = await import("@/lib/push");
    await sendPushToAdmins({ title: "t", body: "b", category: "torrent-complete" });
    expect(sendWebPush).toHaveBeenCalledTimes(1);
    const recipients = logNotificationSent.mock.calls[0][0].recipients;
    expect(recipients).toEqual([expect.objectContaining({ user: "alice", sent: 1 })]);
  });

  it("une catégorie coupée par le compte n'est pas envoyée", async () => {
    const { notificationPrefsDb } = await import("@/lib/db");
    const { sendPushToUser } = await import("@/lib/push");
    notificationPrefsDb.set("alice", "new-episode", false);
    await sendPushToUser("alice", { title: "t", body: "b", category: "new-episode" });
    expect(sendWebPush).toHaveBeenCalledTimes(0);
  });
});

// 25/10/2026 : chaque appareil reçoit la notification dans la langue de son interface, sans être
// réabonné — la langue arrive avec un renvoi de l'abonnement, ou à l'ouverture du cinéma.
describe("notifications — la langue de chaque appareil", () => {
  beforeEach(() => {
    sendWebPush.mockClear();
    logNotificationSent.mockClear();
  });

  it("chaque abonnement reçoit sa langue, le français s'il n'en a pas ; le journal garde le français", async () => {
    const { pushDb } = await import("@/lib/db");
    const { sendPushToUser } = await import("@/lib/push");
    pushDb.upsert("bob", "https://web.push.apple.com/b-en", "p", "a", "en");
    pushDb.upsert("bob", "https://web.push.apple.com/b-none", "p", "a");
    await sendPushToUser("bob", (locale) => ({ title: locale, body: `body-${locale}`, category: "request-available" }));
    const sent = (sendWebPush.mock.calls as unknown as [{ endpoint: string }, { title: string }][]).map(([sub, p]) => [sub.endpoint, p.title]).sort();
    expect(sent).toEqual([["https://web.push.apple.com/b-en", "en"], ["https://web.push.apple.com/b-none", "fr"]]);
    expect(logNotificationSent.mock.calls[0][0].title).toBe("fr");
  });

  it("un renvoi sans langue garde celle qu'on avait ; l'ouverture ne remplit que les vides", async () => {
    const { pushDb } = await import("@/lib/db");
    pushDb.upsert("carol", "https://web.push.apple.com/c1", "p", "a", "de");
    pushDb.upsert("carol", "https://web.push.apple.com/c1", "p", "a");
    pushDb.upsert("carol", "https://web.push.apple.com/c2", "p", "a");
    pushDb.fillMissingLang("carol", "es");
    const langs = Object.fromEntries(pushDb.getByUser("carol").map((s) => [s.endpoint, s.lang]));
    expect(langs).toEqual({ "https://web.push.apple.com/c1": "de", "https://web.push.apple.com/c2": "es" });
  });
});
