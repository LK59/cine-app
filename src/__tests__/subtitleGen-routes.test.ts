import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Le contrat des routes `/api/subtitle-gen/*` partagé avec le lecteur (DECISIONS.md §69) : formes
 * des réponses et refus nommés. Le moteur est doublé — il a sa propre suite.
 */
const s = vi.hoisted(() => ({
  session: { u: "emma", jfUser: "emma", jfId: "jf-emma", role: "user", jti: "j" } as Record<string, unknown> | null,
  visible: true,
  create: vi.fn(),
  poll: vi.fn(),
  resume: vi.fn(),
  options: vi.fn(),
  job: null as Record<string, unknown> | null,
  file: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n" as string | null,
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "c" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => s.session }));
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: async () => (s.visible ? null : new Response(null, { status: 404 })) }));
vi.mock("@/lib/subtitleGen/service", () => ({
  createOrJoin: (...a: unknown[]) => s.create(...a),
  pollJob: (...a: unknown[]) => s.poll(...a),
  resume: (...a: unknown[]) => s.resume(...a),
  genOptions: (...a: unknown[]) => s.options(...a),
}));
vi.mock("@/lib/subtitleGen/store", () => ({ jobsDb: { get: () => s.job } }));
vi.mock("@/lib/subtitleGen/files", () => ({ readFinal: () => s.file }));

import { GET as OPTIONS } from "@/app/api/subtitle-gen/options/route";
import { POST as JOBS } from "@/app/api/subtitle-gen/jobs/route";
import { POST as POLL } from "@/app/api/subtitle-gen/jobs/[jobId]/poll/route";
import { POST as RESUME } from "@/app/api/subtitle-gen/jobs/[jobId]/resume/route";
import { GET as FILE } from "@/app/api/subtitle-gen/files/[file]/route";

const ITEM = "a".repeat(32);
const JOB = "f".repeat(32);
const req = (url: string, body?: unknown) =>
  ({ cookies: { get: () => ({ value: "t" }) }, headers: new Headers({ cookie: "cine-lang=fr" }), nextUrl: new URL(`http://x${url}`), json: async () => body }) as unknown as NextRequest;
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  s.session = { u: "emma", jfUser: "emma", jfId: "jf-emma", role: "user", jti: "j" };
  s.visible = true;
  s.job = null;
  s.file = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n";
  vi.clearAllMocks();
});

