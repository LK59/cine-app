import { describe, it, expect, vi, beforeEach } from "vitest";

// Un dossier de journaux à ce fichier seul : les fichiers de test tournent en parallèle, et deux
// d'entre eux écrivent `player.log` et ses archives.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-activity-`);
});
import fs from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";
import { LOG_DIR } from "@/lib/logFile";

vi.mock("@/lib/activity/adminOnly", () => ({ adminOnly: async () => ({ u: "louis", role: "admin", jti: "a" }) }));

const req = (query: string) => ({ nextUrl: new URL(`https://cine.example/api/admin/activity/logs?${query}`) }) as unknown as NextRequest;

beforeEach(async () => {
  (await import("@/lib/activity/logReader")).__testing.reset();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  for (const f of fs.readdirSync(LOG_DIR)) if (f.startsWith("player.log")) fs.rmSync(path.join(LOG_DIR, f));
  const lines = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 8, 24, 0, 0, from + i)).toISOString(), kind: "seek", n: from + i, user: (from + i) % 2 ? "lucas" : "sarah" }) + "\n").join("");
  fs.writeFileSync(path.join(LOG_DIR, "player.log.1"), lines(0, 150));
  fs.writeFileSync(path.join(LOG_DIR, "player.log"), lines(150, 80));
});

describe("GET /api/admin/activity/logs — pages à travers les archives", () => {
  it("rend les lignes de la plus récente à la plus ancienne, sans en perdre ni en doubler", async () => {
    const { GET } = await import("@/app/api/admin/activity/logs/route");
    const seen: number[] = [];
    let cursor: string | null = "";
    for (let page = 0; page < 5 && cursor !== null; page++) {
      const body = (await (await GET(req(`source=player${cursor ? `&cursor=${cursor}` : ""}`))).json()) as { items: { n: number }[]; nextCursor: string | null; generations: number };
      expect(body.generations).toBe(2);
      seen.push(...body.items.map((i) => i.n));
      cursor = body.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 230 }, (_, i) => 229 - i));
  });

  it("filtre par compte à travers les archives", async () => {
    const { GET } = await import("@/app/api/admin/activity/logs/route");
    const body = (await (await GET(req("source=player&user=sarah"))).json()) as { items: { user: string }[] };
    expect(body.items).toHaveLength(100);
    expect(body.items.every((i) => i.user === "sarah")).toBe(true);
  });
});

