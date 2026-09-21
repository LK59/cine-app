import { describe, it, expect, vi, beforeEach } from "vitest";

// Les annonces de téléchargement partaient à tous les abonnés jusqu'au 21/09/2026.

const subs = [
  { userId: "louis", endpoint: "e1", p256dh: "p", auth: "a" },
  { userId: "mathis", endpoint: "e2", p256dh: "p", auth: "a" },
  { userId: "admin", endpoint: "e3", p256dh: "p", auth: "a" },
];
const sendWebPush = vi.fn(async () => {});
vi.mock("@/lib/webPush", () => ({
  isWebPushConfigured: () => true,
  sendWebPush: (...a: unknown[]) => sendWebPush(...(a as [])),
  shouldRemovePushSubscription: () => false,
}));
vi.mock("@/lib/db", () => ({
  pushDb: { getAll: () => subs, getByUser: (u: string) => subs.filter((s) => s.userId === u), remove: vi.fn() },
  notificationPrefsDb: { getForUser: () => ({ "torrent-complete": true }) },
}));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getUsers: async () => [
      { Id: "1", Name: "louis", Policy: { IsAdministrator: true } },
      { Id: "2", Name: "mathis", Policy: { IsAdministrator: false } },
    ],
  },
}));
vi.mock("@/lib/config", () => ({ config: { app: { adminUser: "admin" } } }));

beforeEach(() => sendWebPush.mockClear());

describe("sendPushToAdmins", () => {
  it("n'envoie qu'aux administrateurs de Jellyfin et au compte local", async () => {
    const { sendPushToAdmins } = await import("@/lib/push");
    await sendPushToAdmins({ title: "Téléchargement terminé", body: "X", category: "torrent-complete" });
    const endpoints = sendWebPush.mock.calls.map((c) => (c as unknown as [{ endpoint: string }])[0].endpoint).sort();
    expect(endpoints).toEqual(["e1", "e3"]);
  });
});
