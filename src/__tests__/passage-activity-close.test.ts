import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Fermer une session depuis l'Activité ferme aussi ses jumelles du passage d'adresse (DECISIONS.md
 * §119) — relecture de sécurité du 23/10/2026 : fermer l'une seule laissait l'autre ouverte sur le
 * même jeton Jellyfin, et l'appareil n'était pas révoqué. Vraie base ; Jellyfin et la vérification
 * de l'administrateur sont doublés.
 */

const revoked = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/jellyfinRevoke", () => ({
  revokeJellyfinDevices: vi.fn(async (devices: unknown[]) => void revoked.push(...devices.filter(Boolean))),
  revokeJellyfinToken: vi.fn(async () => undefined),
}));
vi.mock("@/lib/activity/adminOnly", () => ({
  adminOnly: vi.fn(async () => ({ u: "admin", role: "admin", jti: "admin-jti" })),
}));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: { getUsers: vi.fn(async () => [{ Id: "jf-mathis", Name: "mathis" }]) },
}));

beforeEach(async () => {
  revoked.length = 0;
  const { getDb } = await import("@/lib/db");
  getDb().prepare("DELETE FROM sessions").run();
});

function close(jti: string) {
  return new NextRequest("https://cine.example.org/api/admin/activity/accounts/jf-mathis", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "closeSessions", jti }),
  });
}
const params = { params: Promise.resolve({ id: "jf-mathis" }) };

describe("Activité — fermer une session et ses jumelles", () => {
  it("fermer l'origine ferme la jumelle et révoque l'appareil ; une autre session du compte reste", async () => {
    const { sessionDb } = await import("@/lib/db");
    sessionDb.create("origine", "jf-mathis", "iPhone · Safari", "cine-app-partage");
    sessionDb.create("jumelle", "jf-mathis", "iPhone · Laterna", "cine-app-partage");
    sessionDb.create("autre", "jf-mathis", "Mac · Safari", "cine-app-autre");
    const { POST } = await import("@/app/api/admin/activity/accounts/[id]/route");
    const res = await POST(close("jumelle"), params);
    expect(await res.json()).toEqual({ ok: true, closed: 2 });
    expect(sessionDb.exists("origine")).toBe(false);
    expect(sessionDb.exists("jumelle")).toBe(false);
    expect(sessionDb.exists("autre")).toBe(true);
    expect(revoked).toEqual(["cine-app-partage"]);
  });

  it("une session sans jumelle se ferme seule ; celle d'un autre compte n'est pas touchée", async () => {
    const { sessionDb } = await import("@/lib/db");
    sessionDb.create("seule", "jf-mathis", null, "cine-app-seule");
    sessionDb.create("sarah", "jf-sarah", null, "cine-app-seule-sarah");
    const { POST } = await import("@/app/api/admin/activity/accounts/[id]/route");
    expect(await (await POST(close("seule"), params)).json()).toEqual({ ok: true, closed: 1 });
    expect(revoked).toEqual(["cine-app-seule"]);
    expect(await (await POST(close("sarah"), params)).json()).toEqual({ ok: true, closed: 0 });
    expect(sessionDb.exists("sarah")).toBe(true);
  });

  it("la liste des sessions d'un compte dit « jumelle de … »", async () => {
    const { sessionDb } = await import("@/lib/db");
    sessionDb.create("origine", "jf-mathis", "iPhone · Safari", "cine-app-partage");
    sessionDb.create("jumelle", "jf-mathis", "iPhone · Laterna", "cine-app-partage");
    sessionDb.create("autre", "jf-mathis", "Mac · Safari", "cine-app-autre");
    const { appSessionsOf } = await import("@/lib/activity/accounts");
    const byJti = Object.fromEntries(appSessionsOf("jf-mathis").map((s) => [s.jti, s.twinOf]));
    expect(byJti).toEqual({ origine: "iPhone · Laterna", jumelle: "iPhone · Safari", autre: null });
  });
});
