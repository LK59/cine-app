import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { build, damaged } from "./helpers/zoneMatroska";

/**
 * La vérification de l'intégrité des fichiers (DECISIONS.md §93), de bout en bout sur une petite
 * bibliothèque écrite dans un dossier temporaire : ce qui est relu (et ce qui ne l'est pas), les zones
 * trouvées par le lecteur du lecteur natif, la pause pendant une lecture, le verrou commun avec
 * l'indexation des répliques, la pause demandée.
 */

const dirs = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const root = mkdtempSync(`${tmpdir()}/integrite-`);
  process.env.DATA_DIR = `${root}/data`;
  mkdirSync(process.env.DATA_DIR, { recursive: true });
  process.env.MOVIES_PATH = `${root}/movies`;
  process.env.TV_PATH = `${root}/tv`;
  return { root, movies: `${root}/movies`, tv: `${root}/tv` };
});

const mocks = vi.hoisted(() => ({ watching: false, asked: 0 }));
vi.mock("@/lib/repliques/playbackActivity", () => ({
  mustWaitForPlayback: async () => {
    mocks.asked++;
    return { wait: mocks.watching, signal: { playing: mocks.watching, by: mocks.watching ? "jellyfin" : null, lastSeenAt: 0 } };
  },
}));
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: async () => [
    { id: 11, title: "Film A", year: 2020, path: "/media/movies/Film A (2020)" },
    { id: 12, title: "Film B", year: 2021, path: "/media/movies/Film B (2021)" },
  ],
  cachedSeries: async () => [{ id: 21, title: "La Série", path: "/media/tv/La Serie" }],
}));

import { libraryFiles, wantedName } from "@/lib/integrity/library";
import { __testing, checkFile, integrityStatus, pauseIntegrityCheck, planFiles, startIntegrityCheck } from "@/lib/integrity/engine";
import { acquireDiskReads, diskReadsState, withDiskReads, __testing as lockTesting } from "@/lib/backgroundDiskReads";
import { integrityDb } from "@/lib/integrity/store";
import { getDb } from "@/lib/db";

const OLD = Date.now() / 1000 - 3600;
const healthy = build();
const brokenHeader = damaged(healthy.bytes, [healthy.clusters[3], 12]);
const brokenBlock = damaged(healthy.bytes, [healthy.blocks[2][2], 20], [healthy.blocks[4][1], 10]);

function put(file: string, bytes: Uint8Array, old = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  if (old) fs.utimesSync(file, OLD, OLD);
}

const A = path.join(dirs.movies, "Film A (2020)", "Film A (2020).mkv");
const B = path.join(dirs.movies, "Film B (2021)", "Film B (2021).mkv");
const C = path.join(dirs.movies, "Film C", "Film C.mp4");
const E = path.join(dirs.tv, "La Serie", "Season 1", "La Serie - S01E02 - Titre.mkv");

beforeAll(() => {
  put(A, healthy.bytes);
  put(B, brokenHeader);
  put(C, new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));
  put(E, brokenBlock);
  // Écartés : caché (un temporaire de FileFlows), temporaire, en cours d'écriture, hors de la bibliothèque.
  put(path.join(dirs.movies, "Film D", ".Film D.mkv"), healthy.bytes);
  put(path.join(dirs.movies, "Film D", "Film D.mkv.part"), healthy.bytes);
  put(path.join(dirs.movies, "Film F", "Film F.mkv"), healthy.bytes, false);
  put(path.join(dirs.root, "downloads", "Seed.mkv"), healthy.bytes);
});

beforeEach(() => {
  __testing.reset();
  __testing.live.pollMs = 5;
  __testing.live.bytesPerMs = 1e9;
  lockTesting.reset();
  mocks.watching = false;
  mocks.asked = 0;
});

async function until(check: () => boolean, what: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`toujours faux : ${what}`);
}

