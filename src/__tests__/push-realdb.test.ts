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
