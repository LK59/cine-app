import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Son propre DATA_DIR : le cache disque des index s'y écrit (`indexStore.ts`), et les fichiers servis y
// sont copiés pour pouvoir les « remplacer » au milieu d'une lecture.
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-lumen-routes-"));
});

import { copyFileSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { FIXTURES, parseFragments } from "./lumenServer-helpers";

// Les routes de Lumen serveur (étape 3, DECISIONS.md §156), de bout en bout sur les fichiers des
// fixtures : l'administrateur seul, revérifié par chaque route ; aucune porte pour un laissez-passer de
// diffusion ni un lien de partage ; des statuts qui ne font pas bannir un appareil par CrowdSec (410,
// 409, 503 — jamais 404/400 pour une absence attendue) ; les types, le cache et la longueur déclarée ;
// le relevé d'une lecture.

const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVisible = vi.fn();
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: (...a: unknown[]) => mockVisible(...a) }));
const mockLogError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => mockLogError(...a) }));
vi.mock("@/lib/repliques/playbackActivity", () => ({ noteMediaRead: () => {} }));
const FILES: Record<string, string> = {};
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getItemForAnalysis: async (id: string) => (FILES[id] ? { Id: id, Type: "Movie", MediaSources: [{ Path: `/media/${FILES[id]}` }] } : null),
  },
}));

const DATA = process.env.DATA_DIR!;
const MEDIA = join(DATA, "media");
const H264 = "1".repeat(32);
const CRA = "2".repeat(32);
const NOCUES = "3".repeat(32);
const COPY = "4".repeat(32);
const MISSING = "5".repeat(32);
const ADMIN = { u: "admin", role: "admin", jti: "j-admin" };

beforeAll(() => {
  mkdirSync(MEDIA, { recursive: true });
  for (const f of ["h264-aac.mkv", "hevc-cra.mkv", "h264-nocues.mkv", "h264-short.mkv"]) copyFileSync(resolve(FIXTURES, f), join(MEDIA, f));
  copyFileSync(resolve(FIXTURES, "h264-aac.mkv"), join(MEDIA, "copie.mkv"));
  Object.assign(FILES, { [H264]: "h264-aac.mkv", [CRA]: "hevc-cra.mkv", [NOCUES]: "h264-nocues.mkv", [COPY]: "copie.mkv", [MISSING]: "absent.mkv" });
  process.env.LUMEN_PATH_MAP = `/media=${MEDIA}`;
  process.env.LUMEN_WORKER_PATH = "inline";
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue(ADMIN);
  mockVisible.mockResolvedValue(null);
  delete process.env.CINE_FRAMING_HEADERS;
  await (await import("@/lib/lumenServer/engine")).resetLumenEngine();
  (await import("@/lib/lumenServer/indexCache")).clearLumenIndexCache();
  (await import("@/lib/lumenServer/service")).forgetLumenFiles();
  (await import("@/lib/lumenServer/playbackStats")).forgetLumenPlaybacks();
  (await import("@/lib/lumenServer/segmentCache")).forgetSharedSegments();
});

