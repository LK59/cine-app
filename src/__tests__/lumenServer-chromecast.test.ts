import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Son propre DATA_DIR : le cache disque des index et celui du son converti s'y écrivent.
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-lumen-cast-"));
});

import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextRequest } from "next/server";
import { FIXTURES, parseFragments } from "./lumenServer-helpers";

// Lumen serveur vers un récepteur Chromecast (DECISIONS.md §192), côté serveur : le laissez-passer `cc.{jeton}` (sa
// portée, sa forme, le proxy), la vue `castView` (l'AAC copié tel quel, le reste converti en AAC stéréo sous l'option,
// refusé sans elle), la liste maître du récepteur (une piste, pas de SUPPLEMENTAL-CODECS), le CORS de chaque réponse
// et la question préalable, et la grille de l'AAC (un segment par conversion, 48 000). Sans ffmpeg : la détection et
// la conversion sont des doubles, comme dans `lumenServer-conversion-routes.test.ts` ; l'encodeur AAC lui-même a été
// mesuré avec le binaire de l'image (README de docs/remux-serveur/, « Chromecast »).

const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const liveSessions = new Set(["j-admin"]);
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return { ...real, sessionDb: { ...real.sessionDb, exists: (jti: string) => liveSessions.has(jti) } };
});
const castPositions: { pass: { player?: string }; start: number }[] = [];
vi.mock("@/lib/castProgress", () => ({ castProgressRelay: () => ({ noteCastPosition: (pass: { player?: string }, start: number) => castPositions.push({ pass, start }) }) }));
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: async () => null }));
vi.mock("@/lib/logger", () => ({ logError: () => {} }));
vi.mock("@/lib/repliques/playbackActivity", () => ({ noteMediaRead: () => {} }));
const FILES: Record<string, string> = {};
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: { getItemForAnalysis: async (id: string) => (FILES[id] ? { Id: id, Type: "Movie", MediaSources: [{ Path: `/media/${FILES[id]}` }] } : null) },
}));

const REFERENCE: Record<string, Uint8Array> = {};
const detection = vi.fn();
vi.mock("@/lib/lumenServer/audio/ffmpeg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lumenServer/audio/ffmpeg")>();
  return { ...actual, detectLumenFfmpeg: () => detection() };
});
const converted = vi.fn();
vi.mock("@/lib/lumenServer/audio/convert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lumenServer/audio/convert")>();
  return {
    ...actual,
    // Une conversion sans ffmpeg : les bonnes trames, sur la grille de la cible, muxées par le vrai code.
    convertRange: async (job: Parameters<typeof actual.convertRange>[0]) => {
      converted(job.target.id, job.n0, job.n1, job.niceness);
      const { segmentFrames, gridOf } = await import("@/lib/lumenServer/audio/convertGrid");
      const grid = gridOf(job.target);
      if (grid.frame !== 1536 && job.n1 - job.n0 !== 1) throw new Error("plusieurs segments AAC dans une conversion");
      const [a, b] = segmentFrames(job.index, job.n0, job.n1, grid);
      const frame = job.target.codec === "aac" ? new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]) : REFERENCE[job.target.id];
      const frames = Array.from({ length: b - a + grid.preroll + 4 }, () => frame);
      const segments = new Map<number, Uint8Array>();
      for (let n = job.n0; n < job.n1; n++) {
        const [x, y] = segmentFrames(job.index, n, n + 1, grid);
        segments.set(n, actual.convertedSegment(frames, a, x, y, n, job.index.delayUs, grid));
      }
      return { segments, facts: { feedMs: 1, diskMs: 0, ffmpegMs: 2, inputBytes: 0, frames: b - a, silent: false, firstByteMs: 1, pooled: false } };
    },
  };
});

const DATA = process.env.DATA_DIR!;
const MEDIA = join(DATA, "media");
const H264 = "1".repeat(32);
const CRA = "2".repeat(32);
const ADMIN = { u: "admin", role: "admin", jti: "j-admin", jfId: "f".repeat(32) };

