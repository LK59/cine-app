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
// Les sessions vivantes, pour le laissez-passer d'une Apple TV (§186) : il meurt avec la sienne.
const liveSessions = new Set(["j-admin"]);
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return { ...real, sessionDb: { ...real.sessionDb, exists: (jti: string) => liveSessions.has(jti) } };
});
const castPositions: { pass: unknown; start: number }[] = [];
vi.mock("@/lib/castProgress", () => ({ castProgressRelay: () => ({ noteCastPosition: (pass: unknown, start: number) => castPositions.push({ pass, start }) }) }));
const mockVisible = vi.fn();
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: (...a: unknown[]) => mockVisible(...a) }));
const mockLogError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => mockLogError(...a) }));
vi.mock("@/lib/repliques/playbackActivity", () => ({ noteMediaRead: () => {} }));
const FILES: Record<string, string> = {};
/** Les sous-titres que Jellyfin décrit pour un titre (§191) ; `"panne"` : Jellyfin injoignable. */
let subtitleStreams: Record<string, unknown>[] | "panne" = [];
/** Le WebVTT que Jellyfin rend pour un index, ou un statut. */
const vttByIndex: Record<number, string | number> = {};
const mediaSourceCalls: string[] = [];
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getItemForAnalysis: async (id: string) => (FILES[id] ? { Id: id, Type: "Movie", MediaSources: [{ Path: `/media/${FILES[id]}` }] } : null),
    getItemMediaSources: async (userId: string, id: string) => {
      mediaSourceCalls.push(userId);
      if (subtitleStreams === "panne") throw new Error("Jellyfin muet");
      return { MediaSources: [{ Id: id, ETag: "etag-1", MediaStreams: subtitleStreams }] };
    },
  },
}));
vi.mock("@/lib/jellyfinBreaker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jellyfinBreaker")>()),
  passJellyfinFetch: async (url: string) => {
    const m = /\/Subtitles\/(\d+)\/Stream\.vtt$/.exec(url);
    const found = m ? vttByIndex[Number(m[1])] : undefined;
    if (found === undefined) return new Response("", { status: 404 });
    return typeof found === "number" ? new Response("", { status: found }) : new Response(found, { status: 200 });
  },
}));