function request(path: string, init: { cookie?: boolean; method?: string; body?: unknown; headers?: Record<string, string> } = {}): NextRequest {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie !== false) headers.cookie = "cine_session=t";
  return new NextRequest(`https://cine.example${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function eligibility(itemId: string, query = "", init: Parameters<typeof request>[1] = {}) {
  const { GET } = await import("@/app/api/lumen/[itemId]/eligibility/route");
  return GET(request(`/api/lumen/${itemId}/eligibility${query}`, init), { params: Promise.resolve({ itemId }) });
}

async function prepare(itemId: string, body: unknown, init: Parameters<typeof request>[1] = {}) {
  const { POST } = await import("@/app/api/lumen/[itemId]/prepare/route");
  return POST(request(`/api/lumen/${itemId}/prepare`, { ...init, method: "POST", body }), { params: Promise.resolve({ itemId }) });
}

/** `GET` d'une adresse de liste ou de segment, telle que Safari la résout. */
async function get(path: string, init: Parameters<typeof request>[1] = {}) {
  const m = /^\/api\/lumen\/([^/]+)\/([^/]+)\/([^/?]+)\/([^?]+)/.exec(path);
  if (!m) throw new Error(path);
  const { GET } = await import("@/app/api/lumen/[itemId]/[version]/[s]/[...name]/route");
  return GET(request(path, init), { params: Promise.resolve({ itemId: m[1], version: m[2], s: m[3], name: m[4].split("/") }) });
}

async function okVerdict(itemId: string, query = "") {
  const res = await eligibility(itemId, query);
  expect(res.status).toBe(200);
  const verdict = await res.json();
  expect(verdict.ok).toBe(true);
  return verdict as { version: string; master: string; audioTrack: number; segments: number; audio: { number: number; servable: boolean }[] };
}

/** La base d'une lecture (`/api/lumen/{id}/{version}/{s}/`) : les URI relatives des listes s'y résolvent. */
function baseOf(master: string): string {
  return master.slice(0, master.lastIndexOf("/") + 1);
}

describe("l'administrateur lit un titre", () => {
  it("éligibilité, liste maître, listes média, init et segments : types, cache, contenu", async () => {
    const verdict = await okVerdict(H264, "?s=lecture-1");
    expect(verdict.master).toBe(`/api/lumen/${H264}/${verdict.version}/lecture-1/master.m3u8?audio=${verdict.audioTrack}`);
    expect(verdict.version).toMatch(/^5-[0-9a-f]{12}$/);
    const base = baseOf(verdict.master);

    const master = await get(verdict.master);
    expect(master.status).toBe(200);
    expect(master.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(master.headers.get("cache-control")).toBe("private, no-cache");
    expect(master.headers.get("vary")).toBe("Accept-Encoding");
    const text = await master.text();
    expect(text).toMatch(/^#EXTM3U\n/);
    expect(text).toContain("\nv.m3u8\n");
    expect(text).toContain(`URI="a${verdict.audioTrack}.m3u8"`);

    const video = await get(`${base}v.m3u8`);
    expect(video.status).toBe(200);
    expect(video.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    const list = await video.text();
    expect(list).toContain('#EXT-X-MAP:URI="init-v.mp4"');
    expect(list).toContain("\nv/0.m4s\n");

    const init = await get(`${base}init-v.mp4`);
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toBe("video/mp4");
    expect(init.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    const initBytes = new Uint8Array(await init.arrayBuffer());
    expect(String.fromCharCode(...initBytes.subarray(4, 8))).toBe("ftyp");

    const seg = await get(`${base}v/0.m4s`);
    expect(seg.status).toBe(200);
    expect(seg.headers.get("content-type")).toBe("video/mp4");
    expect(seg.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(seg.headers.get("server-timing")).toMatch(/app;dur=\d+, idx;dur=\d+, wait;dur=\d+, build;dur=\d+, disk;dur=\d+/);
    const fragments = parseFragments(new Uint8Array(await seg.arrayBuffer()));
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments[0].trackId).toBe(1);

    const audio = await get(`${base}a${verdict.audioTrack}/0.m4s`);
    expect(audio.status).toBe(200);
    expect(parseFragments(new Uint8Array(await audio.arrayBuffer()))[0].trackId).toBe(2);
    // Jamais `Content-Length` ni `Content-Encoding` posés par la route (DECISIONS.md §131).
    for (const res of [master, video, init, seg, audio]) {
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("content-length")).toBeNull();
    }
  });

  it("déclare la longueur de chaque réponse par le marqueur, quand le serveur de démarrage le traduit", async () => {
    process.env.CINE_FRAMING_HEADERS = "1";
    const verdict = await okVerdict(H264);
    const base = baseOf(verdict.master);
    for (const path of [verdict.master, `${base}v.m3u8`, `${base}init-v.mp4`, `${base}v/1.m4s`, `${base}a${verdict.audioTrack}/1.m4s`]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(res.headers.get("x-cine-length"), path).toBe(String(body.length));
      expect(res.headers.get("content-length"), path).toBeNull();
    }
  });

  it("une requête `Range` reçoit le segment entier, en 200, sans annoncer de plages", async () => {
    const verdict = await okVerdict(H264);
    const res = await get(`${baseOf(verdict.master)}v/0.m4s`, { headers: { range: "bytes=0-99" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });

  it("chaque piste audio servable a sa liste ; une piste non copiable est refusée nommément", async () => {
    const res = await eligibility(CRA, "?audio=4");
    const verdict = await res.json();
    // Opus : à convertir (phase 2) — la raison stable que l'étape 4 journalisera.
    expect(verdict).toMatchObject({ ok: false, reason: "son-codec", audioTrack: 4 });
    expect(verdict.audio.map((a: { number: number; servable: boolean }) => [a.number, a.servable])).toEqual([
      [2, true],
      [3, true],
      [4, false],
    ]);
    const ok = await okVerdict(CRA, "?audio=3");
    const master = await (await get(ok.master)).text();
    expect(master).toContain('URI="a2.m3u8"');
    expect(master).toContain('URI="a3.m3u8"');
    expect(master).not.toContain("a4.m3u8");
    // La liste maître refuse la piste refusée, en 409 avec la raison : jamais une autre langue à la place.
    const refused = await get(`${baseOf(ok.master)}master.m3u8?audio=4`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "lumen-refus", reason: "son-codec" });
  });
});

describe("les refus d'accès", () => {
  it("un compte ordinaire, un lien de partage, une absence de session : refusés par chaque route, avant tout travail", async () => {
    const verdict = await okVerdict(H264);
    const base = baseOf(verdict.master);
    const paths = [verdict.master, `${base}v.m3u8`, `${base}init-v.mp4`, `${base}v/0.m4s`];
    const cases: [unknown, number][] = [
      [{ u: "compte", role: "user", jti: "j", jfId: "f".repeat(32) }, 403],
      [{ u: "partage-0123", role: "share", jti: "j", jfId: "f".repeat(32), sh: "0123456789abcdef" }, 403],
      [null, 401],
    ];
    for (const [session, status] of cases) {
      mockVerify.mockResolvedValue(session);
      for (const path of paths) expect((await get(path)).status, `${path} ${JSON.stringify(session)}`).toBe(status);
      expect((await eligibility(H264)).status).toBe(status);
      expect((await prepare(H264, {})).status).toBe(status);
    }
  });

  it("un laissez-passer de diffusion n'ouvre rien : la route ne lit aucun jeton, le cookie seul compte", async () => {
    const verdict = await okVerdict(H264);
    mockVerify.mockImplementation(async (token: unknown) => (token ? ADMIN : null));
    const res = await get(`${baseOf(verdict.master)}v/0.m4s?castToken=quelconque`, { cookie: false });
    expect(res.status).toBe(401);
    const { castItemOf, castPassFor } = await import("@/lib/castToken");
    expect(castItemOf(`/api/lumen/${H264}/${verdict.version}/lect/v/0.m4s`)).toBeNull();
    const url = new URL(`https://cine.example/api/lumen/${H264}/${verdict.version}/lect/v/0.m4s?castToken=x`);
    expect(await castPassFor({ method: "GET", nextUrl: url })).toBeNull();
  });

  it("un titre caché au compte (`assertVisible`) : la réponse de la vérification, telle quelle", async () => {
    const verdict = await okVerdict(H264);
    mockVisible.mockResolvedValue(new NextResponse(null, { status: 404 }));
    expect((await get(verdict.master)).status).toBe(404);
    expect((await eligibility(H264)).status).toBe(404);
    expect(mockVisible).toHaveBeenCalledWith(ADMIN, H264);
  });
});

