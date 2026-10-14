import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { subtitleMatroska } from "./helpers/subtitleMatroska";

/**
 * L'indexation des répliques de bout en bout (DECISIONS.md §88) : une passe sur trois films réels
 * (écrits dans un dossier temporaire), la pause pendant une lecture, la pause demandée, la reprise,
 * les erreurs par film, la progression gardée, et le parallélisme refusé sans preuve.
 */

// Un dossier à soi, posé avant tout import : la base des répliques est un fichier, et d'autres
// fichiers de tests en écrivent une en même temps.
const dataDir = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/repliques-engine-`);
  process.env.DATA_DIR = dir;
  return dir;
});

const mocks = vi.hoisted(() => ({
  films: [] as { itemId: string; radarrId: number; title: string; file: string; originalLanguage: string | null }[],
  mount: { ok: true, problem: null as string | null, moviesPath: "/films", rootFolders: [], sample: { checked: 1, found: 1 } },
  waits: [] as boolean[],
  /** Quelqu'un regarde, jusqu'à nouvel ordre. */
  watching: false,
  disks: new Map<string, string[] | null>(),
}));

vi.mock("@/lib/repliques/library", () => ({
  libraryFilms: async () => mocks.films,
  checkMoviesMount: async () => mocks.mount,
}));
vi.mock("@/lib/repliques/playbackActivity", () => ({
  mustWaitForPlayback: async () => {
    const wait = mocks.watching || (mocks.waits.length > 0 ? mocks.waits.shift()! : false);
    return { wait, signal: { playing: wait, by: wait ? "jellyfin" : null, lastSeenAt: 0 } };
  },
}));
vi.mock("@/lib/repliques/disks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repliques/disks")>()),
  diskOf: async (file: string) => mocks.disks.get(file) ?? null,
}));

import { pauseIndexing, repliquesStatus, startIndexing, rebuildIndex, nightlyDue, inNightWindow, nightKey, __testing } from "@/lib/repliques/engine";
import { closeRepliquesDb, indexCounts, readMeta } from "@/lib/repliques/store";
import { searchDialogue } from "@/lib/repliques/search";
import { SETTINGS_BY_KEY } from "@/lib/settings/schema";
import { config } from "@/lib/config";

const lines = (label: string): [number, number, string][] => [
  [1, 1000, `${label} : je suis ton père`],
  [3, 1000, `${label} : personne ne bouge`],
];

function film(n: number, ok = true) {
  const folder = path.join(dataDir, "films", `Film ${n}`);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `Film ${n}.mkv`);
  fs.writeFileSync(file, ok ? subtitleMatroska(6, [{ number: 2, codec: "S_TEXT/UTF8", language: "fre", lines: lines(`film${n}`) }]) : new Uint8Array([1, 2, 3, 4]));
  return { itemId: String(n).repeat(32).slice(0, 32), radarrId: n, title: `Film ${n}`, file, originalLanguage: "French" };
}

beforeAll(() => {
  mocks.films = [film(1), film(2), film(3, false)];
});

beforeEach(() => {
  __testing.reset();
  __testing.live.pollMs = 5;
  mocks.waits = [];
  mocks.watching = false;
  mocks.disks.clear();
  process.env.REPLIQUES_ENABLED = "true";
});

afterEach(async () => {
  await __testing.waitIdle();
});

describe("l'option", () => {
  it("est coupée par défaut, et rien ne démarre tant qu'elle l'est", async () => {
    expect(SETTINGS_BY_KEY.get("REPLIQUES_ENABLED")?.fallback).toBe("false");
    delete process.env.REPLIQUES_ENABLED;
    expect(config.repliques.enabled).toBe(false);
    expect(await startIndexing()).toBe("disabled");
    expect(__testing.live.loop).toBeNull();
  });

  it("refuse de démarrer quand le dossier des films n'est pas lisible", async () => {
    mocks.mount = { ...mocks.mount, ok: false, problem: "not-mounted" };
    try {
      expect(await startIndexing()).toBe("unavailable");
      expect((await repliquesStatus()).phase).toBe("unavailable");
    } finally {
      mocks.mount = { ...mocks.mount, ok: true, problem: null };
    }
  });
});

describe("une passe", () => {
  it("se met en pause pendant une lecture, puis lit chaque film, note les erreurs et garde la progression", async () => {
    // Quelqu'un regarde : la passe attend avant la première lecture de fichier, et la phase le dit.
    mocks.watching = true;
    expect(await startIndexing()).toBeNull();
    await vi.waitFor(() => expect(__testing.live.phase).toBe("waiting-playback"));
    await new Promise((r) => setTimeout(r, 50));
    expect(indexCounts().lines).toBe(0);
    expect((await repliquesStatus()).run?.done).toBe(0);
    // La lecture finie, elle reprend d'elle-même.
    mocks.watching = false;
    await __testing.waitIdle();
    const status = await repliquesStatus();
    expect(status.phase).toBe("done");
    expect(status.run).toMatchObject({ kind: "initial", total: 3, done: 3, errors: 1 });
    expect(status.initialDone).toBe(true);
    expect(status.errors.map((e) => e.title)).toEqual(["Film 3"]);
    expect(status.parallel).toEqual({ queues: 1, reason: "unproven" });
    expect(indexCounts()).toMatchObject({ films: 3, filmsWithLines: 2, lines: 4 });
    // Insensible aux accents et à la casse.
    expect(searchDialogue("JE SUIS TON PERE").films.map((f) => f.radarrId).sort()).toEqual([1, 2]);
  });

  it("ne relit rien d'inchangé, relit un film modifié (réencodé) et retire un film disparu", async () => {
    const before = readMeta<{ startedAt: number }>("run")!.startedAt;
    // Film 1 réécrit (autre taille), Film 2 retiré de la bibliothèque.
    fs.writeFileSync(mocks.films[0].file, subtitleMatroska(8, [{ number: 2, codec: "S_TEXT/UTF8", language: "fre", lines: [[1, 900, "nouvelle version"]] }]));
    const kept = mocks.films;
    mocks.films = [kept[0], kept[2]];
    try {
      await startIndexing();
      await __testing.waitIdle();
      const status = await repliquesStatus();
      expect(status.run!.startedAt).toBeGreaterThanOrEqual(before);
      // Le film modifié et le film en erreur (réessayé) ; l'autre est retiré.
      expect(status.run).toMatchObject({ total: 2, done: 2, removed: 1 });
      expect(searchDialogue("nouvelle version").films.map((f) => f.radarrId)).toEqual([1]);
      expect(searchDialogue("je suis ton pere").films).toEqual([]);
    } finally {
      mocks.films = kept;
    }
  });

  it("s'arrête sur « Mettre en pause », s'en souvient, et reprend au film suivant", async () => {
    closeRepliquesDb();
    await rebuildIndex();
    // Une lecture en cours tient la passe en attente le temps de demander la pause.
    mocks.watching = true;
    await vi.waitFor(() => expect(__testing.live.phase).toBe("waiting-playback"));
    await pauseIndexing();
    let status = await repliquesStatus();
    expect(status.phase).toBe("paused");
    expect(status.run?.userPaused).toBe(true);
    expect(status.run?.finishedAt).toBeNull();
    mocks.watching = false;
    expect(await startIndexing()).toBeNull();
    await __testing.waitIdle();
    status = await repliquesStatus();
    expect(status.phase).toBe("done");
    expect(status.run).toMatchObject({ done: 3, total: 3, userPaused: false });
  });

  it("lit en parallèle seulement sur des disques prouvés distincts", async () => {
    closeRepliquesDb();
    mocks.disks.set(mocks.films[0].file, ["sda"]);
    mocks.disks.set(mocks.films[1].file, ["sdb"]);
    mocks.disks.set(mocks.films[2].file, ["sdc"]);
    await rebuildIndex();
    await __testing.waitIdle();
    expect((await repliquesStatus()).parallel).toEqual({ queues: 3, reason: "proven" });
    // Un seul sans preuve : tout en série.
    mocks.disks.delete(mocks.films[2].file);
    await rebuildIndex();
    await __testing.waitIdle();
    expect((await repliquesStatus()).parallel).toEqual({ queues: 1, reason: "unproven" });
  });
});

describe("la nuit", () => {
  const at = (h: number) => new Date(2026, 9, 14, h, 30);
  it("reconnaît la plage, y compris à cheval sur minuit", () => {
    expect(inNightWindow(at(3), 2, 6)).toBe(true);
    expect(inNightWindow(at(6), 2, 6)).toBe(false);
    expect(inNightWindow(at(23), 22, 6)).toBe(true);
    expect(inNightWindow(at(5), 22, 6)).toBe(true);
    expect(inNightWindow(at(12), 22, 6)).toBe(false);
    expect(nightKey(at(5), 22)).toBe("2026-10-13");
  });
  it("ne part qu'une fois par nuit, et jamais avant la fin de l'indexation initiale", () => {
    const base = { enabled: true, nightly: true, initialDone: true, start: 2, end: 6, lastNight: null, userPaused: false };
    expect(nightlyDue(at(3), base)).toBe(true);
    expect(nightlyDue(at(3), { ...base, initialDone: false })).toBe(false);
    expect(nightlyDue(at(3), { ...base, lastNight: "2026-10-14" })).toBe(false);
    expect(nightlyDue(at(12), base)).toBe(false);
    expect(nightlyDue(at(3), { ...base, enabled: false })).toBe(false);
  });
});
