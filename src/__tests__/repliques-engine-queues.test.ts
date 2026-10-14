import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Les arrêts du moteur d'indexation des répliques quand une passe a plusieurs files ou qu'une
 * demande en suit une autre de près (DECISIONS.md §88, 14/10/2026). La lecture d'un film est
 * remplacée par une lecture commandée par le test : un film qui lit sans fin (chaque lecture passe
 * par la barrière), ou un film tenu jusqu'à ce que le test le libère.
 */

const dataDir = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/repliques-queues-`);
  process.env.DATA_DIR = dir;
  return dir;
});

const ctl = vi.hoisted(() => ({
  films: [] as { itemId: string; radarrId: number; title: string; file: string; originalLanguage: string | null }[],
  disks: new Map<string, string[] | null>(),
  calls: [] as string[],
  /** Lit sans fin : chaque lecture passe par la barrière, jusqu'à un arrêt. */
  endless: new Set<string>(),
  /** Tenu jusqu'à `release(title)`. */
  held: new Map<string, { promise: Promise<void>; release: () => void }>(),
}));

function hold(title: string): void {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  ctl.held.set(title, { promise, release });
}

vi.mock("@/lib/repliques/library", () => ({
  libraryFilms: async () => ctl.films,
  checkMoviesMount: async () => ({ ok: true, problem: null, moviesPath: "/films", rootFolders: [], sample: { checked: 1, found: 1 } }),
}));
vi.mock("@/lib/repliques/playbackActivity", () => ({
  mustWaitForPlayback: async () => ({ wait: false, signal: { playing: false, by: null, lastSeenAt: 0 } }),
}));
vi.mock("@/lib/repliques/disks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repliques/disks")>()),
  diskOf: async (file: string) => ctl.disks.get(file) ?? null,
}));
vi.mock("@/lib/repliques/indexFilm", () => ({
  indexFilm: async (film: { itemId: string; radarrId: number; title: string }, gate: (bytes: number) => Promise<void>) => {
    ctl.calls.push(film.title);
    if (ctl.endless.has(film.title)) {
      for (;;) {
        await gate(0);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    await gate(0);
    await ctl.held.get(film.title)?.promise;
    const norm = film.title.toLowerCase();
    return { rows: [{ itemId: film.itemId, radarrId: film.radarrId, lang: "fr", startMs: 0, endMs: 1000, text: film.title, norm }], sources: [], bytesRead: 0, reads: 1 };
  },
}));

import { pauseIndexing, repliquesStatus, startIndexing, __testing } from "@/lib/repliques/engine";
import { closeRepliquesDb, indexCounts } from "@/lib/repliques/store";

function film(title: string, n: number) {
  const folder = path.join(dataDir, "films", title);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${title}.mkv`);
  fs.writeFileSync(file, "x");
  return { itemId: String(n).padStart(32, "0"), radarrId: n, title, file, originalLanguage: "French" };
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  process.env.REPLIQUES_ENABLED = "true";
});

beforeEach(() => {
  __testing.reset();
  closeRepliquesDb();
  __testing.wipe();
  ctl.calls = [];
  ctl.endless.clear();
  ctl.held.clear();
  ctl.disks.clear();
});

afterEach(async () => {
  for (const h of ctl.held.values()) h.release();
  ctl.endless.clear();
  await vi.waitFor(() => expect(__testing.live.loop).toBeNull());
});

describe("plusieurs files", () => {
  // Avec `Promise.all`, le premier arrêt terminait la passe pendant que l'autre file finissait son
  // film ; le `finally` remettait l'arrêt à zéro, et cette file repartait au film suivant.
  it("un arrêt attend toutes les files, et aucune ne repart après", async () => {
    const [a1, a2, b1, b2] = [film("Aa", 1), film("Ab", 2), film("Ba", 3), film("Bb", 4)];
    ctl.films = [a1, a2, b1, b2];
    for (const f of [a1, a2]) ctl.disks.set(f.file, ["sda"]);
    for (const f of [b1, b2]) ctl.disks.set(f.file, ["sdb"]);
    ctl.endless.add("Aa");
    hold("Ba");
    expect(await startIndexing()).toBeNull();
    await vi.waitFor(() => expect(ctl.calls).toEqual(expect.arrayContaining(["Aa", "Ba"])));
    expect((await repliquesStatus()).parallel).toEqual({ queues: 2, reason: "proven" });

    let paused = false;
    const pause = pauseIndexing().then(() => (paused = true));
    // La file A s'est arrêtée ; la file B finit encore son film : la passe n'est pas finie.
    await settle();
    expect(__testing.live.loop).not.toBeNull();
    ctl.held.get("Ba")!.release();
    await pause;
    expect(paused).toBe(true);
    await settle();
    expect(ctl.calls).not.toContain("Bb");
    expect(ctl.calls).not.toContain("Ab");
    expect((await repliquesStatus()).run).toMatchObject({ userPaused: true, done: 1 });
    expect(indexCounts().films).toBe(1);
  });
});

describe("« Pause » puis « Reprendre » aussitôt", () => {
  it("la pause rend la main à la fin du film en cours, et la passe repart d'elle-même", async () => {
    const [f1, f2] = [film("Un", 11), film("Deux", 12)];
    ctl.films = [f1, f2];
    hold("Un");
    hold("Deux");
    await startIndexing();
    await vi.waitFor(() => expect(ctl.calls).toEqual(["Un"]));
    let paused = false;
    const pause = pauseIndexing().then(() => (paused = true));
    expect(await startIndexing()).toBeNull();
    ctl.held.get("Un")!.release();
    // Avant : « Reprendre » annulait l'arrêt, et la pause attendait toute la passe — « Deux » compris.
    await vi.waitFor(() => expect(paused).toBe(true));
    await pause;
    // Une nouvelle passe reprend au film suivant.
    await vi.waitFor(() => expect(ctl.calls).toEqual(["Un", "Deux"]));
    ctl.held.get("Deux")!.release();
    await vi.waitFor(async () => expect((await repliquesStatus()).phase).toBe("done"));
    expect(indexCounts().films).toBe(2);
    expect((await repliquesStatus()).run?.userPaused).toBe(false);
  });

  it("une nouvelle pause avant la fin de l'arrêt l'emporte : rien ne repart", async () => {
    const [f1, f2] = [film("Trois", 21), film("Quatre", 22)];
    ctl.films = [f1, f2];
    hold("Trois");
    await startIndexing();
    await vi.waitFor(() => expect(ctl.calls).toEqual(["Trois"]));
    const first = pauseIndexing();
    await startIndexing();
    const second = pauseIndexing();
    ctl.held.get("Trois")!.release();
    await Promise.all([first, second]);
    await settle();
    expect(__testing.live.loop).toBeNull();
    expect(ctl.calls).toEqual(["Trois"]);
    const status = await repliquesStatus();
    expect(status.phase).toBe("paused");
    expect(status.run?.userPaused).toBe(true);
  });
});

describe("la réparation de la base", () => {
  // Elle recompte le vocabulaire depuis les lignes : une passe qui écrirait pendant ce temps fausserait le compte.
  it("une passe l'attend avant de lire le moindre film", async () => {
    ctl.films = [film("Cinq", 31)];
    let release!: () => void;
    __testing.live.repair = new Promise<void>((resolve) => (release = resolve));
    await startIndexing();
    await settle();
    expect(__testing.live.phase).toBe("planning");
    expect(ctl.calls).toEqual([]);
    release();
    await vi.waitFor(async () => expect((await repliquesStatus()).phase).toBe("done"));
    expect(ctl.calls).toEqual(["Cinq"]);
  });
});
