import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Son propre DATA_DIR : le cache disque des index s'y écrit, comme pour `lumenServer-routes.test.ts`.
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-lumen-trials-"));
});

import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextRequest } from "next/server";
import { FIXTURES, parseFragments } from "./lumenServer-helpers";
import { describeFragments, masterTrialOptions, muxedMaster, muxedMediaPlaylist, muxVersion, parseMuxedPath, splitMuxTag, withMasterTrials } from "@/lib/lumenServer/trials";

// Les modes d'essai de démarrage et la chronologie de Lumen serveur (étape 3e de docs/remux-serveur/, DECISIONS §160) :
// - sans rien demander, rien ne change — la liste maître, les listes et les segments sont ceux de la règle ;
// - l'essai multiplexé (`mux=1`, version `…m1`) : la piste par défaut sans URI dans la liste maître (RFC 8216
//   §4.3.4.2.1), une variante qui lit `vm{N}.m3u8`, un init à deux pistes, et des segments dont les fragments des
//   deux pistes sont exactement ceux de la règle, renumérotés dans l'ordre ;
// - `?start=` et `?bw=moyen` ne touchent que la liste maître ;
// - la route `chrono` : l'horloge, l'échantillon de débit, et la chronologie de chaque requête d'une lecture
//   marquée — administrateur seul, comme toutes ces routes.

const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVisible = vi.fn();
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: (...a: unknown[]) => mockVisible(...a) }));
vi.mock("@/lib/logger", () => ({ logError: () => {} }));
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
const ADMIN = { u: "admin", role: "admin", jti: "j-admin" };

beforeAll(() => {
  mkdirSync(MEDIA, { recursive: true });
  copyFileSync(resolve(FIXTURES, "h264-aac.mkv"), join(MEDIA, "h264-aac.mkv"));
  Object.assign(FILES, { [H264]: "h264-aac.mkv" });
  process.env.LUMEN_PATH_MAP = `/media=${MEDIA}`;
  process.env.LUMEN_WORKER_PATH = "inline";
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue(ADMIN);
  mockVisible.mockResolvedValue(null);
  await (await import("@/lib/lumenServer/engine")).resetLumenEngine();
  (await import("@/lib/lumenServer/indexCache")).clearLumenIndexCache();
  (await import("@/lib/lumenServer/service")).forgetLumenFiles();
  (await import("@/lib/lumenServer/playbackStats")).forgetLumenPlaybacks();
  (await import("@/lib/lumenServer/segmentCache")).forgetSharedSegments();
});

function request(path: string): NextRequest {
  return new NextRequest(`https://cine.example${path}`, { headers: { cookie: "cine_session=t" } });
}

async function eligibility(query: string) {
  const { GET } = await import("@/app/api/lumen/[itemId]/eligibility/route");
  const res = await GET(request(`/api/lumen/${H264}/eligibility${query}`), { params: Promise.resolve({ itemId: H264 }) });
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; version: string; master: string; audioTrack: number };
}

async function get(path: string) {
  const m = /^\/api\/lumen\/([^/]+)\/([^/]+)\/([^/?]+)\/([^?]+)/.exec(path)!;
  const { GET } = await import("@/app/api/lumen/[itemId]/[version]/[s]/[...name]/route");
  return GET(request(path), { params: Promise.resolve({ itemId: m[1], version: m[2], s: m[3], name: m[4].split("/") }) });
}

async function chrono(query: string) {
  const { GET } = await import("@/app/api/lumen/[itemId]/chrono/route");
  return GET(request(`/api/lumen/${H264}/chrono${query}`), { params: Promise.resolve({ itemId: H264 }) });
}

