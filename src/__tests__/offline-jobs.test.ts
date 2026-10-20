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
// Le vrai `logger` pour le reste : les lignes du journal (`offline/events.ts`) vont dans le `DATA_DIR` jetable.
vi.mock("@/lib/logger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/logger")>()), logError: () => {} }));

import { getDb } from "@/lib/db";
import { Writable } from "node:stream";
import {
  enforceOfflineQuota,
  forgetOfflineJob,
  listOfflineCopies,
  markOfflineFetched,
  OFFLINE_MAX_IN_FLIGHT,
  OfflineRefusal,
  offlineDir,
  offlineFile,
  offlineInFlight,
  offlineIndex,
  offlineJobFor,
  releaseFetchedCopies,
  requestOfflineJob,
  type OfflineJob,
} from "@/lib/offline/jobs";

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

/** Un flux Jellyfin qui livre `first` puis ne donne plus rien, et lève quand on l'annule — comme `fetch`. */
const hanging = (signal: AbortSignal | null | undefined, first: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(first);
      signal?.addEventListener("abort", () => c.error(new DOMException("annulé", "AbortError")));
    },
  });
const DISK_MARGIN = 5 * 1024 ** 3;
/** L'estimation d'une version Standard de 3 s (voir plus haut). */
const STANDARD_3S = Math.round(((3 * 2_128_000) / 8) * 1.05);