describe("des adresses qui ne désignent plus rien : 410, jamais 404 ni 400", () => {
  it("une autre version du fichier ou du format", async () => {
    const verdict = await okVerdict(H264);
    const stale = await get(`/api/lumen/${H264}/5-000000000000/lect/v/0.m4s`);
    expect(stale.status).toBe(410);
    expect(await stale.json()).toMatchObject({ code: "lumen-perime", version: verdict.version });
    // Une adresse du format 4 (d'avant le groupe son unique, §185) : le même fichier, plus rien.
    const format = await get(`/api/lumen/${H264}/${verdict.version.replace(/^5-/, "4-")}/lect/v/0.m4s`);
    expect(format.status).toBe(410);
    expect(await format.json()).toMatchObject({ code: "lumen-perime", format: 5 });
  });

  it("un fichier remplacé en cours de lecture : l'ancienne adresse répond 410 avec la nouvelle version", async () => {
    const verdict = await okVerdict(COPY);
    const base = baseOf(verdict.master);
    expect((await get(`${base}v/0.m4s`)).status).toBe(200);
    // Réécrit à côté puis renommé, comme Radarr : nouvel inode, nouveau mtime.
    const path = join(MEDIA, "copie.mkv");
    writeFileSync(`${path}.new`, readFileSync(resolve(FIXTURES, "h264-short.mkv")));
    const { renameSync } = await import("node:fs");
    renameSync(`${path}.new`, path);
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    const res = await get(`${base}v/1.m4s`);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.code).toBe("lumen-perime");
    expect(body.version).not.toBe(verdict.version);
    // Restauré pour les autres tests.
    copyFileSync(resolve(FIXTURES, "h264-aac.mkv"), path);
  });

  it("un segment hors bornes, une piste absente, un nom mal formé", async () => {
    const verdict = await okVerdict(H264);
    const base = baseOf(verdict.master);
    for (const name of ["v/99.m4s", "a9.m3u8", "a9/0.m4s", "init-a9.mp4", "v/01.m4s", "v/-1.m4s", "x.m3u8", "master.m3u8?audio=abc"]) {
      const res = await get(`${base}${name}`);
      expect(res.status, name).toBe(410);
    }
    expect((await get(`/api/lumen/pas-un-id/${verdict.version}/lect/v/0.m4s`)).status).toBe(410);
    expect((await get(`/api/lumen/${H264}/${verdict.version}/s!/v/0.m4s`)).status).toBe(410);
  });
});

