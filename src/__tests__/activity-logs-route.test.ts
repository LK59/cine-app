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