describe("les défauts du 19/10 (relecture du serveur)", () => {
  it("une préparation annulée en plein flux ferme son fichier (le descripteur gardait les octets alloués)", async () => {
    process.env.OFFLINE_DOWNLOADS = "true";
    const real = fs.createWriteStream.bind(fs);
    let written: fs.WriteStream | undefined;
    const spy = vi.spyOn(fs, "createWriteStream").mockImplementation(((...a: Parameters<typeof fs.createWriteStream>) => (written = real(...a))) as typeof fs.createWriteStream);
    try {
      upstream.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/stream.mp4")) return new Response(hanging(init?.signal, new Uint8Array(FIXTURE.subarray(0, 1000))), { status: 200 });
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return json(itemJson());
      });
      const job = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" });
      await vi.waitFor(() => expect(offlineJobFor("louis", job.id)?.bytes).toBe(1000), { timeout: 3000 });
      expect(written?.closed).toBe(false);
      forgetOfflineJob("louis", job.id);
      await vi.waitFor(() => expect(written?.closed).toBe(true), { timeout: 3000 });
    } finally {
      spy.mockRestore();
    }
  });

  it("les octets ne comptent qu'une fois sur le disque", async () => {
    process.env.OFFLINE_DOWNLOADS = "true";
    // Un flux d'écriture qui garde l'écriture en suspens jusqu'à ce qu'on la libère : ce qui est
    // confié au flux n'est pas encore lisible dans le fichier.
    const held: (() => void)[] = [];
    const spy = vi.spyOn(fs, "createWriteStream").mockImplementation(((file: string) =>
      new Writable({
        highWaterMark: 1 << 26,
        write(chunk: Buffer, _encoding, callback) {
          held.push(() => {
            fs.appendFileSync(file, chunk);
            callback();
          });
        },
      })) as unknown as typeof fs.createWriteStream);
    try {
      upstream.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/stream.mp4")) return new Response(new Uint8Array(FIXTURE), { status: 200 });
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return json(itemJson());
      });
      const job = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" });
      await vi.waitFor(() => expect(held.length).toBe(1), { timeout: 3000 });
      // L'écriture n'a pas encore eu lieu : rien n'est à lire.
      expect(offlineJobFor("louis", job.id)?.bytes).toBe(0);
      held.splice(0).forEach((release) => release());
      await vi.waitFor(() => expect(offlineJobFor("louis", job.id)?.status).toBe("done"), { timeout: 3000 });
      expect(offlineJobFor("louis", job.id)?.bytes).toBe(FIXTURE.length);
    } finally {
      spy.mockRestore();
    }
  });

  it("la place se compte avec ce que les préparations en attente vont encore écrire", async () => {
    process.env.OFFLINE_DOWNLOADS = "false";
    const spy = vi.spyOn(fs, "statfsSync").mockReturnValue({ bavail: DISK_MARGIN + 1.5 * STANDARD_3S, bsize: 1 } as fs.StatsFs);
    try {
      upstream.mockImplementation(async () => json(itemJson()));
      await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" });
      // Un deuxième épisode de la même taille : chacun tient seul, pas les deux.
      await expect(requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "h264" })).rejects.toMatchObject({ status: 507 });
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM offline_jobs").get()).toEqual({ n: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it("au départ, une préparation sans place échoue avec la raison ; la relancer redemande la place", async () => {
    process.env.OFFLINE_DOWNLOADS = "false";
    upstream.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/stream.mp4")) return new Response(hanging(init?.signal, new Uint8Array(FIXTURE.subarray(0, 1000))), { status: 200 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json(itemJson());
    });
    // Deux versions demandées quand il y avait la place…
    const a = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc", now: 1 });
    const b = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "h264", now: 2 });
    // …puis le disque s'est rempli : il n'en reste que pour une.
    const spy = vi.spyOn(fs, "statfsSync").mockReturnValue({ bavail: DISK_MARGIN + 1.5 * STANDARD_3S, bsize: 1 } as fs.StatsFs);
    try {
      process.env.OFFLINE_DOWNLOADS = "true";
      await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" });
      expect(offlineJobFor("louis", a.id)?.status).toBe("running");
      expect(offlineJobFor("louis", b.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/place/) });
      await expect(requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "h264" })).rejects.toMatchObject({ status: 507 });
      expect(offlineJobFor("louis", b.id)?.status).toBe("failed");
      forgetOfflineJob("louis", a.id);
      await vi.waitFor(
        () => expect(upstream.mock.calls.some(([url, init]) => (init as RequestInit | undefined)?.method === "DELETE" && String(url).includes("ActiveEncodings"))).toBe(true),
        { timeout: 3000 }
      );
    } finally {
      spy.mockRestore();
    }
  });

  const indexJob = (id: string, bytes: number, generation = 1): OfflineJob => ({
    id,
    itemId: ITEM,
    fileVersion: "v1",
    audioIndex: 1,
    quality: "standard",
    codec: "hevc",
    status: "running",
    generation,
    bytes,
    expectedBytes: bytes,
    runtimeSeconds: 3,
    error: null,
  });

  it("deux lectures de l'index en même temps ne dupliquent pas les fragments", async () => {
    const id = "d".repeat(32);
    fs.mkdirSync(offlineDir(), { recursive: true });
    fs.writeFileSync(offlineFile(id), FIXTURE);
    const [one, two] = await Promise.all([offlineIndex(indexJob(id, FIXTURE.length), 0), offlineIndex(indexJob(id, FIXTURE.length), 0)]);
    // La référence : une lecture seule, sur une entrée neuve (autre génération).
    const alone = await offlineIndex(indexJob(id, FIXTURE.length, 2), 0);
    expect(alone.fragments.length).toBeGreaterThan(0);
    expect(one.fragments).toEqual(alone.fragments);
    expect(two.fragments).toEqual(alone.fragments);
  });

  it("l'index ne lit jamais au-delà de ce que le fichier contient", async () => {
    const id = "e".repeat(32);
    const cut = Math.floor(FIXTURE.length * 0.6);
    fs.mkdirSync(offlineDir(), { recursive: true });
    fs.writeFileSync(offlineFile(id), FIXTURE.subarray(0, cut));
    // Un compte en avance sur le disque : le reste se lisait en zéros, pris pour des boîtes.
    const index = await offlineIndex(indexJob(id, FIXTURE.length), 0);
    expect(index.next).toBeLessThanOrEqual(cut);
    for (const f of index.fragments) expect(f.offset + f.size).toBeLessThanOrEqual(cut);
  });
});