describe("les fichiers non servis", () => {
  it("un refus du fichier : `ok: false` et sa raison ; la liste maître répond 409", async () => {
    const res = await eligibility(NOCUES);
    expect(res.status).toBe(200);
    const verdict = await res.json();
    expect(verdict).toMatchObject({ ok: false, reason: "pas-d-index" });
    const master = await get(`/api/lumen/${NOCUES}/${verdict.version}/lect/master.m3u8`);
    expect(master.status).toBe(409);
    expect(await master.json()).toMatchObject({ reason: "pas-d-index" });
  });

  it("un fichier absent de ce conteneur : `lecture-impossible`", async () => {
    const verdict = await (await eligibility(MISSING)).json();
    expect(verdict).toMatchObject({ ok: false, reason: "lecture-impossible" });
  });
});

describe("la file, l'attente et la préparation", () => {
  it("une file pleine répond 503 « occupé » avec Retry-After, que le client relance", async () => {
    const { lumenEngine } = await import("@/lib/lumenServer/engine");
    const { runLumenJob } = await import("@/lib/lumenServer/jobs");
    const { inlineExecutor } = await import("@/lib/lumenServer/pool");
    lumenEngine({
      concurrency: 1,
      maxQueued: 0,
      executor: inlineExecutor(async (job) => {
        if (job.type === "segment") await new Promise((r) => setTimeout(r, 60));
        return runLumenJob(job);
      }),
    });
    const verdict = await okVerdict(H264);
    const base = baseOf(verdict.master);
    const [a, b] = await Promise.all([get(`${base}v/0.m4s`), get(`${base}v/1.m4s`)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 503]);
    const busy = a.status === 503 ? a : b;
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(await busy.json()).toMatchObject({ code: "lumen-occupe" });
    const { lumenPlaybackStats } = await import("@/lib/lumenServer/playbackStats");
    const s = verdict.master.split("/")[5];
    expect(lumenPlaybackStats(s, "admin")?.busy).toBe(1);
  });

  it("un index encore en construction : 202 `pending`, puis la réponse quand il est prêt", async () => {
    const { lumenEngine } = await import("@/lib/lumenServer/engine");
    const { runLumenJob } = await import("@/lib/lumenServer/jobs");
    const { inlineExecutor } = await import("@/lib/lumenServer/pool");
    lumenEngine({
      executor: inlineExecutor(async (job) => {
        if (job.type === "index") await new Promise((r) => setTimeout(r, 80));
        return runLumenJob(job);
      }),
    });
    const first = await eligibility(H264, "?wait=0");
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ ok: false, pending: true, reason: "index-en-cours" });
    const later = await eligibility(H264, "?wait=5000");
    expect(later.status).toBe(200);
    expect((await later.json()).ok).toBe(true);
  });

  it("`prepare` garde le segment de reprise ; la première requête de Safari le reçoit sans le reconstruire", async () => {
    const res = await prepare(H264, { position: 2.5, s: "lecture-p" });
    expect([200, 202]).toContain(res.status);
    const { sharedSegmentStats } = await import("@/lib/lumenServer/segmentCache");
    await vi.waitFor(() => expect(sharedSegmentStats().held).toBe(2));
    const verdict = await okVerdict(H264, "?s=lecture-p");
    const { segmentAt, lumenIndexOf } = await import("@/lib/lumenServer/service");
    const found = await lumenIndexOf(H264);
    if ("refusal" in found) throw new Error("refus");
    const n = segmentAt(found.index, 2.5);
    const seg = await get(`${baseOf(verdict.master)}v/${n}.m4s`);
    expect(seg.status).toBe(200);
    // Pas construit par cette requête : ni attente ni construction dans `Server-Timing`.
    expect(seg.headers.get("server-timing")).not.toMatch(/build;dur/);
    await seg.arrayBuffer();
    const { lumenPlaybackFields } = await import("@/lib/lumenServer/playbackStats");
    expect(lumenPlaybackFields("lecture-p", "admin")["srv.reused"]).toBe(1);
  });

  it("une préparation refuse comme les autres routes une piste mal formée, sans 400", async () => {
    expect((await prepare(H264, { audio: "deux" })).status).toBe(410);
    expect((await prepare(H264, { s: "!" })).status).toBe(410);
  });
});