describe("intégrité — les fichiers de la bibliothèque", () => {
  it("films et épisodes, nommés par Radarr/Sonarr au dossier ; ni cachés, ni temporaires, ni en cours d'écriture, ni hors de la bibliothèque", async () => {
    const { files, settling } = await libraryFiles();
    expect(files.map((f) => f.path)).toEqual([A, B, C, E]);
    expect(settling).toBe(1);
    expect(files.find((f) => f.path === A)).toMatchObject({ kind: "movie", title: "Film A (2020)", serviceId: 11 });
    expect(files.find((f) => f.path === C)).toMatchObject({ kind: "movie", title: "Film C", serviceId: null });
    expect(files.find((f) => f.path === E)).toMatchObject({ kind: "episode", title: "La Série — S01E02", serviceId: 21 });
    expect(wantedName(".Film.mkv")).toBe(false);
    expect(wantedName("Film.mkv.fftemp")).toBe(false);
    expect(wantedName("Film.mkv")).toBe(true);
    expect(wantedName("Film.nfo")).toBe(false);
  });

  it("ne relit que le nouveau, le modifié, et ce qui était en erreur ; oublie ce qui a disparu", () => {
    const file = { path: "/a", size: 10, mtimeMs: 1000.4, kind: "movie" as const, title: "a", serviceId: null };
    const known = new Map([
      ["/a", { size: 10, mtimeMs: 1000, status: "ok" }],
      ["/gone", { size: 1, mtimeMs: 1, status: "ok" }],
    ]);
    expect(planFiles([file], known)).toEqual({ todo: [], removed: ["/gone"] });
    expect(planFiles([{ ...file, size: 11 }], known).todo).toHaveLength(1);
    expect(planFiles([{ ...file, mtimeMs: 2000 }], known).todo).toHaveLength(1);
    expect(planFiles([file], new Map([["/a", { size: 10, mtimeMs: 1000, status: "error" }]])).todo).toHaveLength(1);
  });
});

