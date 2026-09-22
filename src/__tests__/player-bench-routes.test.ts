import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";

// Les routes du banc d'essai : réservées à l'administrateur, lecture comprise — ce qu'elles lisent
// et écrivent nomme les films que chacun a regardés.

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
vi.mock("@/lib/config", () => ({ config: { player: { enabled: true } } }));
let dir = "";
vi.mock("@/lib/logFile", async (original) => {
  const real = await original<typeof import("@/lib/logFile")>();
  return {
    ...real,
    get LOG_DIR() {
      return dir;
    },
  };
});

function req(body?: unknown): NextRequest {
  return {
    cookies: { get: () => ({ value: "t" }) },
    headers: new Headers({ "user-agent": "iPhone Safari" }),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banc-"));
  mockVerifySessionFull.mockResolvedValue({ u: "admin", role: "admin" });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("/api/player/bench", () => {
  it("refuse un compte ordinaire, en lecture comme en écriture", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "mathis", role: "user" });
    const { GET, POST } = await import("@/app/api/player/bench/route");
    const plan = await import("@/app/api/player/bench/plan/route");
    expect((await POST(req({ kind: "item", runId: "r" }))).status).toBe(403);
    expect((await GET(req())).status).toBe(403);
    expect((await plan.GET(req())).status).toBe(403);
  });

  it("écrit un film puis la série, et les relit en résumé", async () => {
    const { GET, POST } = await import("@/app/api/player/bench/route");
    expect((await POST(req({ kind: "item", runId: "r1", title: "Film", verdict: "fail", checks: [{ verdict: "fail" }, { verdict: "warn" }] }))).status).toBe(200);
    expect((await POST(req({ kind: "run", runId: "r1", depth: "full", elapsedMs: 60000 }))).status).toBe(200);
    const body = await (await GET(req())).json();
    expect(body.runs[0]).toMatchObject({ runId: "r1", finished: true, depth: "full", agent: "iPhone Safari" });
    expect(body.runs[0].items[0]).toMatchObject({ title: "Film", verdict: "fail", fails: 1, warns: 1 });
  });

  it("refuse ce qui n'est pas un rapport du banc", async () => {
    const { POST } = await import("@/app/api/player/bench/route");
    expect((await POST(req("pas du JSON"))).status).toBe(400);
    expect((await POST(req({ kind: "autre", runId: "r" }))).status).toBe(400);
    expect((await POST(req("x".repeat(500_000)))).status).toBe(413);
  });

  it("garde le compte, le navigateur et l'heure du serveur, quoi que dise le rapport", async () => {
    // Chasse aux défauts du 22/09/2026 : le corps était étalé après les champs du serveur, et un
    // rapport pouvait donc se dire d'un autre compte, d'un autre navigateur ou d'un autre jour.
    const { POST } = await import("@/app/api/player/bench/route");
    await POST(req({ kind: "item", runId: "r1", title: "Film", user: "mathis", agent: "Faux", timestamp: "2020-01-01T00:00:00.000Z" }));
    const [line] = fs
      .readFileSync(path.join(dir, "bench.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(line).toMatchObject({ kind: "item", runId: "r1", title: "Film", user: "admin", agent: "iPhone Safari" });
    expect(line.timestamp).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("propose d'abord les films qui ont posé problème, puis chaque sorte de fichier", async () => {
    const line = (o: Record<string, unknown>) => JSON.stringify({ timestamp: "2026-09-22T10:00:00Z", ...o });
    fs.writeFileSync(
      path.join(dir, "player.log"),
      [
        line({ kind: "start", itemId: "a", title: "Bloqué", container: "mkv", video: "hevc 3840x1600 10bit", range: "HDR10" }),
        line({ kind: "stall", itemId: "a" }),
        line({ kind: "start", itemId: "b", title: "Tranquille", container: "mp4", video: "h264 1920x1080 8bit", range: "SDR" }),
        line({ kind: "start", itemId: "c", title: "Vision", container: "mkv", video: "hevc 3840x2160 10bit", range: "DOVIWithHDR10" }),
        line({ kind: "error", itemId: "z" }),
      ].join("\n") + "\n"
    );
    const { GET } = await import("@/app/api/player/bench/plan/route");
    const body = await (await GET(req())).json();
    expect(body.candidates[0]).toMatchObject({ itemId: "a", stalls: 1 });
    expect(body.candidates[0].tags).toEqual(expect.arrayContaining(["HDR", "4K", "blocages"]));
    // Un film sans ligne `start` n'a ni titre ni description : il n'est pas proposé.
    expect(body.candidates.map((c: { itemId: string }) => c.itemId)).not.toContain("z");
    expect(body.suggested).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  it("lit toutes les archives du journal, et les spectateurs seulement", async () => {
    // Le plan lisait `player.log` et `.1` : avec cinq générations, les films des jours d'avant
    // auraient disparu du plan ; et les lignes du banc — ses propres blocages — y comptaient.
    const line = (o: Record<string, unknown>) => JSON.stringify({ timestamp: "2026-09-20T10:00:00Z", ...o }) + "\n";
    fs.writeFileSync(path.join(dir, "player.log.4"), line({ kind: "start", itemId: "ancien", title: "Ancien", container: "mkv", video: "h264", range: "SDR" }));
    fs.writeFileSync(
      path.join(dir, "player.log"),
      line({ kind: "start", itemId: "d", title: "Récent", container: "mp4", video: "h264", range: "SDR" }) +
        // Une archive d'avant la séparation porte encore des lignes du banc.
        line({ kind: "stall", itemId: "d", bench: "banc-1" }) +
        line({ kind: "start", itemId: "banc", title: "Joué par le banc", container: "mkv", video: "hevc", range: "SDR", bench: "banc-1" })
    );
    fs.writeFileSync(path.join(dir, "bench-player.log"), line({ kind: "stall", itemId: "d", bench: "banc-2" }));
    const { GET } = await import("@/app/api/player/bench/plan/route");
    const body = await (await GET(req())).json();
    const ids = body.candidates.map((c: { itemId: string }) => c.itemId);
    expect(ids).toEqual(expect.arrayContaining(["ancien", "d"]));
    expect(ids).not.toContain("banc");
    expect(body.candidates.find((c: { itemId: string }) => c.itemId === "d").stalls).toBe(0);
  });
});