describe("GET /api/subtitle-gen/options", () => {
  it("rend les options du compte, sous son identité", async () => {
    const payload = { enabled: true, targets: ["fr", "de"], existing: ["en"], jobs: [], quota: { used: 2, limit: 50 } };
    s.options.mockResolvedValue(payload);
    const res = await OPTIONS(req(`/api/subtitle-gen/options?itemId=${ITEM}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(s.options).toHaveBeenCalledWith({ user: "emma", jfId: "jf-emma", locale: "fr" }, ITEM);
  });
  it("refuse un identifiant mal formé et un titre caché au compte", async () => {
    expect((await OPTIONS(req("/api/subtitle-gen/options?itemId=../x"))).status).toBe(400);
    s.visible = false;
    expect((await OPTIONS(req(`/api/subtitle-gen/options?itemId=${ITEM}`))).status).toBe(404);
  });
});

describe("POST /api/subtitle-gen/jobs", () => {
  it("crée ou rejoint, et rend { jobId, status }", async () => {
    s.create.mockResolvedValue({ ok: true, jobId: JOB, status: "preparing" });
    const res = await JOBS(req("/api/subtitle-gen/jobs", { itemId: ITEM, target: "fr", position: 12.5, sessionId: "s1" }));
    expect(await res.json()).toEqual({ jobId: JOB, status: "preparing" });
    expect(s.create).toHaveBeenCalledWith(expect.anything(), { itemId: ITEM, mediaSourceId: undefined, target: "fr", position: 12.5 }, "emma:s1");
  });
  it.each([
    [429, "quota"],
    [402, "budget"],
    [409, "exists"],
    [422, "no-source"],
  ] as const)("rend %i { error: %s }", async (status, error) => {
    s.create.mockResolvedValue({ ok: false, status, error });
    const res = await JOBS(req("/api/subtitle-gen/jobs", { itemId: ITEM, target: "fr" }));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });
  it("refuse un corps invalide", async () => {
    expect((await JOBS(req("/api/subtitle-gen/jobs", { itemId: "x", target: "fr" }))).status).toBe(400);
    expect((await JOBS(req("/api/subtitle-gen/jobs", { itemId: ITEM, target: "fr", mediaSourceId: "../" }))).status).toBe(400);
  });
});

describe("POST /api/subtitle-gen/jobs/<id>/poll", () => {
  it("passe la révision, la position et la séance, et rend la réponse du moteur", async () => {
    const reply = { status: "running", rev: 3, done: 48, total: 1200, presented: false, cues: [{ i: 60, start: 1500, end: 1504, text: "Bonjour" }] };
    s.poll.mockReturnValue(reply);
    const res = await POLL(req(`/api/subtitle-gen/jobs/${JOB}/poll`, { since: 2, position: 1500, sessionId: "s1" }), params({ jobId: JOB }));
    expect(await res.json()).toEqual(reply);
    expect(s.poll).toHaveBeenCalledWith(JOB, 2, 1500, "emma:s1");
  });
  it("404 pour une tâche inconnue, 400 pour un identifiant mal formé", async () => {
    s.poll.mockReturnValue(null);
    expect((await POLL(req(`/api/subtitle-gen/jobs/${JOB}/poll`, { since: 0 }), params({ jobId: JOB }))).status).toBe(404);
    expect((await POLL(req(`/api/subtitle-gen/jobs/x/poll`, {}), params({ jobId: "x" }))).status).toBe(400);
  });
});

describe("POST /api/subtitle-gen/jobs/<id>/resume", () => {
  it("rend le statut d'après, raison comprise", async () => {
    s.resume.mockReturnValue({ id: JOB, status: "paused", reason: "budget" });
    expect(await (await RESUME(req(`/api/subtitle-gen/jobs/${JOB}/resume`), params({ jobId: JOB }))).json()).toEqual({ jobId: JOB, status: "paused", reason: "budget" });
    // Le moteur reçoit qui demande : c'est lui qui refuse la tâche d'un autre compte.
    expect(s.resume).toHaveBeenCalledWith(JOB, { user: "emma", admin: false });
  });
  it("la tâche d'un autre compte n'existe pas (404) ; un administrateur est annoncé comme tel", async () => {
    s.resume.mockReturnValue(null);
    const refused = await RESUME(req(`/api/subtitle-gen/jobs/${JOB}/resume`), params({ jobId: JOB }));
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "not-found" });
    s.session = { u: "louis", jfUser: "louis", jfId: "jf-louis", role: "admin", jti: "j" };
    s.resume.mockReturnValue({ id: JOB, status: "running", reason: null });
    expect((await RESUME(req(`/api/subtitle-gen/jobs/${JOB}/resume`), params({ jobId: JOB }))).status).toBe(200);
    expect(s.resume).toHaveBeenLastCalledWith(JOB, { user: "louis", admin: true });
  });
});

describe("GET /api/subtitle-gen/files/<id>.vtt", () => {
  it("sert le WebVTT d'une tâche finie, session exigée", async () => {
    s.job = { id: JOB, item_id: ITEM, target: "fr", status: "done" };
    const res = await FILE(req(`/api/subtitle-gen/files/${JOB}.vtt`), params({ file: `${JOB}.vtt` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/vtt");
    // Jamais resservi depuis le cache du navigateur sans repasser par `assertVisible` : un autre
    // compte du même appareil l'aurait reçu malgré ses tags bloqués (revue du 20/10/2026).
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(await res.text()).toContain("Bonjour");
    s.session = null;
    expect((await FILE(req(`/api/subtitle-gen/files/${JOB}.vtt`), params({ file: `${JOB}.vtt` }))).status).toBe(401);
  });
  it("404 tant que la tâche n'est pas finie", async () => {
    s.job = { id: JOB, item_id: ITEM, target: "fr", status: "running" };
    expect((await FILE(req(`/api/subtitle-gen/files/${JOB}.vtt`), params({ file: `${JOB}.vtt` }))).status).toBe(404);
  });
});