beforeAll(async () => {
  mkdirSync(MEDIA, { recursive: true });
  copyFileSync(resolve(FIXTURES, "h264-aac.mkv"), join(MEDIA, "h264-aac.mkv"));
  copyFileSync(resolve(FIXTURES, "hevc-cra.mkv"), join(MEDIA, "hevc-cra.mkv"));
  Object.assign(FILES, { [H264]: "h264-aac.mkv", [CRA]: "hevc-cra.mkv" });
  process.env.LUMEN_PATH_MAP = `/media=${MEDIA}`;
  process.env.LUMEN_WORKER_PATH = "inline";
  const { fixtureIndex } = await import("./lumenServer-helpers");
  for (const [name, id] of [["eac3-late.mkv", "eac3-640-51"], ["eac3-short.mkv", "eac3-256-20"]] as const) {
    const { index, source } = await fixtureIndex(name);
    source.close();
    REFERENCE[id] = index.audio[0].firstFrame!;
  }
  const { AAC_LC_STEREO_48K } = await import("@/lib/lumenServer/audio/ffmpeg");
  REFERENCE["aac-192-20"] = AAC_LC_STEREO_48K;
});

beforeEach(async () => {
  vi.clearAllMocks();
  castPositions.length = 0;
  mockVerify.mockResolvedValue(ADMIN);
  detection.mockResolvedValue({ available: true, path: "/usr/local/bin/ffmpeg", version: "7.1.5", sha256: "ab".repeat(32), encoders: ["eac3", "aac"], reference: REFERENCE, detectedAt: 0, ms: 1 });
  delete process.env.LUMEN_AUDIO_CONVERT;
  await (await import("@/lib/lumenServer/engine")).resetLumenEngine();
  (await import("@/lib/lumenServer/indexCache")).clearLumenIndexCache();
  (await import("@/lib/lumenServer/service")).forgetLumenFiles();
  (await import("@/lib/lumenServer/playbackStats")).forgetLumenPlaybacks();
  (await import("@/lib/lumenServer/audio/conversion")).resetLumenAudio();
  (await import("@/lib/lumenServer/segmentCache")).forgetSharedSegments();
});

function request(path: string, init: { cookie?: boolean; method?: string } = {}): NextRequest {
  return new NextRequest(`https://cine.example${path}`, { method: init.method ?? "GET", headers: init.cookie === false ? {} : { cookie: "cine_session=t" } });
}

async function eligibility(item: string, query: string) {
  const { GET } = await import("@/app/api/lumen/[itemId]/eligibility/route");
  return GET(request(`/api/lumen/${item}/eligibility${query}`), { params: Promise.resolve({ itemId: item }) });
}

function paramsOf(path: string) {
  const m = /^\/api\/lumen\/([^/]+)\/([^/]+)\/([^/?]+)\/([^?]+)/.exec(path.replace(/^https:\/\/cine\.example/, ""))!;
  return { itemId: m[1], version: m[2], s: m[3], name: m[4].split("/") };
}

/** Une requête du récepteur : sans cookie, comme le Chromecast. */
async function receiver(path: string, method: "GET" | "OPTIONS" = "GET") {
  const route = await import("@/app/api/lumen/[itemId]/[version]/[s]/[...name]/route");
  const req = request(path.replace(/^https:\/\/cine\.example/, ""), { cookie: false, method });
  return method === "GET" ? route.GET(req, { params: Promise.resolve(paramsOf(path)) }) : route.OPTIONS(req, { params: Promise.resolve(paramsOf(path)) });
}

const baseOf = (master: string) => master.slice(0, master.lastIndexOf("/") + 1);