describe("le relevé d'une lecture", () => {
  it("compte les segments, les octets, les temps — pour ce compte seulement", async () => {
    const verdict = await okVerdict(H264, "?s=lecture-r");
    const base = baseOf(verdict.master);
    await (await get(verdict.master)).text();
    await (await get(`${base}v.m3u8`)).text();
    await (await get(`${base}init-v.mp4`)).arrayBuffer();
    const v0 = await (await get(`${base}v/0.m4s`)).arrayBuffer();
    const a0 = await (await get(`${base}a${verdict.audioTrack}/0.m4s`)).arrayBuffer();
    await get(`/api/lumen/${H264}/5-000000000000/lecture-r/v/1.m4s`);
    const { lumenPlaybackFields, lumenPlaybackStats } = await import("@/lib/lumenServer/playbackStats");
    const stats = lumenPlaybackStats("lecture-r", "admin")!;
    expect(stats.requests).toEqual({ master: 1, playlist: 1, init: 1, segment: 3 });
    expect(stats.video).toBe(1);
    expect(stats.audio).toBe(1);
    expect(stats.stale).toBe(1);
    expect(stats.bytes).toBeGreaterThanOrEqual(v0.byteLength + a0.byteLength);
    const fields = lumenPlaybackFields("lecture-r", "admin");
    expect(fields).toMatchObject({ "srv.segV": 1, "srv.segA": 1, "srv.stale": 1, "srv.lastN": 0 });
    expect(fields).not.toHaveProperty("srv.errors");
    expect(lumenPlaybackFields("lecture-r", "autre")).toEqual({});
  });

  it("une vraie erreur : 500, comptée à chaque fois, écrite au journal une fois par minute", async () => {
    const { lumenEngine } = await import("@/lib/lumenServer/engine");
    const { runLumenJob } = await import("@/lib/lumenServer/jobs");
    const { inlineExecutor } = await import("@/lib/lumenServer/pool");
    lumenEngine({
      executor: inlineExecutor(async (job) => {
        if (job.type === "segment") throw new Error("disque illisible");
        return runLumenJob(job);
      }),
    });
    const verdict = await okVerdict(H264, "?s=lecture-e");
    const base = baseOf(verdict.master);
    expect((await get(`${base}v/0.m4s`)).status).toBe(500);
    expect((await get(`${base}v/0.m4s`)).status).toBe(500);
    expect(mockLogError).toHaveBeenCalledTimes(1);
    const { lumenPlaybackFields } = await import("@/lib/lumenServer/playbackStats");
    expect(lumenPlaybackFields("lecture-e", "admin")).toMatchObject({ "srv.errors": 2, "srv.lastError": "Error" });
  });
});

