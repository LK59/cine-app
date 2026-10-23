import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { LogRecord } from "@/lib/activity/logReader";

/**
 * Le changement d'adresse dans l'Activité (23/10/2026, DECISIONS.md §119) : le statut de chaque
 * compte calculé depuis des lignes de journal factices, la règle des lignes d'avant `host`, et la
 * route réservée à l'administrateur.
 */
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const records: Record<string, LogRecord[]> = { startup: [], auth: [] };
const readRecords = vi.fn((source: string) => records[source] ?? []);
vi.mock("@/lib/activity/logReader", () => ({ readRecords: (source: string) => readRecords(source) }));
const getUsers = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getUsers: () => getUsers() } }));
const news = { laternaAddress: "" };
vi.mock("@/lib/config", () => ({ config: { news } }));

import { ADDRESS_CHANGE_START, addressChangeRows, addressOf, newHostOf } from "@/lib/activity/addressChange";

const NEW = "app.example.org";
const DAY = 86_400_000;
let line = 0;
const open = (user: string, t: number, extra: Record<string, unknown> = {}): LogRecord => ({ kind: "ouverture", user, _t: t, _file: "startup.log", _line: line++, ...extra });
const auth = (user: string, kind: string, t: number): LogRecord => ({ kind, user, _t: t, _file: "auth.log", _line: line++ });
const after = (days: number) => ADDRESS_CHANGE_START + days * DAY;

beforeEach(() => {
  vi.clearAllMocks();
  records.startup = [];
  records.auth = [];
  news.laternaAddress = "";
});

describe("le statut de chaque compte", () => {
  it("dit qui est passé, installé ou non, qui est resté, qui n'a rien ouvert", () => {
    const rows = addressChangeRows(
      ["Louis", "Lucas", "Sarah", "Mathis", "Charlotte"],
      [
        open("louis", after(1), { host: "cine.example.org" }),
        open("Louis", after(2), { host: NEW, standalone: false }),
        open("louis", after(3), { host: NEW, standalone: true }),
        open("lucas", after(2), { host: NEW, standalone: false }),
        open("sarah", after(4), { host: "cine.example.org", standalone: true }),
        // Une seule ouverture, avant le changement : rien depuis.
        open("mathis", ADDRESS_CHANGE_START - 5 * DAY),
        // Un compte hors du foyer (un lien de partage) : ignoré.
        open("partage-0a1b2c3d", after(1), { host: NEW }),
        { kind: "télécommande", user: "charlotte", _t: after(1), _file: "startup.log", _line: line++ },
      ],
      [auth("lucas", "passage-requested", after(1)), auth("lucas", "passage-received", after(2)), auth("sarah", "passage-requested", after(3))],
      NEW
    );
    const by = Object.fromEntries(rows.map((r) => [r.user, r]));
    expect(by.Louis).toMatchObject({ status: "movedInstalled", lastOld: after(1), lastNew: after(3), newInstalled: true });
    expect(by.Lucas).toMatchObject({ status: "moved", newInstalled: false, passageRequested: after(1), passageReceived: after(2) });
    expect(by.Sarah).toMatchObject({ status: "old", lastOld: after(4), lastNew: null, passageRequested: after(3), passageReceived: null });
    expect(by.Mathis).toMatchObject({ status: "never", lastOld: ADDRESS_CHANGE_START - 5 * DAY });
    // Une ligne d'un autre genre que `ouverture` ne compte pas.
    expect(by.Charlotte).toMatchObject({ status: "never", lastOld: null });
    expect(rows.map((r) => r.user)).not.toContain("partage-0a1b2c3d");
    // Ceux qui sont encore sur l'ancienne d'abord, les installés en dernier.
    expect(rows.map((r) => r.status)).toEqual(["old", "never", "never", "moved", "movedInstalled"]);
  });

  it("une ligne sans `host` vaut l'ancienne adresse avant le changement, et « inconnue » après", () => {
    expect(addressOf({ _t: ADDRESS_CHANGE_START - 1 }, NEW)).toBe("old");
    expect(addressOf({ _t: ADDRESS_CHANGE_START + 1 }, NEW)).toBe("unknown");
    expect(addressOf({ _t: ADDRESS_CHANGE_START + 1, host: "APP.example.org" }, NEW)).toBe("new");
    const rows = addressChangeRows(["Raphael"], [open("raphael", after(1))], [], NEW);
    // Ouvert depuis, sans qu'on sache où : ni « encore sur l'ancienne », ni « jamais ouvert ».
    expect(rows[0]).toMatchObject({ status: "unknown", lastUnknown: after(1), lastOld: null });
  });

  it("ne compte pas un passage d'avant le changement", () => {
    const rows = addressChangeRows(["Lucas"], [], [auth("lucas", "passage-requested", ADDRESS_CHANGE_START - DAY)], NEW);
    expect(rows[0].passageRequested).toBeNull();
  });

  it("réduit la nouvelle adresse du réglage à son nom d'hôte", () => {
    expect(newHostOf("https://App.Example.org/")).toBe("app.example.org");
    expect(newHostOf("app.example.org:8443")).toBe("app.example.org");
    expect(newHostOf("")).toBeNull();
    expect(newHostOf("pas une adresse")).toBeNull();
  });
});

describe("GET /api/admin/activity/address", () => {
  const req = () => ({ cookies: { get: () => ({ value: "t" }) } }) as unknown as NextRequest;
  const get = async () => (await import("@/app/api/admin/activity/address/route")).GET(req());

  for (const role of [null, { u: "lucas", role: "user", jti: "x" }, { u: "partage-0a1b2c3d", role: "share", jti: "y" }]) {
    it(`est refusée ${role ? `à un compte « ${role.role} »` : "sans session"}`, async () => {
      mockVerify.mockResolvedValue(role);
      news.laternaAddress = NEW;
      expect((await get()).status).toBe(403);
      expect(readRecords).not.toHaveBeenCalled();
      expect(getUsers).not.toHaveBeenCalled();
    });
  }

  it("sans nouvelle adresse annoncée, ne lit rien et ne montre rien", async () => {
    mockVerify.mockResolvedValue({ u: "louis", role: "admin", jti: "a" });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ newHost: null, rows: [] });
    expect(readRecords).not.toHaveBeenCalled();
  });

  it("donne une ligne par compte actif du foyer à l'administrateur", async () => {
    mockVerify.mockResolvedValue({ u: "louis", role: "admin", jti: "a" });
    news.laternaAddress = `https://${NEW}`;
    getUsers.mockResolvedValue([{ Id: "1", Name: "Louis" }, { Id: "2", Name: "Ancien", Policy: { IsDisabled: true } }]);
    records.startup = [open("louis", after(1), { host: NEW, standalone: true })];
    const body = await (await get()).json();
    expect(body.newHost).toBe(NEW);
    expect(body.rows).toEqual([expect.objectContaining({ user: "Louis", status: "movedInstalled" })]);
  });
});
