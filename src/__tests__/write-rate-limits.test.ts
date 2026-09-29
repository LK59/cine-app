import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

// D12 (29/09/2026) : les écritures ouvertes à tout compte n'avaient aucune limite de débit — un
// client qui boucle faisait tourner les 600 Mo de `player.log` en quelques minutes —, et les
// images des commentaires de signalement échappaient au plafond du jour : environ 18 Go par jour
// et par compte sur le disque de l'hôte.

vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-write-limits-`);
});

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
/** Un compte par cookie : chaque test prend les siens, les compteurs vivent au niveau du module. */
const account = (name: string, role: "user" | "admin" = "user") => ({ u: name, jfUser: name, jfId: `id-${name}`, role, jti: `j-${name}` });
const SESSIONS: Record<string, unknown> = {};
for (const name of ["ana", "ben", "cleo", "dan", "eve", "fred", "gus", "hugo", "iris", "jade", "kim"]) SESSIONS[name] = account(name);
SESSIONS.root = account("root", "admin");
vi.mock("@/lib/session", () => ({ verifySessionFull: async (token: string) => SESSIONS[token] ?? null }));

const logged = { player: vi.fn(), client: vi.fn(), startup: vi.fn() };
vi.mock("@/lib/playerLog", () => ({
  logPlaybackEvent: (...a: unknown[]) => logged.player(...a),
  isPlayerEventKind: (v: unknown) => ["start", "stop", "reserve", "seek"].includes(v as string),
}));
vi.mock("@/lib/logger", () => ({ logClientError: (...a: unknown[]) => logged.client(...a), logError: () => {} }));
vi.mock("@/lib/eventLogs", () => ({ logStartupTiming: (...a: unknown[]) => logged.startup(...a) }));
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  return { config: new Proxy(actual.config, { get: (t, k) => (k === "player" ? { enabled: true } : (t as Record<string | symbol, unknown>)[k]) }) };
});
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getUsers: async () => [], getItemRunTimeTicks: async () => 0 } }));
vi.mock("@/lib/push", () => ({ sendPushToAdmins: async () => {}, sendPushToUser: async () => {} }));

function req(who: string, init: { json?: unknown; form?: FormData } = {}): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" ? { value: who } : undefined) },
    headers: new Headers({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)" }),
    nextUrl: new URL("https://cine.example/api/x"),
    json: async () => init.json ?? {},
    formData: async () => init.form ?? new FormData(),
  } as unknown as NextRequest;
}

/** Envoie `n` écritures du même compte et rend les statuts. */
async function burst(n: number, send: () => Promise<Response>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send()).status);
  return out;
}

describe("limite de débit par compte sur les écritures ouvertes (D12)", () => {
  it("POST /api/player/log : au-delà du seuil, 429 — un autre compte passe", async () => {
    const { POST } = await import("@/app/api/player/log/route");
    const { WRITE_LIMITS } = await import("@/lib/writeLimits");
    const line = { kind: "reserve", fields: { phase: "point" } };
    const statuses = await burst(WRITE_LIMITS.playerLog.max, () => POST(req("ana", { json: line })));
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect((await POST(req("ana", { json: line }))).status).toBe(429);
    expect((await POST(req("ben", { json: line }))).status).toBe(200);
  });

  it("POST /api/player/log : les lignes du banc d'un administrateur ne sont pas bridées", async () => {
    const { POST } = await import("@/app/api/player/log/route");
    const { WRITE_LIMITS } = await import("@/lib/writeLimits");
    const statuses = await burst(WRITE_LIMITS.playerLog.max + 20, () => POST(req("root", { json: { kind: "seek", fields: { bench: "b-1" } } })));
    expect(statuses.every((s) => s === 200)).toBe(true);
    // Un compte ordinaire qui pose `bench` n'y gagne rien : le champ lui est retiré, et la limite reste.
    const forged = await burst(WRITE_LIMITS.playerLog.max + 1, () => POST(req("cleo", { json: { kind: "seek", fields: { bench: "b-1" } } })));
    expect(forged.at(-1)).toBe(429);
  });

  it("POST /api/client-error : au-delà du seuil, 429 — un autre compte passe", async () => {
    const { POST } = await import("@/app/api/client-error/route");
    const { WRITE_LIMITS } = await import("@/lib/writeLimits");
    const body = { source: "window", message: "boom" };
    const statuses = await burst(WRITE_LIMITS.clientError.max, () => POST(req("dan", { json: body })));
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect((await POST(req("dan", { json: body }))).status).toBe(429);
    expect((await POST(req("eve", { json: body }))).status).toBe(200);
  });

  it("POST /api/startup-timing : au-delà du seuil, 429 — un autre compte passe", async () => {
    const { POST } = await import("@/app/api/startup-timing/route");
    const { WRITE_LIMITS } = await import("@/lib/writeLimits");
    const body = { cacheUsed: true, cacheMs: 100 };
    const statuses = await burst(WRITE_LIMITS.startupTiming.max, () => POST(req("fred", { json: body })));
    expect(statuses.every((s) => s === 204)).toBe(true);
    expect((await POST(req("fred", { json: body }))).status).toBe(429);
    expect((await POST(req("gus", { json: body }))).status).toBe(204);
  });

  it("POST /api/reports/[id]/messages : au-delà du seuil, 429 — un autre compte passe", async () => {
    const { reportsDb } = await import("@/lib/db");
    const { POST } = await import("@/app/api/reports/[id]/messages/route");
    const { WRITE_LIMITS } = await import("@/lib/writeLimits");
    const fields = { zone: "home", element: null, elementOther: null, issue: null, issueOther: null, itemId: null, itemTitle: null, itemKind: null, description: "x" };
    const mine = reportsDb.create("id-hugo", "hugo", fields, false, null);
    const theirs = reportsDb.create("id-iris", "iris", fields, false, null);
    const comment = (who: string, id: number) => {
      const form = new FormData();
      form.set("body", "encore");
      return POST(req(who, { form }), { params: Promise.resolve({ id: String(id) }) });
    };
    const statuses = await burst(WRITE_LIMITS.reportMessages.max, () => comment("hugo", mine.id));
    expect(statuses.every((s) => s === 201)).toBe(true);
    const refused = await comment("hugo", mine.id);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "quota" });
    expect((await comment("iris", theirs.id)).status).toBe(201);
  });
});

describe("les images des commentaires comptent dans le plafond du jour (D12)", () => {
  const tiny = (name: string) => new File([new Uint8Array([0, 1, 2, 3])], name, { type: "image/png" });

  it("refuse une image de commentaire au-delà du plafond d'images sur 24 heures", async () => {
    const { reportsDb } = await import("@/lib/db");
    const { POST } = await import("@/app/api/reports/[id]/messages/route");
    const { MAX_IMAGES, MAX_IMAGES_PER_DAY, MAX_IMAGES_PER_REPORT } = await import("@/lib/reportLimits");
    // Sous le plafond de chaque fil, au-dessus de celui du jour : c'est ce qui laissait passer
    // 18 Go, un fil après l'autre.
    expect(MAX_IMAGES_PER_DAY).toBeGreaterThan(MAX_IMAGES_PER_REPORT);
    const fields = { zone: "home", element: null, elementOther: null, issue: null, issueOther: null, itemId: null, itemTitle: null, itemKind: null, description: "x" };
    let sent = 0;
    let last: Response | null = null;
    // Des fils successifs, chacun rempli jusqu'à son propre plafond — le jour doit arrêter avant.
    for (let round = 0; round < Math.ceil(MAX_IMAGES_PER_DAY / MAX_IMAGES_PER_REPORT) + 1 && !last; round++) {
      const report = reportsDb.create("id-jade", "jade", fields, false, null);
      for (let inReport = 0; inReport + MAX_IMAGES <= MAX_IMAGES_PER_REPORT; inReport += MAX_IMAGES) {
        const form = new FormData();
        for (let i = 0; i < MAX_IMAGES; i++) form.append("images", tiny(`c${sent + i}.png`));
        const res = await POST(req("jade", { form }), { params: Promise.resolve({ id: String(report.id) }) });
        if (res.status !== 201) {
          last = res;
          break;
        }
        sent += MAX_IMAGES;
      }
    }
    expect(last?.status).toBe(429);
    expect(await last!.json()).toMatchObject({ code: "quota" });
    expect(sent).toBeLessThanOrEqual(MAX_IMAGES_PER_DAY);
    expect(sent + MAX_IMAGES).toBeGreaterThan(MAX_IMAGES_PER_DAY);
  }, 60_000);
});
