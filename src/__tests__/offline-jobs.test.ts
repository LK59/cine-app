import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Les préparations du téléchargement hors ligne (bêta, 19/10/2026, `offline/jobs.ts`) : une même
 * version sert tous les comptes, une piste inconnue est refusée, une préparation que plus personne
 * n'attend disparaît, et une préparation va jusqu'au fichier prêt — ici sur un MP4 fragmenté de la
 * forme exacte que Jellyfin livre (`fixtures/offline/`).
 */
const dir = vi.hoisted(() => {
  const d = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "cine-offline-"));
  process.env.DATA_DIR = d;
  process.env.JELLYFIN_URL = "http://jf";
  process.env.JELLYFIN_API_KEY = "k";
  return d as string;
});
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: dir }));
const upstream = vi.fn();
vi.mock("@/lib/jellyfinBreaker", () => ({ passJellyfinFetch: (...a: unknown[]) => upstream(...a) }));
vi.mock("@/lib/logger", () => ({ logError: () => {} }));

import { getDb } from "@/lib/db";
import { forgetOfflineJob, offlineFile, offlineJobFor, requestOfflineJob } from "@/lib/offline/jobs";

const ITEM = "a".repeat(32);
const FIXTURE = fs.readFileSync(path.join(process.cwd(), "src/__tests__/fixtures/offline/jellyfin-like.mp4"));
const itemJson = (etag = "v1") => ({
  Items: [{ Type: "Movie", RunTimeTicks: 3e7, MediaSources: [{ Id: ITEM, ETag: etag, MediaStreams: [{ Type: "Video", Index: 0 }, { Type: "Audio", Index: 1 }, { Type: "Audio", Index: 2 }] }] }],
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  upstream.mockReset();
  getDb().exec("DELETE FROM offline_jobs; DELETE FROM offline_requests;");
});

describe("requestOfflineJob", () => {
  it("la même version sert deux comptes ; une autre qualité est une autre version", async () => {
    process.env.OFFLINE_DOWNLOADS = "false"; // la file ne démarre pas : on ne teste que la demande
    upstream.mockImplementation(async () => json(itemJson()));
    const a = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" });
    const b = await requestOfflineJob({ account: "mathis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" });
    const c = await requestOfflineJob({ account: "mathis", itemId: ITEM, audioIndex: 1, quality: "high", codec: "hevc" });
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    expect(a.status).toBe("queued");
    // 3 s à 2 Mb/s + 128 kb/s, plus 5 %.
    expect(a.expectedBytes).toBe(Math.round(((3 * 2_128_000) / 8) * 1.05));
    // Chacun ne voit que ce qu'il a demandé.
    expect(offlineJobFor("louis", c.id)).toBeNull();
    expect(offlineJobFor("mathis", a.id)?.id).toBe(a.id);
  });

  it("une piste son qui n'existe pas dans le fichier est refusée", async () => {
    process.env.OFFLINE_DOWNLOADS = "false";
    upstream.mockImplementation(async () => json(itemJson()));
    await expect(requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 7, quality: "standard", codec: "hevc" })).rejects.toThrow(/Piste/);
  });

  it("une préparation que plus personne n'attend disparaît ; tant qu'un compte l'attend, elle reste", async () => {
    process.env.OFFLINE_DOWNLOADS = "false";
    upstream.mockImplementation(async () => json(itemJson()));
    const job = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" });
    await requestOfflineJob({ account: "mathis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" });
    expect(forgetOfflineJob("louis", job.id)).toBe(true);
    expect(offlineJobFor("mathis", job.id)).not.toBeNull();
    expect(forgetOfflineJob("mathis", job.id)).toBe(true);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM offline_jobs").get()).toEqual({ n: 0 });
    // Ce qu'on n'a pas demandé ne se retire pas.
    expect(forgetOfflineJob("louis", job.id)).toBe(false);
  });
});

describe("la préparation", () => {
  it("écrit le flux de Jellyfin sur le disque et finit « prête », avec les octets exacts", async () => {
    process.env.OFFLINE_DOWNLOADS = "true";
    const asked: string[] = [];
    upstream.mockImplementation(async (url: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/stream.mp4")) return new Response(new Uint8Array(FIXTURE), { status: 200 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json(itemJson());
    });
    const job = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 2, quality: "high", codec: "h264" });
    await vi.waitFor(() => expect(offlineJobFor("louis", job.id)?.status).toBe("done"), { timeout: 3000 });
    const done = offlineJobFor("louis", job.id)!;
    expect(done.bytes).toBe(FIXTURE.length);
    expect(fs.readFileSync(offlineFile(job.id)).equals(FIXTURE)).toBe(true);
    const stream = asked.find((a) => a.includes("/stream.mp4"))!;
    expect(stream).toContain("VideoCodec=h264");
    expect(stream).toContain("AudioStreamIndex=2");
    expect(stream).toContain("VideoBitrate=4000000");
    // Le transcodage est rendu à Jellyfin une fois fini.
    expect(asked.some((a) => a.startsWith("DELETE") && a.includes("ActiveEncodings"))).toBe(true);
  });

  it("un flux coupé avant la fin du film finit en échec, pas « prêt »", async () => {
    process.env.OFFLINE_DOWNLOADS = "true";
    upstream.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/stream.mp4")) return new Response(new Uint8Array(FIXTURE), { status: 200 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      // Un film de deux heures : le fichier de trois secondes est un transcodage interrompu.
      return json({ Items: [{ ...itemJson().Items[0], RunTimeTicks: 7200e7 }] });
    });
    const job = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" });
    await vi.waitFor(() => expect(offlineJobFor("louis", job.id)?.status).toBe("failed"), { timeout: 3000 });
    expect(offlineJobFor("louis", job.id)?.error).toMatch(/interrompu/);
  });
});