describe("le cache disque des index", () => {
  it("un index construit une fois est relu sur le disque par un processus neuf", async () => {
    await okVerdict(H264);
    const dir = join(DATA, "lumen-index");
    expect(readdirSync(dir).filter((f) => f.endsWith(".idx")).length).toBeGreaterThan(0);
    // Un « redémarrage » : moteur et cache mémoire oubliés.
    const { resetLumenEngine } = await import("@/lib/lumenServer/engine");
    await resetLumenEngine();
    (await import("@/lib/lumenServer/indexCache")).clearLumenIndexCache();
    await okVerdict(H264);
    const { lumenServerEngine } = await import("@/lib/lumenServer/service");
    expect(lumenServerEngine().builds).toEqual({ built: 0, fromStore: 1 });
  });
});

describe("la découpe, choisie par l'adresse (§157, §158)", () => {
  it("la règle `cra` sans rien demander ; `?cut=idr` : sa propre version (`5i1-`), ses propres segments", async () => {
    const idr = (await okVerdict(CRA, "?s=lecture-idr&cut=idr")) as Awaited<ReturnType<typeof okVerdict>> & { cutFacts: { cut: string; craRasl: number; trusted: number } };
    const cra = (await okVerdict(CRA, "?s=lecture-cra")) as Awaited<ReturnType<typeof okVerdict>> & { cutFacts: { cut: string; craRasl: number; trusted: number; longestS: number } };
    expect(idr.version).toMatch(/^5i1-[0-9a-f]{12}$/);
    expect(cra.version).toMatch(/^5-[0-9a-f]{12}$/);
    // La même empreinte de fichier : seule la découpe les sépare.
    expect(idr.version.slice(4)).toBe(cra.version.slice(2));
    expect(cra.cutFacts.cut).toBe("cra");
    // L'index des Cues : la CRA de 4 s est prise sans être lue ; `idr` l'a lue, et refusée.
    expect(cra.cutFacts.trusted).toBeGreaterThan(0);
    expect(idr.cutFacts.craRasl).toBeGreaterThan(0);
    expect((await okVerdict(CRA, "?s=lecture-cra&cut=cra")).version).toBe(cra.version);

    const masterCra = await (await get(cra.master)).text();
    expect(masterCra).not.toContain("INDEPENDENT-SEGMENTS");
    const masterIdr = await (await get(idr.master)).text();
    expect(masterIdr).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    const listCra = await (await get(`${baseOf(cra.master)}v.m3u8`)).text();
    const listIdr = await (await get(`${baseOf(idr.master)}v.m3u8`)).text();
    // Le fichier de 6 s : un segment sous la règle (une seule IDR), deux en coupant sur la CRA de 4 s.
    expect(listIdr.match(/\.m4s/g)).toHaveLength(1);
    expect(listCra.match(/\.m4s/g)).toHaveLength(2);
    const seg = await get(`${baseOf(cra.master)}v/1.m4s`);
    expect(seg.status).toBe(200);
    expect(parseFragments(new Uint8Array(await seg.arrayBuffer()))[0].samples[0].flags).toBe(0x02000000);
    // Le segment 1 n'existe pas sous la règle : 410, jamais les octets de l'autre découpe.
    expect((await get(`${baseOf(idr.master)}v/1.m4s`)).status).toBe(410);
  });

  it("`prepare` porte la découpe ; une découpe inconnue répond 410, jamais 400", async () => {
    const res = await prepare(CRA, { s: "lecture-prep", cut: "cra-leading" });
    expect([200, 202]).toContain(res.status);
    const again = await okVerdict(CRA, "?s=lecture-prep&cut=cra-leading");
    expect(again.version).toMatch(/^5l1-/);
    expect((await eligibility(CRA, "?cut=tout")).status).toBe(410);
    expect((await prepare(CRA, { cut: "tout" })).status).toBe(410);
    expect((await prepare(CRA, { cut: 3 })).status).toBe(410);
  });

  it("`target` : une cible d'essai dans la version (`5t2-`), une autre répond 410, jamais 400", async () => {
    const two = await okVerdict(H264, "?s=lecture-t2&target=2");
    const four = await okVerdict(H264, "?s=lecture-t4");
    expect(two.version).toMatch(/^5t2-[0-9a-f]{12}$/);
    expect(two.version.slice(4)).toBe(four.version.slice(2));
    expect(two.segments).toBeGreaterThan(four.segments);
    expect((await get(two.master)).status).toBe(200);
    expect((await get(`${baseOf(two.master)}v/${two.segments - 1}.m4s`)).status).toBe(200);
    expect((await okVerdict(H264, "?s=lecture-t4&target=4")).version).toBe(four.version);
    expect((await eligibility(H264, "?target=5")).status).toBe(410);
    expect((await prepare(H264, { target: 5 })).status).toBe(410);
    const prepared = await prepare(H264, { s: "lecture-t2p", target: 2 });
    expect([200, 202]).toContain(prepared.status);
  });

  it("une version d'une découpe ou d'une révision inconnue : 410 « autre version du format »", async () => {
    const idr = await okVerdict(CRA, "?s=lecture-x");
    const hash = idr.version.slice(2);
    const res = await get(`/api/lumen/${CRA}/1z9-${hash}/lecture-x/master.m3u8`);
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("lumen-perime");
  });
});