describe("intégrité — la relecture", () => {
  it("le même lecteur que le lecteur natif : sain, en-tête de grappe écrasé, blocs abîmés", async () => {
    const gate = { before: async () => {} };
    const files = (await libraryFiles()).files;
    const byPath = (p: string) => files.find((f) => f.path === p)!;
    expect(await checkFile(byPath(A), gate)).toMatchObject({ status: "ok", zones: [] });
    const b = await checkFile(byPath(B), gate);
    expect(b.status).toBe("damaged");
    expect(b.zones).toEqual([{ seconds: 5.2, byte: healthy.clusters[3] }]);
    const e = await checkFile(byPath(E), gate);
    expect(e.status).toBe("damaged");
    // Deux zones : la relecture reprend au point d'index qui suit la première.
    expect(e.zones.map((z) => z.byte)).toEqual([healthy.blocks[2][2], healthy.blocks[4][1]]);
    expect(await checkFile(byPath(C), gate)).toMatchObject({ status: "unsupported", bytesRead: 0 });
  });

  it("une passe complète, puis une seconde qui ne relit rien ; un fichier modifié est relu seul", async () => {
    getDb().prepare("DELETE FROM file_integrity").run();
    getDb().prepare("DELETE FROM file_integrity_meta").run();
    expect(startIntegrityCheck()).toBeNull();
    await __testing.waitIdle();
    const status = integrityStatus();
    expect(status.phase).toBe("done");
    expect(status.counts).toMatchObject({ ok: 1, damaged: 2, unsupported: 1, error: 0 });
    expect(status.problems.map((p) => [p.title, p.zones.length])).toEqual([
      ["Film B (2021)", 1],
      ["La Série — S01E02", 2],
    ]);
    expect(status.initialDone).toBe(true);
    expect(status.run).toMatchObject({ total: 4, done: 4, damaged: 2 });

    startIntegrityCheck();
    await __testing.waitIdle();
    expect(integrityStatus().run).toMatchObject({ total: 0, done: 0, bytesRead: 0 });

    fs.utimesSync(A, OLD + 60, OLD + 60);
    startIntegrityCheck();
    await __testing.waitIdle();
    expect(integrityStatus().run).toMatchObject({ total: 1, done: 1 });
    expect(integrityStatus().run!.bytesRead).toBeGreaterThan(0);
  });

  it("en pause pendant qu'on regarde un film — le verrou rendu — puis reprend seule", async () => {
    getDb().prepare("DELETE FROM file_integrity").run();
    getDb().prepare("DELETE FROM file_integrity_meta").run();
    mocks.watching = true;
    startIntegrityCheck();
    await until(() => integrityStatus().phase === "waiting-playback", "en pause pour la lecture");
    expect(integrityDb.counts().ok + integrityDb.counts().damaged).toBe(0);
    expect(diskReadsState().owner).toBeNull();
    expect(integrityStatus().playbackBy).toBe("jellyfin");
    mocks.watching = false;
    await __testing.waitIdle();
    expect(integrityStatus().counts.damaged).toBe(2);
  });

  it("jamais en même temps que l'indexation des répliques : le verrou commun", async () => {
    getDb().prepare("DELETE FROM file_integrity").run();
    getDb().prepare("DELETE FROM file_integrity_meta").run();
    const repliques = await acquireDiskReads("repliques");
    startIntegrityCheck();
    await until(() => integrityStatus().phase === "waiting-disk", "en attente des disques");
    expect(integrityStatus().diskBusyWith).toBe("repliques");
    expect(integrityDb.counts().ok).toBe(0);
    // L'indexation, qui tient le verrou, ne le reprend pas devant la vérification qui attend.
    let second = false;
    void withDiskReads("repliques", async () => {
      second = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(second).toBe(false);
    repliques.release();
    await __testing.waitIdle();
    expect(integrityStatus().counts.damaged).toBe(2);
    await until(() => second, "l'indexation repasse après");
    expect(diskReadsState().owner).toBeNull();
  });

  it("« Mettre en pause » est retenue ; « Reprendre » repart où la passe s'était arrêtée", async () => {
    getDb().prepare("DELETE FROM file_integrity").run();
    getDb().prepare("DELETE FROM file_integrity_meta").run();
    mocks.watching = true;
    startIntegrityCheck();
    await until(() => integrityStatus().phase === "waiting-playback", "en attente");
    await pauseIntegrityCheck();
    expect(integrityStatus().phase).toBe("paused");
    expect(integrityStatus().run?.userPaused).toBe(true);
    mocks.watching = false;
    startIntegrityCheck();
    await __testing.waitIdle();
    expect(integrityStatus().phase).toBe("done");
    expect(integrityStatus().counts.damaged).toBe(2);
  });
});

describe("le verrou commun des tâches de fond", () => {
  it("un propriétaire à la fois, plusieurs prises du même, l'autre servi avant une nouvelle prise du premier", async () => {
    const a = await acquireDiskReads("repliques");
    const b = await acquireDiskReads("repliques");
    expect(diskReadsState()).toEqual({ owner: "repliques", waiting: [] });
    let integrityIn = false;
    const pending = acquireDiskReads("integrite").then((lease) => {
      integrityIn = true;
      return lease;
    });
    expect(a.contended).toBe(true);
    let repliquesAgain = false;
    void acquireDiskReads("repliques").then((lease) => {
      repliquesAgain = true;
      lease.release();
    });
    a.release();
    await Promise.resolve();
    expect(integrityIn).toBe(false);
    b.release();
    const lease = await pending;
    expect(integrityIn).toBe(true);
    expect(repliquesAgain).toBe(false);
    lease.release();
    await until(() => repliquesAgain, "repliques servies ensuite");
    // Relâché deux fois : sans effet.
    lease.release();
    expect(diskReadsState().owner).toBeNull();
  });
});
