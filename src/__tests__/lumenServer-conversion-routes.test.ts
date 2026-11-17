import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Son propre DATA_DIR : le cache disque des index et celui du son converti s'y écrivent.
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-lumen-conv-"));
});

import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextRequest } from "next/server";
import { FIXTURES, fixtureIndex, parseFragments } from "./lumenServer-helpers";

async function indexOf(name: string) {
  const { index, source } = await fixtureIndex(name);
  source.close();
  return index;
}

// La conversion du son derrière les routes de Lumen serveur (DECISIONS.md §161 à §163), sans ffmpeg : la détection
// et la conversion sont remplacées par des doubles (la vraie est éprouvée par `lumen-audio-bench.spec.ts`). Ce qui
// est vérifié ici est tout le reste : option coupée = rien ne change ; option ouverte = la piste Opus des fixtures
// devient un rendu `ec-3` nommé avec l'identité de la conversion, son init, ses segments servis par la conversion
// puis par le cache, le relevé de la lecture ; une autre identité de conversion = 410 ; l'admission.

const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: async () => null }));
vi.mock("@/lib/logger", () => ({ logError: () => {} }));
vi.mock("@/lib/repliques/playbackActivity", () => ({ noteMediaRead: () => {} }));
const FILES: Record<string, string> = {};
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: { getItemForAnalysis: async (id: string) => (FILES[id] ? { Id: id, Type: "Movie", MediaSources: [{ Path: `/media/${FILES[id]}` }] } : null) },
}));

// La trame de référence de chaque cible : une vraie trame E-AC-3 de l'encodeur de FFmpeg, prise dans les fixtures.
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
    // Une conversion sans ffmpeg : les bonnes trames cibles, chacune la trame de référence, muxées par le vrai code.
    convertRange: async (job: Parameters<typeof actual.convertRange>[0]) => {
      converted(job.n0, job.n1, job.niceness);
      const { segmentFrames, ENCODER_PREROLL } = await import("@/lib/lumenServer/audio/convertGrid");
      const [a, b] = segmentFrames(job.index, job.n0, job.n1);
      const frames = Array.from({ length: b - a + ENCODER_PREROLL + 4 }, () => REFERENCE[job.target.id]);
      const segments = new Map<number, Uint8Array>();
      for (let n = job.n0; n < job.n1; n++) {
        const [x, y] = segmentFrames(job.index, n, n + 1);
        segments.set(n, actual.convertedSegment(frames, a, x, y, n, job.index.delayUs));
      }
      return { segments, facts: { feedMs: 1, diskMs: 0, ffmpegMs: 2, inputBytes: 0, frames: b - a, silent: false } };
    },
  };
});

const DATA = process.env.DATA_DIR!;
const MEDIA = join(DATA, "media");
const CRA = "2".repeat(32);
const ADMIN = { u: "admin", role: "admin", jti: "j-admin" };

beforeAll(async () => {
  mkdirSync(MEDIA, { recursive: true });
  copyFileSync(resolve(FIXTURES, "hevc-cra.mkv"), join(MEDIA, "hevc-cra.mkv"));
  FILES[CRA] = "hevc-cra.mkv";
  process.env.LUMEN_PATH_MAP = `/media=${MEDIA}`;
  process.env.LUMEN_WORKER_PATH = "inline";
  const late = await indexOf("eac3-late.mkv");
  const short = await indexOf("eac3-short.mkv");
  REFERENCE["eac3-640-51"] = late.audio[0].firstFrame!;
  REFERENCE["eac3-256-20"] = short.audio[0].firstFrame!;
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue(ADMIN);
  detection.mockResolvedValue({ available: true, path: "/usr/local/bin/ffmpeg", version: "7.1.5", sha256: "ab".repeat(32), encoders: ["eac3"], reference: REFERENCE, detectedAt: 0, ms: 1 });
  delete process.env.LUMEN_AUDIO_CONVERT;
  delete process.env.LUMEN_AUDIO_MAX_SESSIONS;
  await (await import("@/lib/lumenServer/engine")).resetLumenEngine();
  (await import("@/lib/lumenServer/indexCache")).clearLumenIndexCache();
  (await import("@/lib/lumenServer/service")).forgetLumenFiles();
  (await import("@/lib/lumenServer/playbackStats")).forgetLumenPlaybacks();
  (await import("@/lib/lumenServer/audio/conversion")).resetLumenAudio();
});