const DATA = process.env.DATA_DIR!;
const MEDIA = join(DATA, "media");
const H264 = "1".repeat(32);
const CRA = "2".repeat(32);
const NOCUES = "3".repeat(32);
const COPY = "4".repeat(32);
const MISSING = "5".repeat(32);
const ADMIN = { u: "admin", role: "admin", jti: "j-admin", jfId: "f".repeat(32) };

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
    expect(verdict.version).toMatch(/^6-[0-9a-f]{12}$/);
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
    const plain = verdict.master.replace(/\/tv\.[^/]+\//, "/");
    const res = await get(`${baseOf(plain)}v/0.m4s?castToken=quelconque`, { cookie: false });
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
    const stale = await get(`/api/lumen/${H264}/6-000000000000/lect/v/0.m4s`);
    expect(stale.status).toBe(410);
    expect(await stale.json()).toMatchObject({ code: "lumen-perime", version: verdict.version });
    // Une adresse du format 5 (d'avant les sous-titres dans la liste, §191) : le même fichier, plus rien.
    const format = await get(`/api/lumen/${H264}/${verdict.version.replace(/^6-/, "5-")}/lect/v/0.m4s`);
    expect(format.status).toBe(410);
    expect(await format.json()).toMatchObject({ code: "lumen-perime", format: 6 });
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
    await get(`/api/lumen/${H264}/6-000000000000/lecture-r/v/1.m4s`);
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
    expect(idr.version).toMatch(/^6i1-[0-9a-f]{12}$/);
    expect(cra.version).toMatch(/^6-[0-9a-f]{12}$/);
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
    expect(again.version).toMatch(/^6l1-/);
    expect((await eligibility(CRA, "?cut=tout")).status).toBe(410);
    expect((await prepare(CRA, { cut: "tout" })).status).toBe(410);
    expect((await prepare(CRA, { cut: 3 })).status).toBe(410);
  });

  it("`target` : une cible d'essai dans la version (`5t2-`), une autre répond 410, jamais 400", async () => {
    const two = await okVerdict(H264, "?s=lecture-t2&target=2");
    const four = await okVerdict(H264, "?s=lecture-t4");
    expect(two.version).toMatch(/^6t2-[0-9a-f]{12}$/);
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

describe("le laissez-passer d'une Apple TV (§186)", () => {
  /** L'adresse munie du jeton et sa version sans, pour la même lecture. */
  async function tvVerdict(query = "?s=lecture-tv&tv=1") {
    const verdict = await okVerdict(H264, query);
    const token = /\/tv\.([^/]+)\/master\.m3u8/.exec(verdict.master)?.[1];
    expect(token).toBeTruthy();
    return { verdict, token: token!, plain: verdict.master.replace(`/tv.${token}`, "") };
  }

  it("sans `tv=1`, l'adresse d'avant ; avec, l'adresse munie du jeton", async () => {
    expect((await okVerdict(H264, "?s=lecture-tv")).master).not.toContain("/tv.");
    expect((await okVerdict(H264, "?s=lecture-tv&tv=1")).master).toContain("/lecture-tv/tv.");
  });

  it("l'éligibilité rend l'adresse munie du jeton ; sans cookie, le téléviseur lit tout, et sa position est rapportée", async () => {
    castPositions.length = 0;
    const { verdict } = await tvVerdict();
    const master = await get(verdict.master, { cookie: false });
    expect(master.status).toBe(200);
    const base = baseOf(verdict.master);
    // Les URI relatives de la liste héritent du jeton : la liste vidéo, l'init, un segment, une piste son.
    for (const name of ["v.m3u8", "init-v.mp4", "v/1.m4s", `a${verdict.audioTrack}.m3u8`, `a${verdict.audioTrack}/1.m4s`]) {
      expect((await get(`${base}${name}`, { cookie: false })).status, name).toBe(200);
    }
    // Un segment vidéo demandé sans cookie : sa position part au relais (`castProgress`) ; un segment son, non.
    expect(castPositions).toHaveLength(1);
    expect(castPositions[0].pass).toMatchObject({ user: "admin", jfId: ADMIN.jfId, itemId: H264, player: "lumen-serveur" });
    expect(castPositions[0].start).toBeGreaterThan(0);
    // La page lit la même adresse avec son cookie : rien n'est rapporté pour elle.
    await get(`${base}v/2.m4s`);
    expect(castPositions).toHaveLength(1);
  });

  it("refusé (401, jamais 403/404/400) : un autre titre, une autre lecture, un jeton échu, une session close, un `castToken`, une signature altérée", async () => {
    const { verdict, token, plain } = await tvVerdict();
    const segment = (t: string, item = H264, s = "lecture-tv") => `/api/lumen/${item}/${verdict.version}/${s}/tv.${t}/v/0.m4s`;
    const { signLumenTvPass } = await import("@/lib/lumenServer/tvPass");
    const { signCastToken } = await import("@/lib/castToken");
    FILES[COPY] = "copie.mkv";
    const cases: [string, string][] = [
      ["un autre titre", segment(token, COPY)],
      ["une autre lecture", segment(token, H264, "autre-lecture")],
      ["échu", segment((await signLumenTvPass(H264, "lecture-tv", ADMIN, Date.now() - 7 * 3600_000))!)],
      ["un castToken du même titre", segment(await signCastToken(H264, "admin", Date.now(), "j-admin", ADMIN.jfId))],
      ["signature altérée", segment(`${token.split(".")[0]}.${"A".repeat(43)}`)],
    ];
    for (const [why, path] of cases) {
      const res = await get(path, { cookie: false });
      expect(res.status, why).toBe(401);
    }
    liveSessions.delete("j-admin");
    try {
      expect((await get(segment(token), { cookie: false })).status, "session close").toBe(401);
    } finally {
      liveSessions.add("j-admin");
    }
    // Sans jeton ni cookie : rien.
    mockVerify.mockImplementation(async (cookie: unknown) => (cookie ? ADMIN : null));
    expect((await get(`${baseOf(plain)}v/0.m4s`, { cookie: false })).status).toBe(401);
  });

  it("le jeton n'ouvre que les adresses de lecture : ni l'éligibilité, ni la préparation", async () => {
    const { token } = await tvVerdict();
    mockVerify.mockResolvedValue(null);
    expect((await eligibility(H264, `?s=lecture-tv&tv=${token}`, { cookie: false })).status).toBe(401);
    expect((await prepare(H264, { s: "lecture-tv" }, { cookie: false })).status).toBe(401);
  });

  it("un lien de partage ou un compte ordinaire ne reçoit pas de jeton (l'éligibilité leur est fermée), et un jeton qui en porterait le rôle est refusé", async () => {
    mockVerify.mockResolvedValue({ u: "partage", role: "share", sh: "x", jti: "j-admin" });
    expect((await eligibility(H264)).status).toBe(403);
    mockVerify.mockResolvedValue({ u: "compte", role: "user", jti: "j-admin" });
    expect((await eligibility(H264)).status).toBe(403);
    const { __testing } = await import("@/lib/lumenServer/tvPass");
    mockVerify.mockResolvedValue(ADMIN);
    const { verdict } = await tvVerdict();
    // L'adresse de l'administrateur, recopiée par un lien de partage ou un compte ordinaire avec leur cookie : refusée.
    for (const other of [{ u: "partage", role: "share", sh: "x", jti: "j" }, { u: "compte", role: "user", jti: "j" }]) {
      mockVerify.mockResolvedValue(other);
      expect((await get(verdict.master)).status, other.role).toBe(403);
    }
    mockVerify.mockResolvedValue(ADMIN);
    const forged = await __testing.signClaims({ k: "lumen", i: H264, s: "lecture-tv", u: "partage", r: "share", t: "j-admin", e: Date.now() + 60_000 });
    expect((await get(`/api/lumen/${H264}/${verdict.version}/lecture-tv/tv.${forged}/v/0.m4s`, { cookie: false })).status).toBe(401);
  });
});

describe("les sous-titres dans la liste maître, pour AirPlay (§191)", () => {
  const FR_VTT = ["WEBVTT", "", "1", "00:00:00.500 --> 00:00:01.500", "Bonjour.", "", "2", "00:00:03.000 --> 00:00:05.000", "Au revoir."].join("\n");
  beforeEach(async () => {
    (await import("@/lib/lumenServer/subtitleServe")).__testing.reset();
    mediaSourceCalls.length = 0;
    subtitleStreams = [
      { Type: "Subtitle", Index: 3, Language: "fre", Codec: "subrip", IsTextSubtitleStream: true, IsForced: false },
      { Type: "Subtitle", Index: 4, Language: "eng", Codec: "PGSSUB", IsTextSubtitleStream: false },
      { Type: "Subtitle", Index: 5, Language: "fre", Title: "Forcés", Codec: "ass", IsTextSubtitleStream: true, IsForced: true },
    ];
    for (const k of Object.keys(vttByIndex)) delete vttByIndex[Number(k)];
    vttByIndex[3] = FR_VTT;
    vttByIndex[5] = ["WEBVTT", "", "00:00:02.000 --> 00:00:02.500", "[forcé]"].join("\n");
  });

  /** Le rendu de sous-titres que la liste maître annonce : sa ligne et son URI. */
  function subtitleLine(master: string) {
    const line = master.split("\n").find((l) => l.startsWith("#EXT-X-MEDIA:TYPE=SUBTITLES"));
    return { line, uri: line ? /URI="([^"]+)"/.exec(line)?.[1] : undefined };
  }

  it("sans `st`, la liste maître d'avant à l'octet près, sans un appel à Jellyfin", async () => {
    const verdict = await okVerdict(H264, "?s=lecture-st");
    const plain = await (await get(verdict.master)).text();
    expect(plain).not.toContain("SUBTITLES");
    expect(mediaSourceCalls).toEqual([]);
  });

  it("`st=3` : un seul rendu, DEFAULT, son URI relative ; la variante le nomme ; le reste de la liste inchangé", async () => {
    const verdict = await okVerdict(H264, "?s=lecture-st");
    const plain = await (await get(verdict.master)).text();
    const res = await get(`${verdict.master}&st=3`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-lumen-sous-titres")).toBe("rendu");
    const text = await res.text();
    const { line, uri } = subtitleLine(text);
    expect(line).toContain('GROUP-ID="subs"');
    expect(line).toContain('LANGUAGE="fr"');
    expect(line).toContain("DEFAULT=YES,AUTOSELECT=YES");
    expect(line).not.toContain("FORCED");
    expect(uri).toMatch(/^s3h[0-9a-f]{8}\.m3u8$/);
    expect(text.match(/#EXT-X-STREAM-INF:[^\n]*/g)!.every((l) => l.endsWith(',SUBTITLES="subs"'))).toBe(true);
    // Retirés la ligne du rendu et l'attribut de la variante : la liste de la règle, octet pour octet.
    expect(text.replace(`${line}\n`, "").replaceAll(',SUBTITLES="subs"', "")).toBe(plain);
    // Le compte de la session lit Jellyfin : un titre caché le reste.
    expect(mediaSourceCalls).toEqual([ADMIN.jfId]);
  });

  it("un forcé : FORCED=YES ; une piste en images ou un index inconnu : la liste sans rendu, et l'en-tête le dit", async () => {
    const verdict = await okVerdict(H264, "?s=lecture-st");
    expect(subtitleLine(await (await get(`${verdict.master}&st=5`)).text()).line).toContain("FORCED=YES");
    for (const st of ["4", "9"]) {
      const res = await get(`${verdict.master}&st=${st}`);
      expect(res.status, st).toBe(200);
      expect(res.headers.get("x-lumen-sous-titres"), st).toBe("absent");
      expect(await res.text()).not.toContain("SUBTITLES");
    }
    // `premier` (le banc) : la première piste de texte.
    expect(subtitleLine(await (await get(`${verdict.master}&st=premier`)).text()).uri).toMatch(/^s3h/);
  });

  it("Jellyfin injoignable : la liste part sans rendu (un film sans sous-titres plutôt qu'un film qui ne démarre pas)", async () => {
    const verdict = await okVerdict(H264, "?s=lecture-st");
    subtitleStreams = "panne";
    const res = await get(`${verdict.master}&st=3`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-lumen-sous-titres")).toBe("indisponible");
    expect(await res.text()).not.toContain("SUBTITLES");
  });

  it("la liste du rendu : les EXTINF de la vidéo ; ses segments WebVTT, `X-TIMESTAMP-MAP` au délai D de l'index", async () => {
    const verdict = await okVerdict(H264, "?s=lecture-st");
    const base = baseOf(verdict.master);
    const { uri } = subtitleLine(await (await get(`${verdict.master}&st=3`)).text());
    const list = await get(`${base}${uri}`);
    expect(list.status).toBe(200);
    expect(list.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    const text = await list.text();
    const video = await (await get(`${base}v.m3u8`)).text();
    const extinf = (t: string) => t.split("\n").filter((l) => l.startsWith("#EXTINF") || l.startsWith("#EXT-X-TARGETDURATION"));
    expect(extinf(text)).toEqual(extinf(video));
    const tag = uri!.replace(/\.m3u8$/, "");
    expect(text).toContain(`\n${tag}/0.vtt\n`);
    expect(text).not.toContain("EXT-X-MAP");

    const seg = await get(`${base}${tag}/0.vtt`);
    expect(seg.status).toBe(200);
    expect(seg.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
    const body = await seg.text();
    expect(body).toMatch(/^WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:\d+,LOCAL:00:00:00\.000\n/);
    const mpegts = Number(/MPEGTS:(\d+)/.exec(body)![1]);
    // D est de quelques images : entre 0 et une seconde, en 90 kHz.
    expect(mpegts).toBeGreaterThan(0);
    expect(mpegts).toBeLessThan(90_000);
    expect(body).toContain("00:00:00.500 --> 00:00:01.500\nBonjour.");
  });

  it("le téléviseur sans cookie : la liste munie de `st`, le rendu et ses segments héritent du laissez-passer", async () => {
    const verdict = await okVerdict(H264, "?s=lecture-st&tv=1");
    expect(verdict.master).toContain("/tv.");
    const res = await get(`${verdict.master}&st=3`, { cookie: false });
    expect(res.status).toBe(200);
    const { uri } = subtitleLine(await res.text());
    const base = baseOf(verdict.master);
    expect(base).toContain("/tv.");
    const tag = uri!.replace(/\.m3u8$/, "");
    expect((await get(`${base}${uri}`, { cookie: false })).status).toBe(200);
    expect((await get(`${base}${tag}/1.vtt`, { cookie: false })).status).toBe(200);
    // Jellyfin lu pour l'administrateur du laissez-passer.
    expect(mediaSourceCalls.every((u) => u === ADMIN.jfId)).toBe(true);
    // Un jeton altéré : 401, avant tout.
    const forged = `${base.replace(/tv\.[^/]+\//, "tv.aaa.bbb/")}${tag}/1.vtt`;
    expect((await get(forged, { cookie: false })).status).toBe(401);
  });

  it("refusés comme le reste : un compte ordinaire, un lien de partage, sans session", async () => {
    const verdict = await okVerdict(H264, "?s=lecture-st");
    const { uri } = subtitleLine(await (await get(`${verdict.master}&st=3`)).text());
    const base = baseOf(verdict.master);
    for (const [who, session, status] of [
      ["compte ordinaire", { u: "bob", role: "user", jti: "j-bob", jfId: "e".repeat(32) }, 403],
      ["lien de partage", { u: "share", role: "share", jti: "j-sh", sh: "x" }, 403],
      ["sans session", null, 401],
    ] as const) {
      mockVerify.mockResolvedValueOnce(session);
      expect((await get(`${base}${uri}`)).status, who).toBe(status);
    }
  });

  it("des noms qui ne désignent plus rien : 410 ; Jellyfin muet : 503 — jamais 404 ni 400", async () => {
    const verdict = await okVerdict(H264, "?s=lecture-st");
    const base = baseOf(verdict.master);
    const { uri } = subtitleLine(await (await get(`${verdict.master}&st=3`)).text());
    const tag = uri!.replace(/\.m3u8$/, "");
    // Une autre empreinte (la piste a changé chez Jellyfin, une synchro refaite) ; un index inconnu ; une image.
    for (const name of [`s3h00000000.m3u8`, `s9h${tag.slice(-8)}/0.vtt`, `s4h${tag.slice(-8)}.m3u8`, `${tag}/999999.vtt`]) {
      expect((await get(`${base}${name}`)).status, name).toBe(410);
    }
    // Un nom mal formé : 410 comme tout nom inconnu.
    for (const name of ["s03h12345678.m3u8", "s3h1234567.m3u8", `${tag}/01.vtt`, `${tag}/0.webvtt`]) {
      expect((await get(`${base}${name}`)).status, name).toBe(410);
    }
    expect((await get(`${verdict.master}&st=abc`)).status).toBe(410);
    // La piste disparue de chez Jellyfin (le fichier à côté supprimé) : 410.
    (await import("@/lib/lumenServer/subtitleServe")).__testing.reset();
    vttByIndex[3] = 404;
    expect((await get(`${base}${tag}/0.vtt`)).status).toBe(410);
    // Jellyfin muet pour le WebVTT, puis pour les pistes : 503.
    (await import("@/lib/lumenServer/subtitleServe")).__testing.reset();
    vttByIndex[3] = 500;
    expect((await get(`${base}${tag}/0.vtt`)).status).toBe(503);
    (await import("@/lib/lumenServer/subtitleServe")).__testing.reset();
    subtitleStreams = "panne";
    expect((await get(`${base}${uri}`)).status).toBe(503);
  });

  it("les requêtes de sous-titres ne comptent pas au relevé de la lecture (image et son seulement)", async () => {
    const verdict = await okVerdict(H264, "?s=lecture-stats");
    const base = baseOf(verdict.master);
    const { uri } = subtitleLine(await (await get(`${verdict.master}&st=3`)).text());
    await get(`${base}${uri}`);
    await get(`${base}${uri!.replace(/\.m3u8$/, "")}/0.vtt`);
    const { lumenPlaybackStats } = await import("@/lib/lumenServer/playbackStats");
    expect(lumenPlaybackStats("lecture-stats", "admin")!.requests).toEqual({ master: 1, playlist: 0, init: 0, segment: 0 });
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
      // Aucun jeton de diffusion du flux Jellyfin ; le seul jeton de ces routes est celui d'une Apple TV, lu par
      // `serve.ts` seulement (§186).
      expect(source, route).not.toMatch(/castPass|castToken|verifyCastToken|verifyLumenTvPass/);
    }
    const serve = readFileSync("src/lib/lumenServer/serve.ts", "utf8");
    // L'accès — le laissez-passer revérifié, sinon la session — est vérifié avant la moindre lecture de fichier ou d'index.
    expect(serve.indexOf("lumenAccess(req, itemId)")).toBeGreaterThan(0);
    expect(serve.indexOf("lumenAccess(req, itemId)")).toBeLessThan(serve.indexOf("lumenIndexOf(itemId"));
    expect(serve.indexOf("verifyLumenTvPass(")).toBeGreaterThan(0);
    expect(serve.indexOf("verifyLumenTvPass(")).toBeLessThan(serve.indexOf("lumenAccess(req, itemId)"));
    expect(readFileSync("src/proxy.ts", "utf8")).toContain("/^\\/api\\/lumen(\\/|$)/");
  });
});
