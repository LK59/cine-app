import { describe, it, expect, beforeEach, vi } from "vitest";

// Un dossier de journaux à ce fichier seul : les fichiers de test tournent en parallèle, et deux
// d'entre eux écrivent `player.log` et ses archives.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-activity-`);
});
import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "@/lib/logFile";
import { recordBeat, presenceOf, PRESENCE_TTL_MS, __testing as presence } from "@/lib/activity/presence";
import { buildSeances } from "@/lib/activity/seances";
import { readRecords, readFullLine, __testing as reader, type LogRecord } from "@/lib/activity/logReader";

const rec = (fields: Record<string, unknown>, t: number): LogRecord => ({ ...fields, _file: "player.log", _line: 0, _t: t });

describe("présence", () => {
  beforeEach(() => presence.reset());
  const beat = (over: Partial<Parameters<typeof recordBeat>[1]> = {}) => ({
    user: "raphael", jfId: "jf", at: 1_000_000, visible: true, playing: null, device: "iPhone · Safari", ...over,
  });

  it("dit « dans l'application » pour un onglet visible, « absent » passé le délai", () => {
    recordBeat("a", beat());
    expect(presenceOf("Raphael", 1_000_000 + 10_000).state).toBe("app");
    expect(presenceOf("raphael", 1_000_000 + PRESENCE_TTL_MS + 1).state).toBe("away");
    expect(presenceOf("raphael", 1_000_000 + PRESENCE_TTL_MS + 1).lastSeen).toBe(1_000_000);
  });

  it("l'appareil qui joue l'emporte, même caché : un film sur la télé, le téléphone en poche", () => {
    recordBeat("tel", beat({ visible: false }));
    recordBeat("mac", beat({ visible: false, playing: { itemId: "x", title: "Red Dragon" }, device: "Mac · Safari" }));
    const p = presenceOf("raphael", 1_000_000);
    expect(p.state).toBe("playing");
    expect(p.playing?.title).toBe("Red Dragon");
    expect(p.devices).toEqual(["Mac · Safari"]);
  });

  it("un onglet caché qui ne joue rien n'est pas une présence", () => {
    recordBeat("a", beat({ visible: false }));
    expect(presenceOf("raphael", 1_000_000).state).toBe("away");
  });
});