function request(path: string): NextRequest {
  return new NextRequest(`https://cine.example${path}`, { headers: { cookie: "cine_session=t" } });
}

async function eligibility(query: string) {
  const { GET } = await import("@/app/api/lumen/[itemId]/eligibility/route");
  return GET(request(`/api/lumen/${CRA}/eligibility${query}`), { params: Promise.resolve({ itemId: CRA }) });
}

async function get(path: string) {
  const m = /^\/api\/lumen\/([^/]+)\/([^/]+)\/([^/?]+)\/([^?]+)/.exec(path)!;
  const { GET } = await import("@/app/api/lumen/[itemId]/[version]/[s]/[...name]/route");
  return GET(request(path), { params: Promise.resolve({ itemId: m[1], version: m[2], s: m[3], name: m[4].split("/") }) });
}

const baseOf = (master: string) => master.slice(0, master.lastIndexOf("/") + 1);

describe("option coupée : Lumen serveur se comporte comme avant la phase 2", () => {
  it("la piste Opus reste refusée `son-codec`, la liste maître ne la nomme pas, ffmpeg n'est pas même cherché", async () => {
    const verdict = await (await eligibility("?audio=4&s=lecture-1")).json();
    expect(verdict).toMatchObject({ ok: false, reason: "son-codec", audioTrack: 4 });
    expect(verdict.audio.find((a: { number: number }) => a.number === 4)).toMatchObject({ servable: false, converted: null, convertible: true });
    const ok = await (await eligibility("?audio=3&s=lecture-1")).json();
    const master = await (await get(ok.master)).text();
    expect(master).not.toMatch(/a4/);
    expect(detection).not.toHaveBeenCalled();
    expect(converted).not.toHaveBeenCalled();
  });

  it("ouverte mais sans ffmpeg conforme : comme coupée", async () => {
    process.env.LUMEN_AUDIO_CONVERT = "tous";
    detection.mockResolvedValue({ available: false, path: "/usr/local/bin/ffmpeg", reason: "ffmpeg absent", detectedAt: 0 });
    expect(await (await eligibility("?audio=4&s=lecture-1")).json()).toMatchObject({ ok: false, reason: "son-codec" });
  });

  it("ouverte aux administrateurs : un compte ordinaire n'en profite pas (et n'atteint de toute façon pas ces routes)", async () => {
    process.env.LUMEN_AUDIO_CONVERT = "admins";
    const { lumenConversionContext } = await import("@/lib/lumenServer/service");
    expect(await lumenConversionContext({ role: "user" })).toBeNull();
    expect(await lumenConversionContext({ role: "share" })).toBeNull();
    expect(await lumenConversionContext({ role: "admin" })).not.toBeNull();
  });
});

