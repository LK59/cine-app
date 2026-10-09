import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * « Effacer les alertes » du panneau Activités (09/10/2026, DECISIONS.md §59) : rien n'est
 * supprimé des journaux, mais ce qui colorait le panneau avant la date d'effacement ne se compte
 * plus — et un nouvel incident se voit aussitôt.
 */
const { DIR } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const DIR = mkdtempSync(`${tmpdir()}/cine-alerts-cleared-`);
  process.env.DATA_DIR = DIR;
  return { DIR };
});

const jf = vi.hoisted(() => ({
  users: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getUsers: async () => jf.users,
    getSessions: async () => [],
    getDevices: async () => [],
  },
}));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: {} }));
// La dernière visite de chaque compte dans l'application, réglée par le test (`tokenStale`).
const appSeen = vi.hoisted(() => ({ map: new Map<string, { count: number; lastSeenAt: number }>() }));
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return { ...real, sessionDb: { ...real.sessionDb, summaryByUser: () => appSeen.map } };
});
const admin = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/activity/adminOnly", async () => {
  const { NextResponse } = await import("next/server");
  return { adminOnly: async () => (admin.ok ? { role: "admin" } : NextResponse.json({ error: "non" }, { status: 403 })) };
});

import { acknowledgeSeance, alertsClearedAt, setAlertsClearedAt } from "@/lib/activity/alertsCleared";
import { buildSeances } from "@/lib/activity/seances";
import { __testing as reader } from "@/lib/activity/logReader";

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-09T20:00:00Z");
const H = 3600_000;
const iso = (t: number) => new Date(t).toISOString();