describe("séances", () => {
  it("regroupe par identifiant, et le dernier bilan l'emporte (séance perdue renvoyée plus tard)", () => {
    const seances = buildSeances([
      rec({ kind: "start", session: "s1", user: "lucas", title: "Ted Lasso", itemId: "i1", agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1" }, 1000),
      rec({ kind: "seek", session: "s1", user: "lucas", tookMs: 6651 }, 2000),
      rec({ kind: "seek", session: "s1", user: "lucas", tookMs: 285_891 }, 3000),
      rec({ kind: "rebuild", session: "s1", user: "lucas", reason: "source fermée en arrière-plan" }, 4000),
      rec({ kind: "stop", session: "s1", user: "lucas", why: "page", watched: 100 }, 5000),
      rec({ kind: "stop", session: "s1", user: "lucas", why: "lost", watched: 120 }, 9000),
    ]);
    expect(seances).toHaveLength(1);
    const s = seances[0];
    expect(s.device).toBe("iPhone · Safari");
    // Le saut de 286 s a traversé un passage en arrière-plan : ce n'est pas une attente.
    expect(s.seeks).toBe(2);
    expect(s.slowSeeks).toBe(1);
    expect(s.rebuilds).toBe(1);
    expect(s.stop?.why).toBe("lost");
    expect(s.stop?.watched).toBe(120);
  });

  it("reconstitue une séance d'avant les identifiants, sans y mêler une reconstruction", () => {
    const seances = buildSeances([
      rec({ kind: "start", user: "raphael", itemId: "p", title: "Le Parrain", rebuild: 0 }, 1000),
      rec({ kind: "start", user: "raphael", itemId: "p", title: "Le Parrain", rebuild: 1 }, 2000),
      rec({ kind: "start", user: "raphael", itemId: "p", title: "Le Parrain", rebuild: 0 }, 9000),
    ]);
    expect(seances).toHaveLength(2);
    expect(seances.every((s) => s.legacy)).toBe(true);
  });

  it("ignore les lignes du banc d'essai", () => {
    expect(buildSeances([rec({ kind: "start", session: "b", bench: "run-1", user: "louis" }, 1)])).toHaveLength(0);
  });
});

describe("lecture des journaux", () => {
  const file = () => path.join(LOG_DIR, "player.log");
  beforeEach(() => {
    reader.reset();
    fs.mkdirSync(LOG_DIR, { recursive: true });
    for (const f of fs.readdirSync(LOG_DIR)) if (f.startsWith("player.log")) fs.rmSync(path.join(LOG_DIR, f));
  });

  it("ne relit que la suite du fichier courant, et attend la fin d'une ligne à moitié écrite", () => {
    fs.writeFileSync(file(), JSON.stringify({ timestamp: "2026-09-24T10:00:00Z", kind: "start", steps: "x".repeat(5000) }) + "\n{\"kind\":\"se");
    const first = readRecords("player");
    expect(first).toHaveLength(1);
    // Les traces ne sont pas gardées dans la liste…
    expect(first[0].steps).toBe(true);
    fs.appendFileSync(file(), "ek\"}\n" + JSON.stringify({ kind: "stop" }) + "\n");
    const next = readRecords("player");
    expect(next.map((r) => r.kind)).toEqual(["start", "seek", "stop"]);
    // …mais la ligne entière se relit à la demande, à son rang.
    expect(String(readFullLine("player", "player.log", 0)?.steps).length).toBe(5000);
    expect(readFullLine("player", "player.log", 2)?.kind).toBe("stop");
  });

  // Relu le 24/09/2026 : une rotation renomme `.1` en `.2` et le fichier courant en `.1`. La
  // nouvelle `.1` étant plus longue que l'ancienne, elle passait pour « la même, plus longue » :
  // l'archive A comptait deux fois, la B disparaissait, et les numéros de ligne menaient ailleurs.
  it("ne confond pas une archive avec la précédente quand une seconde rotation les décale", () => {
    const at = (i: number) => new Date(Date.UTC(2026, 8, 20, 0, 0, i)).toISOString();
    const lines = (tag: string, n: number, from: number) =>
      Array.from({ length: n }, (_, i) => JSON.stringify({ timestamp: at(from + i), kind: tag })).join("\n") + "\n";
    fs.writeFileSync(file(), lines("A", 3, 0));
    expect(readRecords("player")).toHaveLength(3);
    fs.renameSync(file(), file() + ".1");
    fs.writeFileSync(file(), lines("B", 5, 10));
    expect(readRecords("player").map((r) => r.kind).join("")).toBe("AAABBBBB");
    fs.renameSync(file() + ".1", file() + ".2");
    fs.renameSync(file(), file() + ".1");
    fs.writeFileSync(file(), lines("C", 1, 20));
    const after = readRecords("player");
    expect(after.map((r) => r.kind).join("")).toBe("AAABBBBBC");
    // Et chaque ligne se relit à sa place, ou pas du tout.
    const b = after.find((r) => r.kind === "B")!;
    expect(readFullLine("player", b._file, b._line, b._t)?.kind).toBe("B");
    expect(readFullLine("player", "player.log.1", 0, Date.parse(at(0)))).toBeNull();
  });

  it("relit tout après une rotation", () => {
    fs.writeFileSync(file(), JSON.stringify({ kind: "a" }) + "\n" + JSON.stringify({ kind: "b" }) + "\n");
    expect(readRecords("player")).toHaveLength(2);
    fs.renameSync(file(), file() + ".1");
    fs.writeFileSync(file(), JSON.stringify({ kind: "c" }) + "\n");
    expect(readRecords("player").map((r) => r.kind)).toEqual(["a", "b", "c"]);
  });
});

describe("lecture bornée dans le temps (journaux de plusieurs centaines d'archives)", () => {
  const file = () => path.join(LOG_DIR, "player.log");
  const line = (kind: string, iso: string) => JSON.stringify({ timestamp: iso, kind }) + "\n";
  beforeEach(() => {
    reader.reset();
    fs.mkdirSync(LOG_DIR, { recursive: true });
    for (const f of fs.readdirSync(LOG_DIR)) if (f.startsWith("player.log")) fs.rmSync(path.join(LOG_DIR, f));
  });

  it("n'ouvre pas une archive entièrement plus ancienne que la période", async () => {
    fs.writeFileSync(file() + ".2", line("tres-vieux", "2026-01-01T00:00:00Z"));
    fs.writeFileSync(file() + ".1", line("vieux", "2026-09-01T00:00:00Z"));
    fs.writeFileSync(file(), line("recent", "2026-09-24T00:00:00Z"));
    // Une archive n'est plus écrite après sa rotation : sa date dit jusqu'où elle va.
    fs.utimesSync(file() + ".2", new Date("2026-01-01"), new Date("2026-01-01"));
    fs.utimesSync(file() + ".1", new Date("2026-09-01"), new Date("2026-09-01"));
    const { readRecords } = await import("@/lib/activity/logReader");
    const kinds = readRecords("player", Date.parse("2026-08-15")).map((r) => r.kind);
    expect(kinds).toEqual(["vieux", "recent"]);
    expect(readRecords("player").map((r) => r.kind)).toEqual(["tres-vieux", "vieux", "recent"]);
  });
});

describe("relus le 24/09/2026 au soir — erreurs et journaux figés", () => {
  beforeEach(() => {
    reader.reset();
    fs.mkdirSync(LOG_DIR, { recursive: true });
    for (const f of fs.readdirSync(LOG_DIR)) if (f.startsWith("server.log") || f.startsWith("auth.log")) fs.rmSync(path.join(LOG_DIR, f));
  });

  it("un geste de l'administrateur n'est pas une erreur serveur", async () => {
    const now = Date.now();
    const iso = new Date(now - 60_000).toISOString();
    fs.writeFileSync(
      path.join(LOG_DIR, "server.log"),
      [
        { timestamp: iso, level: "info", scope: "admin", user: "louis", message: "closeSessions" },
        { timestamp: iso, level: "error", scope: "api", user: "louis", message: "Jellyfin injoignable" },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n"
    );
    const { weekSignals } = await import("@/lib/activity/accounts");
    expect(weekSignals(now).serverErrors).toEqual([{ scope: "api", count: 1 }]);
  });

  it("les journaux figés dans un ticket gardent leurs booléens", async () => {
    fs.writeFileSync(
      path.join(LOG_DIR, "auth.log"),
      JSON.stringify({ timestamp: new Date().toISOString(), kind: "login", user: "louis", local: true, steps: "x".repeat(10) }) + "\n"
    );
    const { captureReportLogs } = await import("@/lib/reportLogs");
    const [line] = captureReportLogs("louis", { id: null, title: null }).auth;
    expect(line.local).toBe(true);
    // Le marqueur d'un champ lourd, lui, part.
    expect(line).not.toHaveProperty("steps");
  });
});