const baseOf = (master: string) => master.slice(0, master.lastIndexOf("/") + 1);
const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe("les noms et les versions de l'essai multiplexé", () => {
  it("la version porte `m1` après la découpe ; tout autre suffixe reste dans la base (et la route le refuse)", () => {
    expect(muxVersion("3-0123456789ab")).toBe("3m1-0123456789ab");
    expect(muxVersion("3t2-0123456789ab")).toBe("3t2m1-0123456789ab");
    expect(splitMuxTag("3m1")).toEqual({ base: "3", mux: true });
    expect(splitMuxTag("3t2m1")).toEqual({ base: "3t2", mux: true });
    expect(splitMuxTag("3")).toEqual({ base: "3", mux: false });
    expect(splitMuxTag("m1")).toEqual({ base: "m1", mux: false });
    expect(splitMuxTag("3m2")).toEqual({ base: "3m2", mux: false });
  });

  it("les noms multiplexés, strictement", () => {
    expect(parseMuxedPath("vm3.m3u8")).toEqual({ kind: "playlist", track: 3 });
    expect(parseMuxedPath("init-vm3.mp4")).toEqual({ kind: "init", track: 3 });
    expect(parseMuxedPath("vm3/12.m4s")).toEqual({ kind: "segment", track: 3, n: 12 });
    for (const bad of ["vm0.m3u8", "vm3/012.m4s", "vm.m3u8", "v/1.m4s", "vm3/1.mp4"]) expect(parseMuxedPath(bad), bad).toBeNull();
  });

  it("les listes : la piste perd son URI, sa variante lit la vidéo multiplexée, le reste ne bouge pas", () => {
    const master = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-ec-3",LANGUAGE="fr",NAME="Français",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="6",URI="a2.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-ec-3",LANGUAGE="en",NAME="Anglais",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="6",URI="a3.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-mp4a.40.2",LANGUAGE="en",NAME="Commentaire",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="a4.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=9000000,AVERAGE-BANDWIDTH=5000000,CODECS="hvc1.2.4.L150.90,ec-3",AUDIO="aud-ec-3"',
      "v.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=9000000,AVERAGE-BANDWIDTH=5000000,CODECS="hvc1.2.4.L150.90,mp4a.40.2",AUDIO="aud-mp4a.40.2"',
      "v.m3u8",
      "",
    ].join("\n");
    const muxed = muxedMaster(master, 2).split("\n");
    expect(muxed[1]).not.toContain("URI=");
    expect(muxed[2]).toContain('URI="a3.m3u8"');
    expect(muxed[3]).toContain('URI="a4.m3u8"');
    expect(muxed[5]).toBe("vm2.m3u8");
    expect(muxed[7]).toBe("v.m3u8");
    expect(muxedMaster(master, 9)).toBe(master);
    const list = '#EXTM3U\n#EXT-X-MAP:URI="init-v.mp4"\n#EXTINF:4,\nv/0.m4s\n#EXTINF:4,\nv/1.m4s\n#EXT-X-ENDLIST\n';
    expect(muxedMediaPlaylist(list, 2)).toBe('#EXTM3U\n#EXT-X-MAP:URI="init-vm2.mp4"\n#EXTINF:4,\nvm2/0.m4s\n#EXTINF:4,\nvm2/1.m4s\n#EXT-X-ENDLIST\n');
  });

  it("`?start=` et `?bw=moyen` : la liste maître seule ; une valeur mal formée est ignorée", () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,AVERAGE-BANDWIDTH=5000000,CODECS="x"\nv.m3u8\n';
    expect(withMasterTrials(master, {})).toBe(master);
    const both = withMasterTrials(master, masterTrialOptions(new URLSearchParams("start=600&bw=moyen")));
    expect(both).toBe('#EXTM3U\n#EXT-X-START:TIME-OFFSET=600,PRECISE=YES\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=5000000,CODECS="x"\nv.m3u8\n');
    expect(masterTrialOptions(new URLSearchParams("start=-3&bw=crete"))).toEqual({});
    expect(masterTrialOptions(new URLSearchParams("start=abc"))).toEqual({});
  });
});

describe("de bout en bout", () => {
  it("sans essai, la liste maître et les segments de la règle ; `?start=`/`?bw=` ne changent que la liste maître", async () => {
    const verdict = await eligibility("?s=lecture-r");
    const plain = await (await get(verdict.master)).text();
    expect(plain).not.toContain("EXT-X-START");
    expect(plain).not.toMatch(/vm\d/);
    const trial = await (await get(`${verdict.master}&start=12.5&bw=moyen`)).text();
    expect(trial).toContain("#EXT-X-START:TIME-OFFSET=12.5,PRECISE=YES");
    expect(trial.replace("#EXT-X-START:TIME-OFFSET=12.5,PRECISE=YES\n", "").replace(/BANDWIDTH=\d+,AVERAGE/, "")).toBe(plain.replace(/BANDWIDTH=\d+,AVERAGE/, ""));
    // Un nom multiplexé sous la version de la règle n'existe pas : 410.
    expect((await get(`${baseOf(verdict.master)}vm${verdict.audioTrack}.m3u8`)).status).toBe(410);
  });

  it("l'essai multiplexé : liste maître, liste, init à deux pistes, segments faits des fragments de la règle", async () => {
    const ruled = await eligibility("?s=lecture-m");
    const verdict = await eligibility("?s=lecture-m&mux=1");
    expect(verdict.version).toBe(muxVersion(ruled.version));
    expect(verdict.master).toBe(`/api/lumen/${H264}/${verdict.version}/lecture-m/master.m3u8?audio=${verdict.audioTrack}`);
    const base = baseOf(verdict.master);
    const track = verdict.audioTrack;

    const master = await (await get(verdict.master)).text();
    expect(master).toContain(`\nvm${track}.m3u8\n`);
    expect(master).not.toContain(`URI="a${track}.m3u8"`);
    const list = await (await get(`${base}vm${track}.m3u8`)).text();
    expect(list).toContain(`#EXT-X-MAP:URI="init-vm${track}.mp4"`);
    expect(list).toContain(`\nvm${track}/0.m4s\n`);

    const init = await bytesOf(await get(`${base}init-vm${track}.mp4`));
    const text = new TextDecoder("latin1").decode(init);
    expect(text.split("trak").length - 1).toBe(2);
    expect(text.split("trex").length - 1).toBe(2);

    const muxed = await bytesOf(await get(`${base}vm${track}/1.m4s`));
    const rBase = baseOf(ruled.master);
    const video = parseFragments(await bytesOf(await get(`${rBase}v/1.m4s`)));
    const audio = parseFragments(await bytesOf(await get(`${rBase}a${track}/1.m4s`)));
    const parts = parseFragments(muxed);
    // Les mêmes échantillons, piste par piste, dans le même ordre.
    expect(parts.filter((f) => f.trackId === 1).flatMap((f) => f.data)).toEqual(video.flatMap((f) => f.data));
    expect(parts.filter((f) => f.trackId === 2).flatMap((f) => f.data)).toEqual(audio.flatMap((f) => f.data));
    expect(parts.filter((f) => f.trackId === 1).map((f) => f.baseDecode)).toEqual(video.map((f) => f.baseDecode));
    // Renumérotés dans l'ordre du fichier : n × 1000 + rang + 1, entrelacés par instant de décodage.
    expect(parts.map((f) => f.sequence)).toEqual(parts.map((_, i) => 1000 + i + 1));
    const decodes = describeFragments(muxed).map((f) => f.decodeUs);
    expect([...decodes].sort((a, b) => a - b)).toEqual(decodes);
    // Une autre révision de l'essai : 410.
    expect((await get(`/api/lumen/${H264}/${verdict.version.replace("m1-", "m7-")}/lecture-m/master.m3u8`)).status).toBe(410);
  });
});