function writeLog(name: string, lines: Record<string, unknown>[]) {
  fs.mkdirSync(path.join(DIR, "logs"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "logs", name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** Deux séances à incidents : une avant l'effacement (−5 h), une après (−1 h). */
function writeWeek() {
  const seance = (id: string, t: number) => [
    { timestamp: iso(t), kind: "start", session: id, user: "lucas", itemId: "a", title: "Ted Lasso", agent: "Mozilla/5.0 (iPhone)" },
    { timestamp: iso(t + 60_000), kind: "stall", session: id, user: "lucas" },
    { timestamp: iso(t + 120_000), kind: "rebuild", session: id, user: "lucas", reason: "décodeur" },
    { timestamp: iso(t + 180_000), kind: "stop", session: id, user: "lucas", why: "close", watched: 100, waits: 4, waitedMs: 2000 },
  ];
  writeLog("player.log", [...seance("avant", NOW - 5 * H), ...seance("apres", NOW - 1 * H)]);
  writeLog("server.log", [
    { timestamp: iso(NOW - 5 * H), level: "error", scope: "jellyfin-token", user: "lucas", message: "refusé" },
    { timestamp: iso(NOW - 5 * H), level: "error", scope: "client", user: "lucas", message: "TypeError: x" },
    { timestamp: iso(NOW - 5 * H), level: "error", scope: "catalogue", message: "boom" },
  ]);
  writeLog("auth.log", [{ timestamp: iso(NOW - 5 * H), kind: "login-failed", user: "lucas", reason: "mot de passe refusé" }]);
  reader.reset();
}

beforeEach(() => {
  admin.ok = true;
  setAlertsClearedAt(0);
});

describe("une séance acquittée", () => {
  it("perd ses incidents si elle a fini avant l'effacement, les garde sinon", () => {
    const [s] = buildSeances([
      { kind: "start", session: "x", user: "u", itemId: "a", _file: "player.log", _line: 0, _t: 1000 },
      { kind: "stall", session: "x", user: "u", _file: "player.log", _line: 1, _t: 2000 },
      { kind: "stop", session: "x", user: "u", why: "close", waits: 3, waitedMs: 900, _file: "player.log", _line: 2, _t: 3000 },
    ]);
    expect(s.stalls).toBe(1);
    const acked = acknowledgeSeance(s, 5000);
    expect(acked).toMatchObject({ stalls: 0, rebuilds: 0, fallbacks: 0, errors: 0, slowSeeks: 0, incidents: [] });
    expect(acked.stop?.waits).toBe(0);
    // Le reste ne bouge pas : elle est toujours là, avec son temps regardé.
    expect(acked.id).toBe(s.id);
    expect(acknowledgeSeance(s, 2500)).toBe(s);
    expect(acknowledgeSeance(s, 0)).toBe(s);
  });
});

describe("la semaine en chiffres", () => {
  it("ne recompte pas les incidents et erreurs d'avant l'effacement, mais garde toutes les séances", async () => {
    writeWeek();
    const { weekSignals } = await import("@/lib/activity/accounts");
    const before = weekSignals(NOW, 0);
    expect(before).toMatchObject({ seances: 2, stalls: 2, rebuilds: 2, waits: 8, tokenRefusals: 1, clientErrors: 1 });
    expect(before.serverErrors).toEqual([{ scope: "catalogue", count: 1 }]);

    const after = weekSignals(NOW, NOW - 3 * H);
    expect(after).toMatchObject({ seances: 2, stalls: 1, rebuilds: 1, waits: 4, tokenRefusals: 0, clientErrors: 0 });
    expect(after.serverErrors).toEqual([]);
    expect(after.perDay.reduce((n, d) => n + d.problems, 0)).toBe(2);
  });
});

describe("les alertes des comptes", () => {
  it("un jeton refusé effacé disparaît, et revient avec un nouveau refus", async () => {
    writeWeek();
    jf.users = [{ Id: "u1", Name: "lucas", Policy: {}, LastActivityDate: iso(NOW - 2 * H) }];
    const { listAccounts } = await import("@/lib/activity/accounts");
    expect((await listAccounts(NOW, 0))[0].alerts.map((a) => a.kind).sort()).toEqual(["clientErrors", "tokenRefused"]);
    const [cleared] = await listAccounts(NOW, NOW - 3 * H);
    expect(cleared.alerts).toEqual([]);
    // La séance d'après l'effacement compte toujours ses incidents ; celle d'avant, non.
    expect(cleared.week).toMatchObject({ seances: 2, problems: 2 });

    // Un nouveau refus, après l'effacement : l'alerte revient.
    const server = fs.readFileSync(path.join(DIR, "logs", "server.log"), "utf8");
    fs.writeFileSync(
      path.join(DIR, "logs", "server.log"),
      server + JSON.stringify({ timestamp: iso(NOW - 30 * 60_000), level: "error", scope: "jellyfin-token", user: "lucas", message: "refusé" }) + "\n"
    );
    reader.reset();
    expect((await listAccounts(NOW, NOW - 3 * H))[0].alerts.map((a) => a.kind)).toEqual(["tokenRefused"]);
  });
});

describe("un compte que Jellyfin ne voit plus", () => {
  it("un état : effacé, il ne revient que si Jellyfin revoit le compte puis le perd de nouveau", async () => {
    writeWeek();
    // Sans refus ni erreur : seule l'alerte « jeton » est en jeu.
    writeLog("server.log", []);
    reader.reset();
    appSeen.map = new Map([["u1", { count: 1, lastSeenAt: NOW - 10 * 60_000 }]]);
    jf.users = [{ Id: "u1", Name: "lucas", Policy: {}, LastActivityDate: iso(NOW - 3 * 24 * H) }];
    const { listAccounts } = await import("@/lib/activity/accounts");
    expect((await listAccounts(NOW, 0))[0].alerts.map((a) => a.kind)).toEqual(["tokenStale"]);
    expect((await listAccounts(NOW, NOW - 1 * H))[0].alerts).toEqual([]);
    // Jellyfin l'a revu après l'effacement, puis plus rien depuis plus d'un jour : l'alerte revient.
    jf.users = [{ Id: "u1", Name: "lucas", Policy: {}, LastActivityDate: iso(NOW - 2 * 24 * H) }];
    appSeen.map = new Map([["u1", { count: 1, lastSeenAt: NOW }]]);
    expect((await listAccounts(NOW, NOW - 3 * 24 * H))[0].alerts.map((a) => a.kind)).toEqual(["tokenStale"]);
    appSeen.map = new Map();
  });
});

describe("le foyer", () => {
  it("les connexions refusées et les titres en échec d'avant l'effacement ne se comptent plus", async () => {
    writeWeek();
    const { household } = await import("@/lib/activity/accounts");
    expect(household(NOW, 0).logins.failed).toBe(1);
    const h = household(NOW, NOW - 3 * H);
    expect(h.logins.failed).toBe(0);
    expect(h.logins.recentFailures).toEqual([]);
    // La qualité par appareil ne garde que les incidents d'après.
    expect(h.devices[0]).toMatchObject({ seances: 2, stalls: 1, rebuilds: 1 });
  });
});

describe("POST /api/admin/activity/alerts", () => {
  const req = (body: unknown) => ({ json: async () => body }) as never;

  it("efface (une date), réaffiche (zéro), refuse le reste", async () => {
    const { POST } = await import("@/app/api/admin/activity/alerts/route");
    const res = await POST(req({ action: "clear" }));
    expect(res.status).toBe(200);
    expect(alertsClearedAt()).toBeGreaterThan(0);
    expect((await POST(req({ action: "restore" }))).status).toBe(200);
    expect(alertsClearedAt()).toBe(0);
    expect((await POST(req({ action: "rien" }))).status).toBe(400);
  });

  it("est réservé à l'administrateur", async () => {
    admin.ok = false;
    const { POST } = await import("@/app/api/admin/activity/alerts/route");
    expect((await POST(req({ action: "clear" }))).status).toBe(403);
    expect(alertsClearedAt()).toBe(0);
  });
});
