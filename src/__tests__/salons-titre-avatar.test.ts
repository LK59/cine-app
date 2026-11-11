import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Sa propre base : ce fichier écrit des apparences.
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-salons-tv-"));
});

import { signValue, verifyValue, type TvTicket } from "../../salons/src/seal";

const KEY = "k".repeat(40);
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
vi.mock("@/lib/config", () => ({ config: { salons: { key: "k".repeat(40), audience: "tous", url: "http://x" } } }));
const getItemFile = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getItemFile: (...a: unknown[]) => getItemFile(...a) } }));

const ITEM = "0123456789abcdef0123456789abcdef";
const MARIE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAUL = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const req = (body: unknown) => ({ cookies: { get: () => ({ value: "t" }) }, json: async () => body }) as unknown as NextRequest;
const roster = (subs: string[], purpose: "roster" | "result" = "roster") => signValue({ room: "ABCDEF", subs, exp: Date.now() + 60_000 }, KEY, purpose);
const ask = async (body: unknown) => {
  const { POST } = await import("@/app/api/salons/titre/route");
  return (await (await POST(req(body))).json()) as { allowed: boolean; ticket?: string };
};

beforeEach(() => {
  getItemFile.mockReset();
  mockVerifySessionFull.mockResolvedValue({ u: "marie", jfUser: "Marie", jfId: MARIE, role: "user" });
});

/**
 * La télévision commune et l'avatar, côté application (DECISIONS.md §146, étapes 3 et 5) : un titre ne se lance pour
 * un salon que si chaque présent peut le voir — le droit est alors signé pour ce salon et ce titre ; l'apparence est
 * gardée par compte, bornée.
 */
describe("le droit de lancer un titre pour le salon", () => {
  it("tous les présents voient le titre : un droit signé pour ce salon et ce titre", async () => {
    getItemFile.mockResolvedValue({ Id: ITEM });
    const res = await ask({ itemId: ITEM, roster: roster([MARIE, PAUL]) });
    expect(res.allowed).toBe(true);
    expect(getItemFile.mock.calls.map((c) => c[0]).sort()).toEqual([MARIE, PAUL]);
    expect(verifyValue<TvTicket>(res.ticket, KEY, "tv")).toMatchObject({ room: "ABCDEF", itemId: ITEM });
  });

  it("un présent ne peut pas le voir (tag bloqué, bibliothèque) : refusé, sans dire qui", async () => {
    getItemFile.mockImplementation(async (user: string) => (user === PAUL ? null : { Id: ITEM }));
    expect(await ask({ itemId: ITEM, roster: roster([MARIE, PAUL]) })).toEqual({ allowed: false });
  });

  it("une liste des présents fausse, d'un autre usage, sans l'appelant ; un identifiant douteux : refusé", async () => {
    getItemFile.mockResolvedValue({ Id: ITEM });
    expect((await ask({ itemId: ITEM, roster: "v1.x.y" })).allowed).toBe(false);
    expect((await ask({ itemId: ITEM, roster: roster([MARIE], "result") })).allowed).toBe(false);
    expect((await ask({ itemId: ITEM, roster: roster([PAUL]) })).allowed).toBe(false);
    expect((await ask({ itemId: "../../x", roster: roster([MARIE]) })).allowed).toBe(false);
  });
});

describe("l'apparence de l'avatar", () => {
  it("gardée par compte, bornée ; jamais choisie : null", async () => {
    const { GET, PUT } = await import("@/app/api/salons/avatar/route");
    expect(await (await GET(req(null))).json()).toEqual({ look: null });
    expect(await (await PUT(req({ look: [99, 0, 0, 0] }))).json()).toEqual({ saved: false });
    expect(await (await PUT(req({ look: [4, 2, -1, 1] }))).json()).toEqual({ saved: true, look: [4, 2, -1, 1] });
    expect(await (await GET(req(null))).json()).toEqual({ look: [4, 2, -1, 1] });
    mockVerifySessionFull.mockResolvedValue({ u: "paul", jfUser: "Paul", jfId: PAUL, role: "user" });
    expect(await (await GET(req(null))).json()).toEqual({ look: null });
  });
});
