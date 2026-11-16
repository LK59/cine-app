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

  it("« Tout enchaîner » : l'essai, ses gels et ses compteurs, la ligne récapitulative et ses réponses — bornés", () => {
    const line = lumenTestReport(
      {
        auto: { serie: "abc123def456", trial: "ghosted-cra", rank: 8, of: 14, status: "ok", evil: 1 },
        runs: [
          {
            itemId: ITEM,
            cut: "cra",
            trial: "ghosted-cra",
            rank: 8,
            framesPresented: 41_000,
            freezes: [{ at: 600.5, ms: 2400, afterSeek: true, until: "image", x: 1 }, { at: 1, until: "ailleurs" }],
            qualityStart: { total: 10, dropped: 0, corrupted: 0 },
            qualityDelta: { total: 40_990, dropped: 12, corrupted: 0 },
            audioSwitches: [{ from: "0:fr", to: "1:en", ms: 400, waited: false, errors: 0, freezes: 1 }],
          },
        ],
      },
      "louis"
    );
    expect(line.auto).toEqual({ serie: "abc123def456", trial: "ghosted-cra", rank: 8, of: 14, status: "ok" });
    const [run] = line.runs as Record<string, unknown>[];
    expect(run).toMatchObject({ trial: "ghosted-cra", rank: 8, framesPresented: 41_000, qualityStart: { total: 10 }, qualityDelta: { total: 40_990, dropped: 12 } });
    expect(run.freezes).toEqual([{ at: 600.5, ms: 2400, afterSeek: true, until: "image" }, { at: 1 }]);
    expect(run.audioSwitches).toEqual([{ from: "0:fr", to: "1:en", ms: 400, waited: false, errors: 0, freezes: 1 }]);

    const summary = lumenTestReport(
      {
        auto: { serie: "abc123def456", summary: true, of: 14, done: 14, elapsedS: 1834, stopped: false, serieX: "x" },
        trials: [{ trial: "ted-lasso-cra", rank: 12, title: "Ted Lasso S02E01", cut: "cra", status: "ok", firstFrameMs: 1840, seekMedianMs: 1100, freezes: 1, audioSwitches: 3, audioTrouble: 0, injected: "<x>" }, { trial: "PAS UN NOM", status: "fini" }],
        answers: { damaged: "oui", damagedTitle: "Ghosted", audioClean: "pas-entendu", extra: "x" },
      },
      "louis"
    );
    expect(summary.auto).toEqual({ serie: "abc123def456", summary: true, of: 14, done: 14, elapsedS: 1834, stopped: false });
    expect(summary.trials).toEqual([{ trial: "ted-lasso-cra", rank: 12, title: "Ted Lasso S02E01", cut: "cra", status: "ok", firstFrameMs: 1840, seekMedianMs: 1100, freezes: 1, audioSwitches: 3, audioTrouble: 0 }, {}]);
    expect(summary.answers).toEqual({ damaged: "oui", damagedTitle: "Ghosted", audioClean: "pas-entendu" });
    // Une ligne du mode manuel n'en porte rien.
    expect(Object.keys(lumenTestReport({ runs: [] }, "louis"))).toEqual(["build", "env", "runs", "log"]);
  });

  it("le comparatif (étape 3c) : le lecteur, la passe, la graine, ce que le lecteur actuel a ouvert, le tableau — bornés", () => {
    const line = lumenTestReport(
      {
        auto: { serie: "abc123def456", trial: "ghosted-actuel", rank: 8, of: 9, status: "ok", player: "actuel", pass: "courte", seed: 123456789 },
        runs: [
          { itemId: ITEM, player: "actuel", engine: { video: "V_MPEGH/ISO/HEVC 3840×2160", audio: "A_EAC3 6 canaux", sound: "copié tel quel", evil: "x" }, openedAudio: 2, s: "lt0003" },
          { itemId: ITEM, player: "autre", cut: "cra", targetS: 2.5 },
          { itemId: ITEM, player: "serveur", cut: "cra", targetS: 2 },
        ],
      },
      "louis"
    );
    expect(line.auto).toEqual({ serie: "abc123def456", trial: "ghosted-actuel", rank: 8, of: 9, status: "ok", player: "actuel", pass: "courte", seed: 123456789 });
    const [current, bad, server] = line.runs as Record<string, unknown>[];
    expect(current).toMatchObject({ player: "actuel", engine: { video: "V_MPEGH/ISO/HEVC 3840×2160", audio: "A_EAC3 6 canaux", sound: "copié tel quel" }, openedAudio: 2 });
    expect(current.engine).not.toHaveProperty("evil");
    // Le `s` du lecteur actuel n'est pas une lecture de Lumen serveur : pas de relevé.
    expect(current).not.toHaveProperty("srv.req");
    expect(bad).not.toHaveProperty("player");
    expect(bad).not.toHaveProperty("targetS");
    expect(server).toMatchObject({ player: "serveur", cut: "cra", targetS: 2 });
    expect(lumenTestReport({ auto: { pass: "longue", seed: -1, player: "x" } }, "louis").auto).toBeUndefined();

    const summary = lumenTestReport(
      {
        auto: { serie: "abc123def456", summary: true, of: 9, done: 9, pass: "courte", seed: 7 },
        trials: [{ trial: "ghosted-actuel", key: "ghosted", player: "actuel", status: "ok", seekMedianMs: 450, advanceP90Ms: 700, seekedMedianMs: 300, seekedP90Ms: 500 }],
        comparison: [
          { key: "ghosted", title: "Ghosted", targetS: 4, serveur: { status: "ok", firstFrameMs: 900, seekedMedianMs: 620, advanceMedianMs: 1500, x: 1 }, actuel: { status: "ok", advanceMedianMs: 450 }, y: 2 },
        ],
      },
      "louis"
    );
    expect(summary.trials).toEqual([{ trial: "ghosted-actuel", key: "ghosted", player: "actuel", status: "ok", seekMedianMs: 450, advanceP90Ms: 700, seekedMedianMs: 300, seekedP90Ms: 500 }]);
    expect(summary.comparison).toEqual([
      { key: "ghosted", title: "Ghosted", targetS: 4, serveur: { status: "ok", firstFrameMs: 900, seekedMedianMs: 620, advanceMedianMs: 1500 }, actuel: { status: "ok", advanceMedianMs: 450 } },
    ]);
  });

  it("joint le relevé serveur de la lecture — segments, son par piste, trace — pour ce compte seulement", () => {
    const stats = playbackOf("lt0002", { user: "louis", itemId: ITEM, version: "1c1-0123456789ab" });
    noteRequest(stats, "segment");
    noteBuilt(stats, { video: true, n: 4, buildMs: 30, waitMs: 2, diskMs: 10, reused: false });
    noteSent(stats, { kind: "segment", video: true, bytes: 2_000_000, sendMs: 40, aborted: false });
    noteSent(stats, { kind: "segment", video: false, bytes: 100_000, sendMs: 5, aborted: false, track: 3 });
    noteTrace(stats, { name: "v/4.m4s", buildMs: 30, waitMs: 2, sendMs: 40, reused: false, aborted: false, bytes: 4_500_000 });
    const mine = (lumenTestReport({ runs: [{ s: "lt0002" }] }, "louis").runs as Record<string, unknown>[])[0];
    expect(mine).toMatchObject({ "srv.segV": 1, "srv.segA": 1, "srv.buildMs": 30, "srv.version": "1c1-0123456789ab" });
    expect(mine["srv.audioByTrack"]).toEqual({ 3: 1 });
    expect((mine["srv.trace"] as string[])[0]).toMatch(/^\+\d+\.\ds v\/4\.m4s b30 w2 e40 k4395$/);
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

describe("la chronologie (étape 3e, §160)", () => {
  it("garde l'horloge, le débit, le résumé et les cascades, bornés ; les leviers, l'ordre et la passe des leviers", () => {
    const cascade = { k: "saut", to: 600.1, firstReqMs: 40, seekedMs: 600, advanceMs: 1450, aheadSeekedS: 8, aheadAdvanceS: 22, srvMbps: 142, req: ["+40 v/150.m4s r90 f91 l160 k5859", 42, "x".repeat(300)], ev: ["+1 seeking rs1 a-"], evil: "y" };
    const report = lumenTestReport(
      {
        auto: { serie: "abc123def456", trial: "ghosted-serveur-mux", rank: 5, of: 12, pass: "leviers", order: "actuel", mode: "mux" },
        runs: [
          {
            itemId: ITEM,
            player: "serveur",
            mode: "depart-xstart",
            startAt: 600,
            targetFrameMs: 1400,
            firstFrameAt: 0,
            chrono: {
              clock: { offsetMs: 1234.5, rttMs: 22, samples: 5, junk: 1 },
              link: { mbps: 180, ms: 186, via: "rt", MB: 4 },
              rtLumen: 0,
              rtStream: 0,
              summary: { aheadAdvanceS: 22, seekedToAdvanceMs: 850, nope: 3 },
              cascades: Array.from({ length: 40 }, () => cascade),
            },
          },
        ],
        trials: [{ trial: "ghosted-serveur-mux", mode: "mux", chrono: { aheadAdvanceS: 22 }, linkMbps: 180, targetFrameMs: 900 }],
        comparison: [{ key: "ghosted", mode: "mux", serveur: { status: "ok", chrono: { firstReqMs: 40 }, linkMbps: 180 } }],
      },
      "louis"
    );
    expect(report.auto).toMatchObject({ pass: "leviers", order: "actuel", mode: "mux" });
    const run = (report.runs as Record<string, unknown>[])[0];
    expect(run).toMatchObject({ mode: "depart-xstart", startAt: 600, targetFrameMs: 1400, firstFrameAt: 0 });
    const chrono = run.chrono as Record<string, unknown>;
    expect(chrono.clock).toEqual({ offsetMs: 1234.5, rttMs: 22, samples: 5 });
    expect(chrono.link).toEqual({ mbps: 180, ms: 186, via: "rt", MB: 4 });
    expect(chrono.summary).toEqual({ aheadAdvanceS: 22, seekedToAdvanceMs: 850 });
    const cascades = chrono.cascades as Record<string, unknown>[];
    expect(cascades).toHaveLength(24);
    expect(cascades[0]).not.toHaveProperty("evil");
    expect(cascades[0].req).toEqual(["+40 v/150.m4s r90 f91 l160 k5859", "x".repeat(80)]);
    expect(report.trials).toEqual([{ trial: "ghosted-serveur-mux", mode: "mux", chrono: { aheadAdvanceS: 22 }, linkMbps: 180, targetFrameMs: 900 }]);
    expect(report.comparison).toEqual([{ key: "ghosted", mode: "mux", serveur: { status: "ok", chrono: { firstReqMs: 40 }, linkMbps: 180 } }]);
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
