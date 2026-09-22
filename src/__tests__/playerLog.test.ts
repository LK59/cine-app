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
  vi.doMock("@/lib/dataDir", () => ({ DATA_DIR: dir }));
});

afterEach(() => {
  vi.doUnmock("@/lib/dataDir");
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

  it("laisse à la chronologie d'un changement de piste la place de se raconter, bornée quand même", async () => {
    // 21/09/2026 : un changement de piste de 4,7 s sur un iPhone, impossible à décomposer depuis le
    // serveur. Coupées à 500 caractères, ses étapes auraient perdu justement la fin.
    const { logPlaybackEvent } = await import("@/lib/playerLog");
    logPlaybackEvent("louis", "audio", { steps: "e".repeat(3000), reason: "r".repeat(3000) });
    logPlaybackEvent("louis", "audio", { steps: "e".repeat(9000) });
    expect(lines()[0].steps).toHaveLength(3000);
    expect(lines()[0].reason).toHaveLength(500);
    expect(lines()[1].steps).toHaveLength(4000);
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
    expect(Object.keys(written).length).toBeLessThanOrEqual(31);
  });

  it("laisse de côté ce qui n'est ni texte, ni nombre, ni booléen", async () => {
    // Une ligne reste un objet plat, sinon elle ne se lit plus à la ligne de commande.
    const { logPlaybackEvent } = await import("@/lib/playerLog");
    logPlaybackEvent("louis", "start", { ok: true, at: 12.3456, list: [1], nothing: null });

    const written = lines()[0];
    expect(written).toMatchObject({ ok: true, at: 12.346 });
    expect(written.list).toBeUndefined();
    expect(written.nothing).toBeUndefined();
  });

  it("aplatit un objet d'un niveau plutôt que de le jeter", async () => {
    // 22/09/2026 : la mesure de l'accord du son et de l'image partait en objets
    // (`audioSync: { sourceMs, encoderMs }`, `frames: { total, dropped }`) et le journal les
    // jetait sans un mot — les premières séances qui devaient la porter n'en avaient rien.
    const { logPlaybackEvent } = await import("@/lib/playerLog");
    logPlaybackEvent("louis", "stop", {
      audioSync: { sourceMs: 40, encoderMs: 0 },
      frames: { total: 14400, dropped: 12 },
      deep: { inner: { x: 1 } },
    });

    const written = lines()[0];
    expect(written).toMatchObject({
      "audioSync.sourceMs": 40,
      "audioSync.encoderMs": 0,
      "frames.total": 14400,
      "frames.dropped": 12,
    });
    expect(written.audioSync).toBeUndefined();
    // Un seul niveau : ce qui est plus profond reste dehors.
    expect(Object.keys(written).some((key) => key.startsWith("deep"))).toBe(false);
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

/**
 * Le changement de piste audio est devenu un événement qu'on écrit.
 *
 * C'était le seul des trois gestes coûteux — lancement, saut, changement de piste — sur lequel on
 * n'avait aucun chiffre, faute de trace. Les lignes `rebuild`, qu'on avait d'abord prises pour
 * lui, sont des reprises après coupure réseau : deux choses différentes qui se seraient mélangées
 * dans la même lecture du journal.
 */
describe("l'événement d'un changement de piste audio", () => {
  it("est accepté, et reste distinct d'une reconstruction", async () => {
    const { isPlayerEventKind } = await import("@/lib/playerLog");
    expect(isPlayerEventKind("audio")).toBe(true);
    expect(isPlayerEventKind("rebuild")).toBe(true);
    expect(isPlayerEventKind("piste")).toBe(false);
  });

  it("s'écrit avec ce qu'il faut pour être exploitable", async () => {
    const { logPlaybackEvent } = await import("@/lib/playerLog");
    logPlaybackEvent("louis", "audio", { from: 2, to: 3, tookMs: 412, applied: true, processing: "copié tel quel" });
    expect(lines()[0]).toMatchObject({ kind: "audio", user: "louis", from: 2, to: 3, tookMs: 412, applied: true });
  });
});

/**
 * Un blocage de lecture s'écrit (22/09/2026) : une horloge figée dix-neuf secondes sous un
 * indicateur de chargement ne laissait au journal que la ligne `seek` d'avant.
 */
describe("l'événement d'un blocage de lecture", () => {
  it("est accepté, et garde tout ce que la source en dit, trace comprise", async () => {
    const { isPlayerEventKind, logPlaybackEvent } = await import("@/lib/playerLog");
    expect(isPlayerEventKind("stall")).toBe(true);

    // Ce que l'hôte envoie : la description du fichier (six champs), le chemin, et le relevé de
    // la source — et, pendant un banc d'essai, `bench` et `runaway` en plus. Le tout doit tenir
    // sous le plafond de champs de `clean()`, sinon les derniers — la trace en tête —
    // disparaîtraient sans un mot.
    const steps = Array.from({ length: 40 }, (_, i) => `+${i * 400} ms étape ${i}`).join(" | ");
    logPlaybackEvent("louis", "stall", {
      itemId: "x", title: "t", container: "mkv", video: "hevc", range: "SDR", agent: "a", bench: "banc-x", path: "remux",
      runaway: true, position: 166.4, stalledMs: 5250, readyState: 2, networkState: 2, seeking: false, source: "open",
      videoBuffered: "150.00–196.00", audioBuffered: "150.00–195.50", lead: 29.6, filling: false,
      recoveryStreak: 2, frozenNudges: 3, recoveries: 5, sinceAppendMs: 4100, streaming: true, steps,
    });
    const line = lines()[0];
    expect(line).toMatchObject({ kind: "stall", position: 166.4, frozenNudges: 3, recoveries: 5, streaming: true });
    // La trace n'est pas coupée à 500 caractères comme un champ ordinaire.
    expect(line.steps.length).toBeGreaterThan(500);
  });
});