describe("la place des versions sur le serveur (quota, 20/10/2026)", () => {
  const put = (id: string, status: string, bytes: number, accessedAt: number) =>
    getDb()
      .prepare(
        `INSERT INTO offline_jobs (id, item_id, file_version, audio_index, quality, codec, status, generation, bytes, expected_bytes, runtime_s, created_at, accessed_at)
         VALUES (?, ?, 'v1', 1, 'standard', 'hevc', ?, 1, ?, ?, 3, ?, ?)`
      )
      .run(id, ITEM, status, bytes, bytes, accessedAt, accessedAt);
  const ask = (account: string, id: string) => getDb().prepare("INSERT INTO offline_requests (account, job_id, created_at) VALUES (?, ?, 0)").run(account, id);
  const left = () => (getDb().prepare("SELECT id FROM offline_jobs ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  const GB = 1024 ** 3;

  it("au-delà de la limite, efface les plus anciennes que tous ont récupérées — jamais une en cours ou attendue", () => {
    put("a", "done", 20 * GB, 1); // la plus ancienne, récupérée par tous
    put("b", "done", 20 * GB, 2); // récupérée par l'un, pas par l'autre : gardée
    put("c", "done", 20 * GB, 3); // récupérée, plus récente
    put("d", "running", 20 * GB, 4); // en préparation : jamais
    ask("louis", "a");
    ask("louis", "b");
    ask("mathis", "b");
    ask("louis", "c");
    ask("louis", "d");
    markOfflineFetched("louis", "a");
    markOfflineFetched("louis", "b");
    markOfflineFetched("louis", "c");
    // 80 Go pour 50 : « a » puis « c » partent ; « b » et « d » restent, au-dessus de la limite.
    enforceOfflineQuota(50 * GB);
    expect(left()).toEqual(["b", "d"]);
    // Le second appareil finit : « b » devient effaçable, et part dès que la limite l'exige.
    markOfflineFetched("mathis", "b");
    enforceOfflineQuota(30 * GB);
    expect(left()).toEqual(["d"]);
  });

  it("sous la limite, rien ne bouge — les trois jours de garde font le reste", () => {
    put("a", "done", 10 * GB, 1);
    ask("louis", "a");
    markOfflineFetched("louis", "a");
    enforceOfflineQuota(50 * GB);
    expect(left()).toEqual(["a"]);
  });
});

/**
 * Revue de sécurité du 20/10/2026 : au plus cinquante versions en vol par compte (Louis : « genre 50
 * downloads simultanés »), et une version que tous ont récupérée quitte le serveur peu après (« on
 * libère automatiquement dès que possible dès que le client l'a »).
 */
describe("cinquante en vol, libérées dès que récupérées", () => {
  const put = (id: string, status: string, accessedAt: number, item = ITEM) =>
    getDb()
      .prepare(
        `INSERT INTO offline_jobs (id, item_id, file_version, audio_index, quality, codec, status, generation, bytes, expected_bytes, runtime_s, created_at, accessed_at)
         VALUES (?, ?, 'v1', 1, 'standard', 'hevc', ?, 1, 1000, 1000, 3, ?, ?)`
      )
      .run(id, item, status, accessedAt, accessedAt);
  const ask = (account: string, id: string) => getDb().prepare("INSERT INTO offline_requests (account, job_id, created_at) VALUES (?, ?, 0)").run(account, id);
  const left = () => (getDb().prepare("SELECT id FROM offline_jobs ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  const hex = (n: number) => n.toString(16).padStart(32, "0");
  /** `n` versions en vol pour ce compte, de titres tous différents de `ITEM` sauf la première. */
  const fill = (account: string, n: number) => {
    for (let i = 0; i < n; i++) {
      put(`job${i}`, i % 3 === 0 ? "queued" : i % 3 === 1 ? "running" : "done", 1, i === 0 ? ITEM : hex(i + 1));
      ask(account, `job${i}`);
    }
  };

  it("la cinquante et unième est refusée (429 offline-limit), sans appel à Jellyfin", async () => {
    process.env.OFFLINE_DOWNLOADS = "false";
    upstream.mockImplementation(async () => json(itemJson()));
    fill("louis", OFFLINE_MAX_IN_FLIGHT);
    expect(offlineInFlight("louis")).toBe(50);
    const refused = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 2, quality: "standard", codec: "hevc" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OfflineRefusal);
    expect(refused).toMatchObject({ status: 429, code: "offline-limit", extra: { max: 50 } });
    expect(upstream).not.toHaveBeenCalled();
    // Un autre compte n'en est pas gêné, même pour la même version.
    expect((await requestOfflineJob({ account: "mathis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" })).id).toBe("job0");
  });

  it("redemander une version déjà en vol n'en est pas une de plus ; une récupérée libère sa place", async () => {
    process.env.OFFLINE_DOWNLOADS = "false";
    upstream.mockImplementation(async () => json(itemJson()));
    fill("louis", OFFLINE_MAX_IN_FLIGHT);
    // La même version (titre, fichier, piste, qualité, codec) : acceptée, rien de neuf.
    expect((await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" })).id).toBe("job0");
    expect(offlineInFlight("louis")).toBe(50);
    // Une version prête qu'il a récupérée entière ne compte plus : une nouvelle demande passe.
    markOfflineFetched("louis", "job2");
    expect(offlineInFlight("louis")).toBe(49);
    await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 2, quality: "standard", codec: "hevc" });
    expect(offlineInFlight("louis")).toBe(50);
    // Un échec ne compte pas non plus.
    getDb().prepare("UPDATE offline_jobs SET status = 'failed' WHERE id = 'job1'").run();
    expect(offlineInFlight("louis")).toBe(49);
  });

  it("une version récupérée par tous ses demandeurs quitte le serveur après le délai de grâce — pas avant, pas sans les autres", () => {
    const GRACE = 5 * 60_000;
    put("a", "done", 1000);
    ask("louis", "a");
    ask("mathis", "a");
    put("b", "done", 1000); // retirée par tous avant la fin : gardée pour qui la redemanderait
    put("c", "running", 1000);
    ask("louis", "c");
    markOfflineFetched("louis", "a");
    markOfflineFetched("louis", "c"); // sans effet sur une version en préparation
    releaseFetchedCopies(1000 + GRACE * 100);
    expect(left()).toEqual(["a", "b", "c"]);
    markOfflineFetched("mathis", "a");
    // Pendant la grâce : l'appareil relit l'état juste après la dernière plage, il ne doit pas trouver 404.
    releaseFetchedCopies(1000 + GRACE - 1);
    expect(left()).toEqual(["a", "b", "c"]);
    // L'Activité annonce l'effacement à cette date-là, pas dans trois jours.
    expect(listOfflineCopies().find((c) => c.id === "a")?.expiresAt).toBe(1000 + GRACE);
    releaseFetchedCopies(1000 + GRACE);
    expect(left()).toEqual(["b", "c"]);
  });

  it("le dernier qui ne l'avait pas entière la retire : les autres l'ont, elle peut partir", () => {
    put("a", "done", 1000);
    ask("louis", "a");
    ask("mathis", "a");
    markOfflineFetched("louis", "a");
    forgetOfflineJob("mathis", "a");
    releaseFetchedCopies(1000 + 5 * 60_000);
    expect(left()).toEqual([]);
  });

  it("redemandée par un compte qui l'avait récupérée, elle redevient « pas encore récupérée » pour lui", async () => {
    process.env.OFFLINE_DOWNLOADS = "false";
    upstream.mockImplementation(async () => json(itemJson()));
    put("job0", "done", 1000);
    ask("louis", "job0");
    markOfflineFetched("louis", "job0");
    expect(offlineInFlight("louis")).toBe(0);
    expect((await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc", now: 2000 })).id).toBe("job0");
    expect(offlineInFlight("louis")).toBe(1);
    // Il la télécharge de nouveau : elle reste.
    releaseFetchedCopies(10 ** 12);
    expect(left()).toEqual(["job0"]);
  });
});