describe("le laissez-passer d'un récepteur (`cc.{jeton}`)", () => {
  it("sa propre portée : un jeton Chromecast n'ouvre pas l'adresse AirPlay, ni l'inverse", async () => {
    const tv = await import("@/lib/lumenServer/tvPass");
    const cc = (await tv.signLumenCastPass(H264, "lect1", ADMIN))!;
    const air = (await tv.signLumenTvPass(H264, "lect1", ADMIN))!;
    expect(await tv.verifyLumenCastPass(cc, H264, "lect1")).toMatchObject({ user: "admin", role: "admin" });
    expect(await tv.verifyLumenTvPass(cc, H264, "lect1")).toBeNull();
    expect(await tv.verifyLumenCastPass(air, H264, "lect1")).toBeNull();
    expect(await tv.verifyLumenCastPass(cc, CRA, "lect1")).toBeNull();
    expect(await tv.verifyLumenCastPass(cc, H264, "lect2")).toBeNull();
    expect(await tv.verifyLumenCastPass(cc, H264, "lect1", Date.now() + 7 * 3600_000)).toBeNull();
    expect(await tv.signLumenCastPass(H264, "lect1", { ...ADMIN, role: "user" })).toBeNull();
    expect(await tv.signLumenCastPass(H264, "lect1", { ...ADMIN, role: "share" })).toBeNull();
    liveSessions.delete("j-admin");
    expect(await tv.verifyLumenCastPass(cc, H264, "lect1")).toBeNull();
    liveSessions.add("j-admin");
  });

  it("la forme de l'adresse, GET pour le flux et OPTIONS pour la question préalable seulement", async () => {
    const tv = await import("@/lib/lumenServer/tvPass");
    const token = (await tv.signLumenCastPass(H264, "lect1", ADMIN))!;
    const master = tv.withLumenCastPass(`/api/lumen/${H264}/5-0123456789ab/lect1/master.m3u8?audio=2`, token);
    expect(master).toBe(`/api/lumen/${H264}/5-0123456789ab/lect1/cc.${token}/master.m3u8?audio=2`);
    const segment = `/api/lumen/${H264}/5-0123456789ab/lect1/cc.${token}/v/12.m4s`;
    expect(tv.lumenCastAddressOf(segment)).toEqual({ itemId: H264, version: "5-0123456789ab", s: "lect1", token, rest: ["v", "12.m4s"] });
    expect(tv.lumenCastAddressOf(segment.replace("/cc.", "/tv."))).toBeNull();
    expect(tv.lumenTvAddressOf(segment)).toBeNull();
    expect(tv.lumenCastAddressOf(`/api/lumen/${H264}/5-0123456789ab/lect1/cc.${token}/../x`)).toBeNull();
    const at = (method: string) => ({ method, nextUrl: { pathname: segment } });
    expect(await tv.lumenCastPassFor(at("GET"))).toMatchObject({ user: "admin" });
    expect(await tv.lumenCastPassFor(at("POST"))).toBeNull();
    expect(await tv.lumenCastPreflightFor(at("OPTIONS"))).toMatchObject({ user: "admin" });
    expect(await tv.lumenCastPreflightFor(at("GET"))).toBeNull();
    // Le jeton AirPlay sous `cc.` : refusé par les deux portes.
    const air = (await tv.signLumenTvPass(H264, "lect1", ADMIN))!;
    expect(await tv.lumenCastPassFor({ method: "GET", nextUrl: { pathname: segment.replace(token, air) } })).toBeNull();
  });
});

describe("le verdict d'un récepteur (`?cast=1`)", () => {
  it("un AAC copiable : servi tel quel sans l'option, l'adresse `cc.` absolue et la vidéo nommée", async () => {
    const verdict = await (await eligibility(H264, "?cast=1&s=lecture-cc")).json();
    expect(verdict).toMatchObject({ ok: true, castVideo: "h264" });
    expect(verdict.master).toMatch(new RegExp(`^/api/lumen/${H264}/[^/]+/lecture-cc/cc\\.[^/]+/master\\.m3u8`));
    expect(converted).not.toHaveBeenCalled();
  });

  it("sans l'option : une piste E-AC-3, AC-3 ou Opus est refusée (le récepteur garde le flux de Jellyfin)", async () => {
    for (const audio of [2, 3, 4]) {
      const verdict = await (await eligibility(CRA, `?cast=1&audio=${audio}&s=lecture-cc`)).json();
      expect(verdict).toMatchObject({ ok: false, reason: "son-codec" });
      expect(verdict.detail).toMatch(/chromecast/);
    }
  });

  it("avec l'option : l'E-AC-3 copiable de la page devient de l'AAC pour le récepteur, et le HEVC se refuse sur demande", async () => {
    process.env.LUMEN_AUDIO_CONVERT = "admins";
    const verdict = await (await eligibility(CRA, "?cast=1&audio=2&s=lecture-cc")).json();
    expect(verdict).toMatchObject({ ok: true, castVideo: "hevc", audioTrack: 2 });
    expect(verdict.audio.find((a: { number: number }) => a.number === 2)).toMatchObject({ servable: true, converted: "aac-192-20" });
    expect(await (await eligibility(CRA, "?cast=1&audio=2&s=lecture-cc&hevc=0")).json()).toMatchObject({ ok: false, reason: "video-codec" });
    // La page, elle, garde sa copie E-AC-3 et son adresse sans jeton.
    const page = await (await eligibility(CRA, "?audio=2&s=lecture-page")).json();
    expect(page.audio.find((a: { number: number }) => a.number === 2)).toMatchObject({ servable: true, converted: null });
    expect(page.master).not.toContain("/cc.");
  });

  it("un lien de partage ou un compte ordinaire n'obtient pas d'adresse de récepteur", async () => {
    mockVerify.mockResolvedValue({ u: "bob", role: "user", jti: "j-bob" });
    expect((await eligibility(H264, "?cast=1&s=lecture-cc")).status).toBe(403);
  });
});

