import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { lumenTestReport } from "@/lib/lumenServer/testReport";
import { forgetLumenPlaybacks, noteBuilt, noteRequest, noteSent, noteTrace, playbackOf, TRACE_ENTRIES } from "@/lib/lumenServer/playbackStats";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockLog = vi.fn();
vi.mock("@/lib/eventLogs", () => ({ logViewportDiag: (...a: unknown[]) => mockLog(...a) }));
vi.mock("@/lib/writeLimits", () => ({ viewportDiagAllowed: () => true }));

// La ligne `kind: "lumen-test"` de la page de banc `/lumen-test` (étape 3b, DECISIONS.md §157) : le corps du
// navigateur relu et borné, le relevé serveur de chaque lecture joint — pour ce compte seulement —, et
// l'administrateur seul.

const ITEM = "a".repeat(32);

function fakeReq(body: unknown): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" ? { value: "t" } : undefined) },
    headers: new Headers({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15" }),
    json: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetLumenPlaybacks();
  mockVerifySessionFull.mockResolvedValue({ u: "louis", jfUser: "louis", role: "admin" });
});

describe("lumenTestReport", () => {
  it("garde les champs connus, bornés, et laisse tomber le reste", () => {
    const report = lumenTestReport(
      {
        build: "abc",
        env: { userAgent: "UA", standalone: true, hlsNative: "maybe", evil: "x" },
        runs: [
          {
            itemId: ITEM,
            title: "Un titre",
            cut: "cra",
            audio: 2,
            s: "lt0001",
            verdict: { ok: true, segments: 12, longestS: 9.5, extra: 1 },
            firstFrameMs: 812.4,
            firstFrameVia: "rvfc",
            seeks: [
              { kind: "+60", from: 10, to: 70, seekedMs: 300, advanceMs: 900, ok: true, waits: 1, bogus: "x" },
              { kind: "ailleurs", from: 1, to: 2 },
            ],
            errors: ["code=3 decode", 42],
            audioSwitches: [{ from: "0:fr", to: "1:en", ms: 450, reloaded: false, changeEvent: true, heard: "oui" }],
            injected: "<script>",
          },
          { cut: "tout", itemId: "pas-un-id", s: "x" },
        ],
        log: ["ligne", 3, "x".repeat(500)],
      },
      "louis"
    );
    expect(report.env).toEqual({ userAgent: "UA", standalone: true, hlsNative: "maybe" });
    const [run, bad] = report.runs as Record<string, unknown>[];
    expect(run).toMatchObject({ itemId: ITEM, cut: "cra", audio: 2, s: "lt0001", firstFrameMs: 812.4, firstFrameVia: "rvfc" });
    expect(run.verdict).toEqual({ ok: true, segments: 12, longestS: 9.5 });
    expect(run.seeks).toEqual([{ kind: "+60", from: 10, to: 70, seekedMs: 300, advanceMs: 900, ok: true, waits: 1 }, { from: 1, to: 2 }]);
    expect(run.errors).toEqual(["code=3 decode"]);
    expect(run.audioSwitches).toEqual([{ from: "0:fr", to: "1:en", ms: 450, reloaded: false, changeEvent: true, heard: "oui" }]);
    expect(run).not.toHaveProperty("injected");
    expect(bad).toEqual({});
    expect(report.log).toEqual(["ligne", "x".repeat(200)]);
  });

  it("joint le relevé serveur de la lecture — segments, son par piste, trace — pour ce compte seulement", () => {
    const stats = playbackOf("lt0002", { user: "louis", itemId: ITEM, version: "1c1-0123456789ab" });
    noteRequest(stats, "segment");
    noteBuilt(stats, { video: true, n: 4, buildMs: 30, waitMs: 2, diskMs: 10, reused: false });
    noteSent(stats, { kind: "segment", video: true, bytes: 2_000_000, sendMs: 40, aborted: false });
    noteSent(stats, { kind: "segment", video: false, bytes: 100_000, sendMs: 5, aborted: false, track: 3 });
    noteTrace(stats, { name: "v/4.m4s", buildMs: 30, waitMs: 2, sendMs: 40, reused: false, aborted: false });
    const mine = (lumenTestReport({ runs: [{ s: "lt0002" }] }, "louis").runs as Record<string, unknown>[])[0];
    expect(mine).toMatchObject({ "srv.segV": 1, "srv.segA": 1, "srv.buildMs": 30, "srv.version": "1c1-0123456789ab" });
    expect(mine["srv.audioByTrack"]).toEqual({ 3: 1 });
    expect((mine["srv.trace"] as string[])[0]).toMatch(/^\+\d+\.\ds v\/4\.m4s b30 w2 e40$/);
    const other = (lumenTestReport({ runs: [{ s: "lt0002" }] }, "quelquun").runs as Record<string, unknown>[])[0];
    expect(Object.keys(other).some((k) => k.startsWith("srv."))).toBe(false);
  });

  it("la trace est bornée", () => {
    const stats = playbackOf("lt0003", { user: "louis", itemId: ITEM, version: "1-0123456789ab" });
    for (let i = 0; i < TRACE_ENTRIES + 25; i++) noteTrace(stats, { name: `v/${i}.m4s`, buildMs: 1, waitMs: 0, sendMs: 1, reused: i % 2 === 0, aborted: false });
    expect(stats.trace).toHaveLength(TRACE_ENTRIES);
    expect(stats.trace.at(-1)).toContain(`v/${TRACE_ENTRIES + 24}.m4s`);
    expect(stats.trace.at(-1)).toMatch(/ p$/);
  });
});

describe("POST /api/viewport-diag, kind lumen-test", () => {
  it("écrit la ligne au nom de la session, pour l'administrateur", async () => {
    const { POST } = await import("@/app/api/viewport-diag/route");
    const res = await POST(fakeReq({ kind: "lumen-test", user: "autre", runs: [{ itemId: ITEM, cut: "idr" }] }));
    expect(res.status).toBe(204);
    const [fields, kind] = mockLog.mock.calls[0];
    expect(kind).toBe("lumen-test");
    expect(fields).toMatchObject({ user: "louis", runs: [{ itemId: ITEM, cut: "idr" }] });
  });

  it("refuse tout autre compte", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "ami", jfUser: "ami", role: "user" });
    const { POST } = await import("@/app/api/viewport-diag/route");
    const res = await POST(fakeReq({ kind: "lumen-test", runs: [] }));
    expect(res.status).toBe(403);
    expect(mockLog).not.toHaveBeenCalled();
  });
});
