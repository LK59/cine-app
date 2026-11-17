import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Son propre DATA_DIR : le cache disque des index et celui du son converti s'y écrivent.
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-lumen-dlg-"));
});

import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextRequest } from "next/server";
import { FIXTURES, fixtureIndex, parseFragments } from "./lumenServer-helpers";

// « Améliorer les dialogues » derrière les routes de Lumen serveur (DECISIONS.md §191), sans ffmpeg : la détection et
// la conversion sont des doubles (la vraie, traitement compris, est éprouvée par `lumen-dialogue-bench.spec.ts`).
// Vérifié ici : l'option coupée ne change rien (le verdict dit pourquoi le traitement n'est pas servi) ; ouverte, le
// verdict donne la liste maître `&dialogue=`, qui sert chaque piste par son rendu traité ; l'init et les segments de ces
// rendus passent par la conversion avec le traitement (force, source Dolby) ; une autre identité = 410 ; l'admission.

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

const REFERENCE: Record<string, Uint8Array> = {};
const detection = vi.fn();
vi.mock("@/lib/lumenServer/audio/ffmpeg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lumenServer/audio/ffmpeg")>();
  return { ...actual, detectLumenFfmpeg: () => detection() };
});
const jobs: { n0: number; n1: number; codec: string; mode: string | null; niceness: number }[] = [];
vi.mock("@/lib/lumenServer/audio/convert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lumenServer/audio/convert")>();
  return {
    ...actual,
    convertRange: async (job: Parameters<typeof actual.convertRange>[0]) => {
      jobs.push({ n0: job.n0, n1: job.n1, codec: job.source.codec, mode: job.dialogue?.mode ?? null, niceness: job.niceness });
      const { segmentFrames, ENCODER_PREROLL } = await import("@/lib/lumenServer/audio/convertGrid");
      const [a, b] = segmentFrames(job.index, job.n0, job.n1);
      const frames = Array.from({ length: b - a + ENCODER_PREROLL + 4 }, () => REFERENCE[job.target.id]);
      const segments = new Map<number, Uint8Array>();
      for (let n = job.n0; n < job.n1; n++) {
        const [x, y] = segmentFrames(job.index, n, n + 1);
        segments.set(n, actual.convertedSegment(frames, a, x, y, n, job.index.delayUs));
      }
      return { segments, facts: { feedMs: 1, diskMs: 0, ffmpegMs: 2, inputBytes: 0, frames: b - a, silent: false, firstByteMs: 1, pooled: false } };
    },
  };
});

const DATA = process.env.DATA_DIR!;
const MEDIA = join(DATA, "media");
const CRA = "2".repeat(32);
const ADMIN = { u: "admin", role: "admin", jti: "j-admin" };
const detected = (sha = "ab") => ({ available: true, path: "/usr/local/bin/ffmpeg", version: "7.1.5", sha256: sha.repeat(32), encoders: ["eac3"], reference: REFERENCE, dolby: true, detectedAt: 0, ms: 1 });