describe("ce que le récepteur lit, sans cookie", () => {
  it("la liste maître du récepteur : une piste, AAC, pas de SUPPLEMENTAL-CODECS ; CORS sur chaque réponse ; la position au relais", async () => {
    const verdict = await (await eligibility(H264, "?cast=1&s=lecture-cc")).json();
    const res = await receiver(verdict.master);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const master = await res.text();
    expect(master.split("\n").filter((l) => l.startsWith("#EXT-X-MEDIA:TYPE=AUDIO"))).toHaveLength(1);
    expect(master).toContain("mp4a.40.2");
    expect(master).not.toContain("SUPPLEMENTAL-CODECS");
    const base = baseOf(verdict.master);
    for (const name of ["v.m3u8", "init-v.mp4", "a2.m3u8", "init-a2.mp4", "a2/0.m4s", "v/0.m4s"]) {
      const r = await receiver(`${base}${name}`);
      expect(r.status, name).toBe(200);
      expect(r.headers.get("access-control-allow-origin"), name).toBe("*");
      await r.arrayBuffer();
    }
    expect(castPositions).toHaveLength(1);
    expect(castPositions[0].pass.player).toBe("lumen-serveur");
    // Une erreur aussi porte le CORS : le lecteur du récepteur en lit le statut.
    const gone = await receiver(`${base}v/99999.m4s`);
    expect(gone.status).toBe(410);
    expect(gone.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("la question préalable : 204 et CORS avec un jeton valable, 401 sans CORS autrement", async () => {
    const verdict = await (await eligibility(H264, "?cast=1&s=lecture-cc")).json();
    const ok = await receiver(`${baseOf(verdict.master)}v/0.m4s`, "OPTIONS");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(ok.headers.get("access-control-allow-methods")).toContain("GET");
    const bad = await receiver(`/api/lumen/${H264}/${verdict.version}/lecture-cc/cc.faux.jeton/v/0.m4s`, "OPTIONS");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    // Un jeton AirPlay n'a pas de question préalable.
    const tv = await import("@/lib/lumenServer/tvPass");
    const air = (await tv.signLumenTvPass(H264, "lecture-cc", ADMIN))!;
    expect((await receiver(`/api/lumen/${H264}/${verdict.version}/lecture-cc/tv.${air}/v/0.m4s`, "OPTIONS")).status).toBe(401);
  });

  it("l'adresse AirPlay reste sans CORS ; la page avec son cookie aussi", async () => {
    const verdict = await (await eligibility(H264, "?tv=1&s=lecture-tv")).json();
    const tvRes = await receiver(verdict.master);
    expect(tvRes.status).toBe(200);
    expect(tvRes.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("une piste convertie en AAC : son init (mp4a, 48 000) et ses segments sur la grille de 1 024, un segment par conversion", async () => {
    process.env.LUMEN_AUDIO_CONVERT = "admins";
    const verdict = await (await eligibility(CRA, "?cast=1&audio=3&s=lecture-aac")).json();
    expect(verdict.ok).toBe(true);
    const master = await (await receiver(verdict.master)).text();
    const uri = /URI="(a3x[0-9a-f]{8})\.m3u8"/.exec(master)?.[1];
    expect(uri).toBeTruthy();
    expect(master).toContain('CHANNELS="2"');
    // L'identité de la conversion n'est pas celle de l'E-AC-3 de la page : d'autres adresses, d'autres clés de cache.
    const { conversionId } = await import("@/lib/lumenServer/audio/view");
    const { TARGET_51, TARGET_CAST_AAC } = await import("@/lib/lumenServer/audio/convertGrid");
    const ctx = { ffmpegVersion: "7.1.5", ffmpegSha256: "ab".repeat(32) };
    expect(uri).toBe(`a3x${conversionId(ctx, TARGET_CAST_AAC)}`);
    expect(conversionId(ctx, TARGET_CAST_AAC)).not.toBe(conversionId(ctx, TARGET_51));
    const base = baseOf(verdict.master);
    const init = Buffer.from(await (await receiver(`${base}init-${uri}.mp4`)).arrayBuffer());
    expect(init.includes(Buffer.from("mp4a"))).toBe(true);
    expect(init.includes(Buffer.from("esds"))).toBe(true);
    expect(init.includes(Buffer.from("ec-3"))).toBe(false);
    const mdhd = init.indexOf(Buffer.from("mdhd"));
    const version = init[mdhd + 4];
    expect(init.readUInt32BE(mdhd + (version === 1 ? 24 : 16))).toBe(48_000);
    const seg = await receiver(`${base}${uri}/0.m4s`);
    expect(seg.status).toBe(200);
    const [fragment] = parseFragments(new Uint8Array(await seg.arrayBuffer()));
    expect(fragment.samples.every((s) => s.duration === 1024)).toBe(true);
    // tfdt = k × 1 024 + D (à 48 000) : la trame 0 au délai de présentation du fichier.
    expect(fragment.baseDecode).toBe(Math.round(((await indexDelay(CRA)) * 48_000) / 1e6));
    expect(converted).toHaveBeenCalledWith("aac-192-20", 0, 1, 10);
    // L'avance : le segment suivant, seul, en priorité basse — un segment par tâche, jamais plus.
    await vi.waitFor(() => expect(converted).toHaveBeenCalledWith("aac-192-20", 1, 2, 15));
    for (const call of converted.mock.calls.filter((c) => c[0] === "aac-192-20")) expect(call[2] - call[1]).toBe(1);
    const next = await receiver(`${base}${uri}/1.m4s`);
    expect(next.status).toBe(200);
    expect(next.headers.get("access-control-allow-origin")).toBe("*");
  });
});

async function indexDelay(item: string): Promise<number> {
  const { lumenIndexOf } = await import("@/lib/lumenServer/service");
  const found = await lumenIndexOf(item);
  if ("refusal" in found) throw new Error("refus");
  return found.index.delayUs;
}

describe("la cible AAC", () => {
  it("ses arguments (ADTS, aac, sans chemin), son repli stéréo par la règle de `fold`, son étiquette", async () => {
    const { encoderArgs } = await import("@/lib/lumenServer/audio/ffmpeg");
    const { conversionArgs } = await import("@/lib/lumenServer/audio/convert");
    const { TARGET_CAST_AAC, TARGET_20, panFor, targetTag } = await import("@/lib/lumenServer/audio/convertGrid");
    expect(encoderArgs(TARGET_CAST_AAC)).toEqual(["-threads", "1", "-c:a", "aac", "-b:a", "192000", "-f", "adts", "pipe:1"]);
    expect(targetTag(TARGET_CAST_AAC)).toBe("aac-192-20-p3");
    expect(targetTag(TARGET_20)).toBe("eac3-256-20-p2");
    const h = "0.7071067811865476";
    expect(panFor(6, TARGET_CAST_AAC)).toBe(`pan=stereo|c0=c0+${h}*c2+${h}*c4|c1=c1+${h}*c2+${h}*c5`);
    expect(panFor(8, TARGET_CAST_AAC)).toBe(`pan=stereo|c0=c0+${h}*c2+${h}*c4+0.5*c6|c1=c1+${h}*c2+${h}*c5+0.5*c7`);
    expect(panFor(5, TARGET_CAST_AAC)).toBe(`pan=stereo|c0=c0+${h}*c2|c1=c1+${h}*c2`);
    expect(panFor(1, TARGET_CAST_AAC)).toBe("pan=stereo|c0=c0|c1=c0");
    // L'E-AC-3 2.0 de la page : inchangé.
    expect(panFor(2, TARGET_20)).toBe("pan=stereo|c0=c0|c1=c1");
    const args = conversionArgs({ format: "eac3", startSample: 0, decoder: undefined } as never, { a: 10, b: 20, start: 7 * 1024, end: 24 * 1024 }, 6, TARGET_CAST_AAC);
    expect(args.join(" ")).not.toMatch(/\//);
    expect(args.slice(-9)).toEqual(["-threads", "1", "-c:a", "aac", "-b:a", "192000", "-f", "adts", "pipe:1"]);
    expect(args[args.indexOf("-af") + 1]).toContain(panFor(6, TARGET_CAST_AAC));
  });

  it("la grille : trames de 1 024, délai 1 024, trois de pré-roulement, l'échelle 48 000 ; l'E-AC-3 inchangé", async () => {
    const g = await import("@/lib/lumenServer/audio/convertGrid");
    const index = { segments: [{ startUs: 0 }, { startUs: 4_004_000 }, { startUs: 8_008_000 }], durationUs: 10_000_000 } as never;
    expect(g.segmentFrames(index, 1, 2, g.AAC_GRID)).toEqual([Math.ceil((4_004_000 * 48_000) / 1_024_000_000), Math.ceil((8_008_000 * 48_000) / 1_024_000_000)]);
    expect(g.segmentFrames(index, 1, 2)).toEqual([Math.ceil(4_004_000 / 32_000), Math.ceil(8_008_000 / 32_000)]);
    expect(g.inputWindow(10, 20, g.AAC_GRID)).toEqual({ start: (10 - 3) * 1024 + 1024, end: (20 + 3) * 1024 + 1024 });
    expect(g.inputWindow(10, 20)).toEqual({ start: (10 - 2) * 1536 + 256, end: (20 + 3) * 1536 + 256 });
    expect(g.outputRank(12, 10, g.AAC_GRID)).toBe(5);
    expect(g.frameTiming(7, 125_000, g.AAC_GRID)).toEqual({ decodeTime: 7 * 1024 + 6000, duration: 1024 });
    expect(g.frameTiming(7, 125_000)).toEqual({ decodeTime: 7 * 32_000 + 125_000, duration: 32_000 });
    // Un instant multiple exact d'une trame tombe sur elle, sans arrondi vers la suivante.
    expect(g.frameAtOrAfter(64_000, g.AAC_GRID)).toBe(3);
  });

  it("le découpage ADTS : en-têtes retirés, chaque trame vérifiée (AAC-LC, 48 kHz, stéréo, un bloc)", async () => {
    const { splitAdtsFrames } = await import("@/lib/lumenServer/audio/ffmpeg");
    const frame = (payload: number[], config = 2) => {
      const size = 7 + payload.length;
      return [0xff, 0xf1, (1 << 6) | (3 << 2) | (config >> 2), ((config & 3) << 6) | (size >> 11), (size >> 3) & 0xff, ((size & 7) << 5) | 0x1f, 0xfc, ...payload];
    };
    const stream = new Uint8Array([...frame([1, 2, 3]), ...frame([4, 5])]);
    expect(splitAdtsFrames(stream).map((f) => [...f])).toEqual([[1, 2, 3], [4, 5]]);
    expect(() => splitAdtsFrames(new Uint8Array(frame([1], 6)))).toThrow(/hors cible/);
    expect(() => splitAdtsFrames(new Uint8Array([...frame([1, 2, 3]).slice(0, 8)]))).toThrow(/tronquée/);
  });

  it("une conversion AAC de plusieurs segments est refusée (ses octets dépendraient de la fenêtre)", async () => {
    const actual = await vi.importActual<typeof import("@/lib/lumenServer/audio/convert")>("@/lib/lumenServer/audio/convert");
    const { TARGET_CAST_AAC } = await import("@/lib/lumenServer/audio/convertGrid");
    await expect(actual.convertRange({ index: {}, track: 2, source: {}, target: TARGET_CAST_AAC, n0: 0, n1: 3 } as never)).rejects.toThrow(/un segment à la fois/);
  });
});
