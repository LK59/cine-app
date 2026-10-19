import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Les routes du téléchargement hors ligne (bêta, 19/10/2026) : chacun ne lit et ne retire que ses
 * propres demandes, le fichier ne sert que ce qui est déjà écrit, et la demande respecte le réglage
 * de l'installation et ce que le compte voit.
 */
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const verify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));
const cfg = vi.hoisted(() => ({ offline: true }));
vi.mock("@/lib/config", () => ({ config: { player: { get enabled() { return true; }, get offlineDownloads() { return cfg.offline; } } } }));
const visible = vi.fn();
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: (...a: unknown[]) => visible(...a) }));
const jobs = vi.hoisted(() => ({ request: vi.fn(), jobFor: vi.fn(), forget: vi.fn(), touch: vi.fn() }));
vi.mock("@/lib/offline/jobs", () => ({
  OfflineRefusal: class extends Error {},
  requestOfflineJob: (...a: unknown[]) => jobs.request(...a),
  offlineJobFor: (...a: unknown[]) => jobs.jobFor(...a),
  forgetOfflineJob: (...a: unknown[]) => jobs.forget(...a),
  touchOfflineJob: (...a: unknown[]) => jobs.touch(...a),
  offlineFile: () => "/nonexistent",
}));

import { POST } from "@/app/api/offline/jobs/route";
import { GET as fileGET } from "@/app/api/offline/jobs/[jobId]/file/route";
import { DELETE } from "@/app/api/offline/jobs/[jobId]/route";

const ITEM = "b".repeat(32);
const JOB = "c".repeat(32);
const req = (body?: unknown, headers: Record<string, string> = {}) =>
  ({ cookies: { get: () => ({ value: "t" }) }, headers: new Headers(headers), json: async () => body }) as unknown as NextRequest;
const params = { params: Promise.resolve({ jobId: JOB }) };

beforeEach(() => {
  vi.clearAllMocks();
  cfg.offline = true;
  verify.mockResolvedValue({ u: "mathis", role: "user", jfId: "x", jti: "j" });
  visible.mockResolvedValue(null);
  jobs.request.mockResolvedValue({ id: JOB });
});

describe("POST /api/offline/jobs", () => {
  it("un compte ordinaire demande pour lui-même, avec ses choix", async () => {
    const res = await POST(req({ itemId: ITEM, audioIndex: 1, quality: "high", codec: "hevc" }));
    expect(res.status).toBe(200);
    expect(jobs.request).toHaveBeenCalledWith({ account: "mathis", itemId: ITEM, audioIndex: 1, quality: "high", codec: "hevc" });
  });
  it("réglage coupé, titre caché, demande mal formée : refusés", async () => {
    cfg.offline = false;
    expect((await POST(req({ itemId: ITEM, audioIndex: 1, quality: "high" }))).status).toBe(404);
    cfg.offline = true;
    visible.mockResolvedValue(new Response(null, { status: 404 }));
    expect((await POST(req({ itemId: ITEM, audioIndex: 1, quality: "high" }))).status).toBe(404);
    visible.mockResolvedValue(null);
    expect((await POST(req({ itemId: ITEM, audioIndex: 1, quality: "ultra" }))).status).toBe(400);
    expect((await POST(req({ itemId: "../x", audioIndex: 1, quality: "high" }))).status).toBe(400);
    expect(jobs.request).not.toHaveBeenCalled();
  });
});

describe("GET /api/offline/jobs/:id/file", () => {
  it("la demande d'un autre compte n'existe pas ; au-delà de ce qui est écrit, 416 avec l'état", async () => {
    jobs.jobFor.mockReturnValue(null);
    expect((await fileGET(req(), params)).status).toBe(404);
    jobs.jobFor.mockReturnValue({ id: JOB, status: "running", bytes: 1000, generation: 3 });
    const res = await fileGET(req(undefined, { range: "bytes=1000-2000" }), params);
    expect(res.status).toBe(416);
    expect(res.headers.get("x-offline-bytes")).toBe("1000");
    expect(res.headers.get("x-offline-generation")).toBe("3");
    expect(res.headers.get("x-offline-done")).toBe("0");
  });
});

describe("DELETE /api/offline/jobs/:id", () => {
  it("retire la demande de ce compte-là", async () => {
    expect((await DELETE(req(), params)).status).toBe(204);
    expect(jobs.forget).toHaveBeenCalledWith("mathis", JOB);
  });
});