describe("la route `chrono`", () => {
  it("l'horloge : t1 ≤ t2, sur l'horloge des horodatages ; la lecture est alors chronométrée requête par requête", async () => {
    const { serverClockMs } = await import("@/lib/lumenServer/playbackStats");
    const before = serverClockMs();
    const res = await chrono("?s=lecture-c");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const { t1, t2 } = (await res.json()) as { t1: number; t2: number };
    expect(t1).toBeGreaterThanOrEqual(before);
    expect(t2).toBeGreaterThanOrEqual(t1);

    const verdict = await eligibility("?s=lecture-c");
    await (await get(verdict.master)).text();
    const seg = await get(`${baseOf(verdict.master)}v/0.m4s`);
    await seg.arrayBuffer();
    const records = (await (await chrono("?s=lecture-c&records=1")).json()) as { entries: { name: string; at: number; ready?: number; first?: number; last?: number; bytes?: number }[] };
    expect(records.entries.map((e) => e.name)).toEqual(["master.m3u8", "v/0.m4s"]);
    const [m, v] = records.entries;
    expect(m.at).toBeGreaterThanOrEqual(t2);
    expect(m.ready).toBeGreaterThanOrEqual(0);
    expect(v.bytes).toBeGreaterThan(0);
    expect(v.last!).toBeGreaterThanOrEqual(v.first!);
    expect(v.first!).toBeGreaterThanOrEqual(v.ready!);
  });

  it("une lecture qui n'a pas demandé la chronologie n'en tient pas", async () => {
    const verdict = await eligibility("?s=lecture-n");
    await (await get(verdict.master)).text();
    const records = (await (await chrono("?s=lecture-n&records=1")).json()) as { entries: unknown[] };
    expect(records.entries).toEqual([]);
    const { lumenPlaybackStats } = await import("@/lib/lumenServer/playbackStats");
    expect(lumenPlaybackStats("lecture-n", "admin")?.chrono).toBeNull();
  });

  it("l'échantillon de débit : N octets en clair, sa longueur déclarée ; une taille mal formée répond 410", async () => {
    process.env.CINE_FRAMING_HEADERS = "1";
    try {
      const res = await chrono("?s=lecture-d&bytes=65536");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("x-cine-length")).toBe("65536");
      expect((await res.arrayBuffer()).byteLength).toBe(65536);
    } finally {
      delete process.env.CINE_FRAMING_HEADERS;
    }
    expect((await chrono("?s=lecture-d&bytes=0")).status).toBe(410);
    expect((await chrono("?s=x")).status).toBe(410);
  });

  it("administrateur seul, comme toutes les routes Lumen", async () => {
    mockVerify.mockResolvedValueOnce({ u: "bob", role: "user", jti: "j" });
    expect((await chrono("?s=lecture-z")).status).toBe(403);
    mockVerify.mockResolvedValueOnce(null);
    expect((await chrono("?s=lecture-z")).status).toBe(401);
  });
});