describe("la garde de la suite", () => {
  // Une route de plus sous /api/lumen qui oublierait le contrôle d'accès serait ouverte à tout compte
  // muni d'une session dès que le motif du proxy changerait — et à rien d'autre : chaque route le pose.
  it("chaque route sous /api/lumen passe par `lumenAccess` (directement ou par `serveLumenName`)", () => {
    const dir = "src/app/api/lumen";
    const routes = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith("route.ts"));
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const route of routes) {
      const source = readFileSync(join(dir, route), "utf8");
      expect(source, route).toMatch(/lumenAccess\(req, itemId\)|serveLumenName\(req, /);
      // Aucun jeton de diffusion lu tant que la portée `lumen` n'existe pas (étape AirPlay).
      expect(source, route).not.toMatch(/castPass|castToken|verifyCastToken/);
    }
    const serve = readFileSync("src/lib/lumenServer/serve.ts", "utf8");
    // L'accès est vérifié avant la moindre lecture de fichier ou d'index.
    expect(serve.indexOf("lumenAccess(req, itemId)")).toBeGreaterThan(0);
    expect(serve.indexOf("lumenAccess(req, itemId)")).toBeLessThan(serve.indexOf("lumenIndexOf(itemId"));
    expect(readFileSync("src/proxy.ts", "utf8")).toContain("/^\\/api\\/lumen(\\/|$)/");
  });
});