beforeAll(async () => {
  mkdirSync(MEDIA, { recursive: true });
  copyFileSync(resolve(FIXTURES, "hevc-cra.mkv"), join(MEDIA, "hevc-cra.mkv"));
  FILES[CRA] = "hevc-cra.mkv";
  process.env.LUMEN_PATH_MAP = `/media=${MEDIA}`;
  process.env.LUMEN_WORKER_PATH = "inline";
  for (const [name, id] of [["eac3-late.mkv", "eac3-640-51"], ["eac3-short.mkv", "eac3-256-20"]] as const) {
    const { index, source } = await fixtureIndex(name);
    source.close();
    REFERENCE[id] = index.audio[0].firstFrame!;
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  jobs.length = 0;
  mockVerify.mockResolvedValue(ADMIN);
  detection.mockResolvedValue(detected());
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
const uris = (master: string) => [...master.matchAll(/URI="([^"]+)\.m3u8"/g)].map((m) => m[1]);

describe("option coupée : rien ne change", () => {
  it("le verdict reste `ok` sur la liste ordinaire et dit que le traitement n'est pas servi ; ffmpeg n'est pas cherché", async () => {
    const plain = await (await eligibility("?audio=3&s=lecture-1")).json();
    const verdict = await (await eligibility("?audio=3&s=lecture-1&dialogue=on")).json();
    expect(verdict).toMatchObject({ ok: true, audioTrack: 3, dialogue: { mode: "on", served: false, reason: "dialogues-piste" } });
    expect(verdict.master).toBe(plain.master);
    expect(verdict.master).not.toContain("dialogue");
    // Les faits des pistes gardent la forme d'avant (pas de champ `dialogue`).
    expect(verdict.audio.every((a: Record<string, unknown>) => !("dialogue" in a))).toBe(true);
    expect(detection).not.toHaveBeenCalled();
  });

  it("`dialogue=` mal formé : 410, au verdict comme à la liste maître", async () => {
    expect((await eligibility("?audio=3&s=lecture-1&dialogue=fort")).status).toBe(410);
    const ok = await (await eligibility("?audio=3&s=lecture-1")).json();
    expect((await get(`${ok.master}&dialogue=fort`)).status).toBe(410);
  });
});

describe("option en service, décodeur Dolby détecté", () => {
  beforeEach(() => {
    process.env.LUMEN_AUDIO_CONVERT = "admins";
  });

  it("la liste maître `&dialogue=on` : chaque piste par son rendu traité ; la liste ordinaire inchangée", async () => {
    const plain = await (await eligibility("?audio=3&s=lecture-2")).json();
    const plainText = await (await get(plain.master)).text();
    expect(uris(plainText).every((u) => !/d[12]x/.test(u))).toBe(true);
    const verdict = await (await eligibility("?audio=3&s=lecture-2&dialogue=on")).json();
    expect(verdict).toMatchObject({ ok: true, audioTrack: 3, dialogue: { mode: "on", served: true } });
    expect(verdict.master).toMatch(/master\.m3u8\?audio=3&dialogue=on$/);
    expect(verdict.audio.find((a: { number: number }) => a.number === 3)).toMatchObject({ dialogue: "eac3-640-51" });
    const text = await (await get(verdict.master)).text();
    // Les trois pistes servies (AC-3, E-AC-3, Opus converti), chacune par son rendu « dialogues » ; un seul DEFAULT.
    expect(uris(text).map((u) => u.replace(/x[0-9a-f]{8}$/, ""))).toEqual(uris(plainText).map((u) => u.replace(/x[0-9a-f]{8}$/, "").replace(/^(a\d+)$/, "$1") + "d1"));
    expect(text.split("\n").filter((l) => l.includes("DEFAULT=YES"))).toHaveLength(1);
    expect(text).toMatch(/CODECS="[^"]*,ec-3"/);
    // Ni la liste ordinaire ni ses adresses n'ont bougé (la version de format reste la même).
    expect(await (await get(plain.master)).text()).toBe(plainText);
    expect(verdict.version).toBe(plain.version);
  });

  it("init et segments d'un rendu traité : par la conversion, avec la force et la source Dolby ; l'avance suit", async () => {
    const verdict = await (await eligibility("?audio=3&s=lecture-3&dialogue=strong")).json();
    const base = baseOf(verdict.master);
    const uri = uris(await (await get(verdict.master)).text()).find((u) => u.startsWith("a3d2x"))!;
    const playlist = await (await get(`${base}${uri}.m3u8`)).text();
    expect(playlist).toContain(`#EXT-X-MAP:URI="init-${uri}.mp4"`);
    const init = new Uint8Array(await (await get(`${base}init-${uri}.mp4`)).arrayBuffer());
    expect(Buffer.from(init).includes(Buffer.from("dec3"))).toBe(true);
    const seg = await get(`${base}${uri}/1.m4s`);
    expect(seg.status).toBe(200);
    const [fragment] = parseFragments(new Uint8Array(await seg.arrayBuffer()));
    expect(fragment.samples.every((s) => s.duration === 32_000)).toBe(true);
    expect(jobs[0]).toMatchObject({ n0: 1, n1: 2, codec: "dolby", mode: "strong", niceness: 10 });
    // Le rendu ordinaire de la même piste reste la copie (jamais par la conversion).
    expect((await get(`${base}a3/1.m4s`)).status).toBe(200);
    expect(jobs.filter((j) => j.mode === null)).toHaveLength(0);
  });

  it("une autre identité (autre ffmpeg) ou l'autre force sous ce nom : 410", async () => {
    const verdict = await (await eligibility("?audio=3&s=lecture-4&dialogue=on")).json();
    const base = baseOf(verdict.master);
    const uri = uris(await (await get(verdict.master)).text()).find((u) => u.startsWith("a3d1x"))!;
    expect((await get(`${base}${uri.replace("d1x", "d2x")}/1.m4s`)).status).toBe(410);
    detection.mockResolvedValue(detected("cd"));
    expect((await get(`${base}${uri}/1.m4s`)).status).toBe(410);
    expect(jobs).toHaveLength(0);
  });

  it("l'admission : une lecture de plus qui convertirait n'est pas admise — le traitement non servi, la liste ordinaire", async () => {
    process.env.LUMEN_AUDIO_MAX_SESSIONS = "1";
    // Une première lecture traitée est admise et occupe la seule place.
    expect(await (await eligibility("?audio=3&s=lecture-5a&dialogue=on")).json()).toMatchObject({ dialogue: { served: true } });
    const verdict = await (await eligibility("?audio=3&s=lecture-5&dialogue=on")).json();
    expect(verdict).toMatchObject({ ok: true, dialogue: { mode: "on", served: false, reason: "son-serveur-occupe" } });
    expect(verdict.master).not.toContain("dialogue");
  });

  it("`prepare` avec `dialogue` : le segment de reprise du rendu traité", async () => {
    const { POST } = await import("@/app/api/lumen/[itemId]/prepare/route");
    const res = await POST(
      new NextRequest(`https://cine.example/api/lumen/${CRA}/prepare`, { method: "POST", headers: { cookie: "cine_session=t", "content-type": "application/json" }, body: JSON.stringify({ audio: 3, position: 4.5, s: "lecture-6", dialogue: "on" }) }),
      { params: Promise.resolve({ itemId: CRA }) }
    );
    expect(res.status).toBeLessThan(300);
    await vi.waitFor(() => expect(jobs.some((j) => j.mode === "on" && j.codec === "dolby")).toBe(true));
  });
});