/** Un journal écrit à la main dans le dossier de ce fichier — l'heure de chaque ligne au choix. */
function writeLog(name: string, lines: Record<string, unknown>[]) {
  fs.writeFileSync(path.join(LOG_DIR, name), lines.map((l) => JSON.stringify(l) + "\n").join(""));
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Body = { items: Record<string, unknown>[]; nextCursor: string | null; facets?: { users: string[]; types: { name: string; count: number }[]; partial: boolean } };
const get = async (query: string) => {
  const { GET } = await import("@/app/api/admin/activity/logs/route");
  return (await (await GET(req(query))).json()) as Body;
};

describe("GET /api/admin/activity/logs — le journal des ouvertures (14/10/2026)", () => {
  beforeEach(() => {
    for (const f of fs.readdirSync(LOG_DIR)) if (f.startsWith("startup.log")) fs.rmSync(path.join(LOG_DIR, f));
  });

  it("`startup` est une source : ouvertures, télécommande, nouveautés", async () => {
    writeLog("startup.log", [
      { timestamp: ago(3000), kind: "ouverture", user: "louis", cacheUsed: true, cacheMs: 743, networkMs: 1692 },
      { timestamp: ago(2000), kind: "télécommande", user: "timothe", keys: [], pointerMoves: 258 },
      { timestamp: ago(1000), kind: "nouveautés", event: "fenêtre", user: "emma", shownMs: 1554 },
    ]);
    const body = await get("source=startup");
    expect(body.items.map((i) => i.kind)).toEqual(["nouveautés", "télécommande", "ouverture"]);
    expect(body.facets?.users).toEqual(["emma", "louis", "timothe"]);
    // La ligne entière se relit aussi par la route du détail.
    const { GET: line } = await import("@/app/api/admin/activity/logs/line/route");
    const res = await line({ nextUrl: new URL(`https://cine.example/api/admin/activity/logs/line?source=startup&file=startup.log&line=0`) } as unknown as NextRequest);
    expect(((await res.json()) as { kind: string }).kind).toBe("ouverture");
  });
});

describe("GET /api/admin/activity/logs — la recherche voit aussi les traces", () => {
  beforeEach(() => {
    writeLog("player.log", [
      { timestamp: ago(3000), kind: "opening", user: "lucas", steps: `+0 ms ouverture | ${"x".repeat(4000)} | +501 ms saut de l'élément vers 16.4 s` },
      { timestamp: ago(2000), kind: "error", user: "sarah", stack: "TypeError: boom\n    at appendSegment (remux.ts:12)" },
      { timestamp: ago(1000), kind: "error", user: "sarah", reason: `${"y".repeat(300)} fin-de-raison-coupée` },
      { timestamp: ago(500), kind: "seek", user: "lucas" },
    ]);
    fs.rmSync(path.join(LOG_DIR, "player.log.1"));
  });

  it("trouve un mot de `steps` (la fin d'une longue trace), de `stack` et de la fin d'une raison coupée", async () => {
    expect((await get("source=player&q=saut%20de%20l'%C3%A9l%C3%A9ment")).items.map((i) => i.kind)).toEqual(["opening"]);
    expect((await get("source=player&q=appendsegment")).items.map((i) => i.kind)).toEqual(["error"]);
    expect((await get("source=player&q=fin-de-raison")).items).toHaveLength(1);
    expect((await get("source=player&q=introuvable")).items).toHaveLength(0);
  });

  it("l'extrait cherchable ne part pas vers la page", async () => {
    const body = await get("source=player");
    for (const item of body.items) expect(Object.keys(item).every((k) => !k.includes("search") && !k.includes("extract"))).toBe(true);
    expect(body.items.find((i) => i.kind === "opening")?.steps).toBe(true);
  });
});

describe("GET /api/admin/activity/logs — filtres comptés sur la période", () => {
  beforeEach(() => {
    // Deux générations : l'archive porte des lignes d'il y a dix jours, le courant celles d'aujourd'hui.
    writeLog("player.log.1", [
      { timestamp: ago(10 * 864e5), kind: "seek", user: "ancien" },
      { timestamp: ago(10 * 864e5 - 1000), kind: "stall", user: "ancien" },
    ]);
    fs.utimesSync(path.join(LOG_DIR, "player.log.1"), new Date(Date.now() - 10 * 864e5), new Date(Date.now() - 10 * 864e5));
    writeLog("player.log", [
      { timestamp: ago(3 * 864e5), kind: "seek", user: "lucas" },
      { timestamp: ago(2000), kind: "seek", user: "sarah" },
      { timestamp: ago(1000), kind: "stop", user: "sarah" },
    ]);
  });

  it("« 1 jour » ne compte que le jour ; « 30 jours » compte l'archive aussi", async () => {
    const day = await get("source=player&days=1");
    expect(day.facets?.types.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: "seek", count: 1 }, { name: "stop", count: 1 }]);
    expect(day.facets?.users).toEqual(["sarah"]);
    const month = await get("source=player&days=30");
    expect(month.facets?.types.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: "seek", count: 3 }, { name: "stall", count: 1 }, { name: "stop", count: 1 }]);
    expect(month.facets?.users).toEqual(["ancien", "lucas", "sarah"]);
    expect(month.facets?.partial).toBe(false);
  });

  it("ni la page suivante ni le rafraîchissement automatique ne recomptent les filtres", async () => {
    expect((await get("source=player&days=30&facets=0")).facets).toBeUndefined();
    expect((await get("source=player&days=30&cursor=0.1")).facets).toBeUndefined();
  });
});

describe("GET /api/admin/activity/logs — notifications filtrées par destinataire", () => {
  beforeEach(() => {
    writeLog("notifications.log", [
      { timestamp: ago(2000), kind: "torrent-complete", title: "Terminé", body: "a.mkv", recipients: [{ user: "louis", sent: 1, failed: 0, removed: 0, muted: false }] },
      { timestamp: ago(1000), kind: "request-available", title: "Disponible", body: "b", recipients: [{ user: "louis", sent: 1, failed: 0, removed: 0, muted: false }, { user: "lucas", sent: 1, failed: 0, removed: 0, muted: false }] },
    ]);
  });

  it("le filtre « Compte » propose et trouve les destinataires", async () => {
    const all = await get("source=notifications");
    expect(all.facets?.users).toEqual(["louis", "lucas"]);
    expect((await get("source=notifications&user=lucas")).items.map((i) => i.body)).toEqual(["b"]);
    expect((await get("source=notifications&user=louis")).items).toHaveLength(2);
  });
});
