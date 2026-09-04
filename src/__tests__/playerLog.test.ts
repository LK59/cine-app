import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The record of what happened to everybody's playback. It is written on behalf of a browser, so
// what matters is that the browser cannot decide who it was about, how much disk it costs, or
// whether a film keeps playing when the disk says no.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-log-"));
  vi.resetModules();
  vi.doMock("@/lib/db", () => ({ DATA_DIR: dir }));
});

afterEach(() => {
  vi.doUnmock("@/lib/db");
  fs.rmSync(dir, { recursive: true, force: true });
});

const lines = () =>
  fs
    .readFileSync(path.join(dir, "logs", "player.log"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("logPlaybackEvent", () => {
  it("écrit une ligne par événement, avec le compte et l'heure", async () => {
    const { logPlaybackEvent } = await import("@/lib/playerLog");
    logPlaybackEvent("louis", "fallback", { reason: "tampon refusé", path: "remux" });

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ kind: "fallback", user: "louis", reason: "tampon refusé", path: "remux" });
    expect(Date.parse(lines()[0].timestamp)).toBeGreaterThan(0);
  });

  it("crée son dossier plutôt que d'échouer parce qu'il n'existe pas", async () => {
    const { logPlaybackEvent } = await import("@/lib/playerLog");
    expect(fs.existsSync(path.join(dir, "logs"))).toBe(false);
    logPlaybackEvent("louis", "start", {});
    expect(lines()).toHaveLength(1);
  });

  it("borne ce qu'un navigateur peut faire écrire", async () => {
    // Every field here is chosen by the client, so the client decides what this costs on disk.
    const { logPlaybackEvent } = await import("@/lib/playerLog");
    const many: Record<string, unknown> = { reason: "x".repeat(5000) };
    for (let i = 0; i < 60; i++) many[`champ${i}`] = i;
    logPlaybackEvent("louis", "error", many);

    const written = lines()[0];
    expect(written.reason.length).toBe(500);
    // Three of its own keys, plus what a caller is allowed to add.
    expect(Object.keys(written).length).toBeLessThanOrEqual(27);
  });

  it("laisse de côté ce qui n'est ni texte, ni nombre, ni booléen", async () => {
    // Nothing nested: a log line is one flat object or it is not greppable.
    const { logPlaybackEvent } = await import("@/lib/playerLog");
    logPlaybackEvent("louis", "start", { ok: true, at: 12.3456, nested: { a: 1 }, list: [1], nothing: null });

    const written = lines()[0];
    expect(written).toMatchObject({ ok: true, at: 12.346 });
    expect(written.nested).toBeUndefined();
    expect(written.list).toBeUndefined();
    expect(written.nothing).toBeUndefined();
  });

  it("tourne le fichier plutôt que de remplir le disque", async () => {
    const { logPlaybackEvent } = await import("@/lib/playerLog");
    const file = path.join(dir, "logs", "player.log");
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    fs.writeFileSync(file, "x".repeat(6 * 1024 * 1024));

    logPlaybackEvent("louis", "start", {});
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(lines()).toHaveLength(1); // the new file holds only what came after the rotation
  });

  it("ne fait jamais tomber une lecture parce que le disque refuse", async () => {
    const { logPlaybackEvent } = await import("@/lib/playerLog");
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("disque plein");
    });
    expect(() => logPlaybackEvent("louis", "start", {})).not.toThrow();
    vi.restoreAllMocks();
  });
});