describe("option en service", () => {
  beforeEach(() => {
    process.env.LUMEN_AUDIO_CONVERT = "admins";
  });

  it("la piste Opus devient un rendu E-AC-3 converti : verdict, liste maître, init, segments, cache, relevé", async () => {
    const res = await eligibility("?audio=4&s=lecture-1");
    const verdict = await res.json();
    expect(verdict).toMatchObject({ ok: true, audioTrack: 4, conversion: { state: "ok" } });
    expect(verdict.audio.find((a: { number: number }) => a.number === 4)).toMatchObject({ servable: true, converted: "eac3-256-20" });
    const master = await (await get(verdict.master)).text();
    const uri = /URI="(a4x[0-9a-f]{8})\.m3u8"/.exec(master)?.[1];
    expect(uri).toBeTruthy();
    // Le groupe de toutes les pistes (format 5, §185), avec la E-AC-3 copiée ; deux canaux ; la langue du fichier ; le
    // défaut sur elle.
    const line = master.split("\n").find((l) => l.includes(`${uri}.m3u8`))!;
    const group = /GROUP-ID="([^"]+)"/.exec(line)?.[1];
    expect(group).toMatch(/^aud-.*ec-3/);
    expect(line).toContain('CHANNELS="2"');
    expect(line).toContain('LANGUAGE="es"');
    expect(line).toContain("DEFAULT=YES");
    expect(master.split("\n").find((l) => l.includes('URI="a2.m3u8"'))).toContain(`GROUP-ID="${group}"`);
    expect(master.split("\n").filter((l) => l.startsWith("#EXT-X-STREAM-INF:"))).toHaveLength(1);
    const base = baseOf(verdict.master);
    const playlist = await (await get(`${base}${uri}.m3u8`)).text();
    expect(playlist).toContain(`#EXT-X-MAP:URI="init-${uri}.mp4"`);
    expect(playlist).toContain(`${uri}/0.m4s`);
    const init = new Uint8Array(await (await get(`${base}init-${uri}.mp4`)).arrayBuffer());
    expect(Buffer.from(init).includes(Buffer.from("ec-3"))).toBe(true);
    expect(Buffer.from(init).includes(Buffer.from("dec3"))).toBe(true);

    const seg = await get(`${base}${uri}/1.m4s`);
    expect(seg.status).toBe(200);
    const bytes = new Uint8Array(await seg.arrayBuffer());
    const [fragment] = parseFragments(bytes);
    expect(fragment.trackId).toBe(2);
    expect(fragment.samples.every((s) => s.duration === 32_000)).toBe(true);
    // tfdt = k × 32 000 µs + D : sur la grille des trames cibles, au délai de présentation du fichier.
    const { delayUs } = await indexOf("hevc-cra.mkv");
    expect((fragment.baseDecode - delayUs) % 32_000).toBe(0);
    expect(converted).toHaveBeenCalledWith(1, 2, 10); // une demande, `nice` 10
    // Relu : le cache en mémoire, sans nouvelle conversion du segment 1.
    const callsBefore = converted.mock.calls.filter((c) => c[0] <= 1 && c[1] > 1).length;
    const again = new Uint8Array(await (await get(`${base}${uri}/1.m4s`)).arrayBuffer());
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
    expect(converted.mock.calls.filter((c) => c[0] <= 1 && c[1] > 1).length).toBe(callsBefore);
    const { lumenPlaybackFields } = await import("@/lib/lumenServer/playbackStats");
    const fields = lumenPlaybackFields("lecture-1", "admin");
    expect(fields["srv.convSeg"]).toBe(2);
    expect(fields["srv.convBuilt"]).toBe(1);
    expect(fields["srv.convRam"]).toBe(1);
  });

  it("l'avance convertit derrière la demande, en priorité basse, jamais derrière la tête", async () => {
    const verdict = await (await eligibility("?audio=4&s=lecture-2")).json();
    const base = baseOf(verdict.master);
    const uri = /URI="(a4x[0-9a-f]{8})\.m3u8"/.exec(await (await get(verdict.master)).text())![1];
    await get(`${base}${uri}/0.m4s`);
    await vi.waitFor(() => expect(converted.mock.calls.some((c) => c[2] === 15)).toBe(true));
    const lead = converted.mock.calls.find((c) => c[2] === 15)!;
    expect(lead[0]).toBe(1); // à partir du segment qui suit la tête
  });

  it("une autre identité de conversion (un autre ffmpeg) : l'ancienne adresse répond 410, jamais d'autres octets", async () => {
    const verdict = await (await eligibility("?audio=4&s=lecture-3")).json();
    const base = baseOf(verdict.master);
    const uri = /URI="(a4x[0-9a-f]{8})\.m3u8"/.exec(await (await get(verdict.master)).text())![1];
    detection.mockResolvedValue({ available: true, path: "/usr/local/bin/ffmpeg", version: "7.1.5", sha256: "cd".repeat(32), encoders: ["eac3"], reference: REFERENCE, detectedAt: 0, ms: 1 });
    expect((await get(`${base}${uri}/1.m4s`)).status).toBe(410);
    // La piste sous son nom simple (copiée) n'existe pas non plus.
    expect((await get(`${base}a4/1.m4s`)).status).toBe(410);
  });

  it("l'admission : au-delà des lectures permises, `son-serveur-occupe` ; une lecture en cours reste admise", async () => {
    process.env.LUMEN_AUDIO_MAX_SESSIONS = "1";
    const first = await (await eligibility("?audio=4&s=lecture-a")).json();
    expect(first.ok).toBe(true);
    const second = await (await eligibility("?audio=4&s=lecture-b")).json();
    expect(second).toMatchObject({ ok: false, reason: "son-serveur-occupe" });
    expect((await (await eligibility("?audio=4&s=lecture-a")).json()).ok).toBe(true);
    // Une piste copiée ne passe pas par l'admission.
    expect((await (await eligibility("?audio=3&s=lecture-b")).json()).ok).toBe(true);
  });
});
