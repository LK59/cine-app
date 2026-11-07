import { describe, it, expect } from "vitest";
import { buildSeances, isPlannedHandoff } from "@/lib/activity/seances";
import { failuresOf } from "@/lib/activity/diagnosis";
import { isAlarmingServerLine, pathOf, periodStats } from "@/lib/activity/dashboard";
import { pathOfPlay } from "@/lib/activity/accounts";
import type { LogRecord } from "@/lib/activity/logReader";

// Le tableau de bord de l'Activité (07/11/2026) : n'est mis en avant que ce qui a vraiment gêné. Une
// reconstruction rattrapée, un passage prévu au lecteur serveur, une bascule sur la version allégée
// et un retour d'arrière-plan sont gérés par le lecteur — comptés, jamais des échecs.

let line = 0;
const rec = (session: string, t: number, fields: Record<string, unknown>): LogRecord =>
  ({ user: "lucas", session, itemId: "a", title: "Ted Lasso — S01E01 · Pilot", agent: "Mozilla/5.0 (iPhone)", ...fields, _file: "player.log", _line: line++, _t: t }) as LogRecord;

describe("ce qui est géré, ce qui ne l'est pas", () => {
  it("un refus d'emblée du chemin natif est un passage prévu ; une zone illisible, non", () => {
    expect(isPlannedHandoff('Aucun chemin de lecture disponible pour ce fichier. remux : Vidéo non prise en charge par ce navigateur : video/mp4; codecs="av01.0.19M.08"')).toBe(true);
    expect(isPlannedHandoff("InvalidStateError: The object is in an invalid state.")).toBe(false);
  });

  it("deux reconstructions sans repli ni erreur sont rattrapées ; trois, non", () => {
    const [two] = buildSeances([
      rec("a", 1000, { kind: "start" }),
      rec("a", 2000, { kind: "rebuild", reason: "InvalidStateError" }),
      rec("a", 3000, { kind: "rebuild", reason: "InvalidStateError" }),
      rec("a", 4000, { kind: "stop", why: "close", watched: 60 }),
    ]);
    expect(two).toMatchObject({ rebuilds: 0, recovered: 2 });
    expect(failuresOf(two)).toBe(0);
    const [three] = buildSeances([1, 2, 3].map((k) => rec("b", 1000 * k, { kind: "rebuild", reason: "InvalidStateError" })));
    expect(three.rebuilds).toBe(3);
    expect(three.recovered).toBeUndefined();
    expect(failuresOf(three)).toBe(3);
  });

  it("une reconstruction suivie d'un repli raté reste un incident", () => {
    const [s] = buildSeances([
      rec("c", 1000, { kind: "rebuild", reason: "décodeur" }),
      rec("c", 2000, { kind: "fallback", reason: "aucune image après 35 s" }),
    ]);
    expect(s).toMatchObject({ rebuilds: 1, fallbacks: 1 });
    expect(failuresOf(s)).toBe(2);
  });

  it("le passage prévu au lecteur serveur n'est ni un repli ni un échec", () => {
    const [s] = buildSeances([
      rec("d", 1000, { kind: "fallback", reason: "Aucun chemin de lecture disponible pour ce fichier. remux : ce navigateur n'accepte pas A_DTS et ne sait produire aucun codec de remplacement" }),
      rec("d", 2000, { kind: "start", player: "serveur" }),
    ]);
    expect(s).toMatchObject({ fallbacks: 0, planned: 1, player: "serveur" });
    expect(failuresOf(s)).toBe(0);
  });
});

describe("les blocages et le serveur", () => {
  it("un blocage que le diagnostic impute au réseau du spectateur est géré ; un blocage du décodeur, non", () => {
    const [s] = buildSeances([
      rec("n", 1000, { kind: "stall", position: 10, "diag.verdict": "réseau", "diag.linkVerdict": "suffisante" }),
      rec("n", 2000, { kind: "stall", position: 20, "diag.verdict": "autre", "diag.linkVerdict": "trop lente" }),
      rec("n", 3000, { kind: "stall", position: 30, "diag.verdict": "décodeur", "diag.linkVerdict": "suffisante" }),
    ]);
    expect(s).toMatchObject({ stalls: 1, netStalls: 2 });
    expect(failuresOf(s)).toBe(1);
  });

  it("n'alerte ni sur un avertissement, ni sur un EPUB illisible, ni sur un geste d'administrateur", () => {
    const line = (f: Record<string, unknown>) => ({ _file: "server.log", _line: 0, _t: 1, ...f }) as LogRecord;
    expect(isAlarmingServerLine(line({ level: "warn", scope: "books/google" }))).toBe(false);
    expect(isAlarmingServerLine(line({ level: "error", scope: "books/meta", stack: "EpubDefectError: zip sans fin" }))).toBe(false);
    // Telle que le lecteur des journaux la rend : sans sa pile (08/11/2026).
    expect(isAlarmingServerLine(line({ level: "error", scope: "books/meta", message: "pas d'OPF" }))).toBe(false);
    expect(isAlarmingServerLine(line({ level: "info", scope: "admin" }))).toBe(false);
    expect(isAlarmingServerLine(line({ level: "error", scope: "cinema-movies", stack: "Error: boom" }))).toBe(true);
  });
});

describe("les chiffres d'une période", () => {
  it("compte le taux sans accroc, les chemins, ce qui a été géré, les ouvertures", () => {
    const seances = buildSeances([
      rec("ok", 1000, { kind: "start", openedInMs: 800 }),
      rec("ok", 2000, { kind: "stop", why: "close", watched: 3600 }),
      rec("srv", 3000, { kind: "fallback", reason: "Aucun chemin de lecture disponible pour ce fichier. remux : Vidéo non prise en charge" }),
      rec("srv", 3500, { kind: "start", player: "serveur" }),
      rec("bad", 5000, { kind: "start", openedInMs: 2000, user: "nath" }),
      rec("bad", 6000, { kind: "error", reason: "pas de première image en 20 s", user: "nath" }),
    ]);
    const s = periodStats(seances);
    expect(s.seances).toBe(3);
    expect(s.clean).toBe(2);
    expect(s.real).toBe(1);
    expect(s.handled.planned).toBe(1);
    expect(s.paths).toEqual({ natif: 2, serveur: 1, tv: 0, horsLigne: 0 });
    expect(s.viewers).toBe(2);
    expect(s.watchedSeconds).toBe(3600);
    expect(s.openMedianMs).toBe(2000);
    expect(s.titles[0]).toMatchObject({ title: "Ted Lasso", episode: true, seances: 3 });
  });
});

describe("ce que le tableau de bord ajoute (07/11/2026)", () => {
  it("sépare les ouvertures depuis l'appareil de celles du réseau, et garde le débit de chacun", () => {
    const seances = buildSeances([
      rec("a1", 1000, { kind: "start", openedInMs: 200, openedFrom: "appareil" }),
      rec("a1", 1500, { kind: "stop", why: "close", watched: 60, "diag.linkMbps": 4, "diag.needMbps": 8 }),
      rec("a2", 2000, { kind: "start", openedInMs: 1200, openedFrom: "réseau" }),
      rec("a2", 2500, { kind: "stop", why: "close", watched: 60, "diag.linkMbps": 6, "diag.needMbps": 8 }),
    ]);
    const s = periodStats(seances);
    expect(s.openDeviceMs).toBe(200);
    expect(s.openNetworkMs).toBe(1200);
    expect(s.people[0]).toMatchObject({ user: "lucas", linkMbps: 6, needMbps: 8 });
  });

  it("retrouve le chemin d'une lecture en cours dans sa séance", () => {
    const [s] = buildSeances([
      rec("t", 1000, { kind: "fallback", reason: "diffusion demandée", cast: true }),
      rec("t", 2000, { kind: "cast", player: "serveur" }),
    ]);
    expect(pathOf(s)).toBe("tv");
    const play = { itemId: "a", title: "x", positionSeconds: 1, runtimeSeconds: 2, paused: false, device: null, client: "Laterna", method: null };
    expect(pathOfPlay([s], play)).toBe("tv");
    expect(pathOfPlay([s], { ...play, itemId: "autre" })).toBeNull();
  });
});

describe("les habitudes (07/11/2026)", () => {
  it("compte ce qui est mené au bout, les séries en cours, et d'où viennent les octets", () => {
    const seances = buildSeances([
      rec("e1", 1000, { kind: "start", title: "Lost — S01E01 · Pilote" }),
      rec("e1", 2000, { kind: "stop", why: "next", watched: 2400, title: "Lost — S01E01 · Pilote", "diag.readReserveMB": 300, "diag.readDeviceMB": 10, "diag.readNetworkMB": 100 }),
      rec("e2", 3000, { kind: "start", title: "Lost — S01E02 · Pilote (2)" }),
      rec("e2", 4000, { kind: "stop", why: "close", ended: true, watched: 2400, title: "Lost — S01E02 · Pilote (2)" }),
      rec("q1", 5000, { kind: "start", title: "Navet" }),
      rec("q1", 6000, { kind: "stop", why: "close", watched: 120, title: "Navet" }),
      rec("q2", 7000, { kind: "start", title: "Navet" }),
      rec("q2", 8000, { kind: "stop", why: "close", watched: 60, title: "Navet" }),
    ]);
    const s = periodStats(seances);
    expect(s.completion).toMatchObject({ finished: 2, closed: 4 });
    expect(s.completion.abandoned).toEqual([expect.objectContaining({ title: "Navet", count: 2 })]);
    expect(s.series).toEqual([expect.objectContaining({ user: "lucas", series: "Lost", last: "S01E02", episodes: 2 })]);
    expect(s.reads).toEqual({ reserveMB: 300, deviceMB: 10, networkMB: 100, withReserve: 1 });
  });
});

describe("le taux depuis une version (07/11/2026)", () => {
  it("prend la plus récente version qui a au moins dix séances", async () => {
    const { sinceVersionOf } = await import("@/lib/activity/dashboard");
    const make = (n: number, version: string, bad = 0) =>
      buildSeances(
        Array.from({ length: n }, (_, i) => [
          rec(`${version}-${i}`, 1000 + i, { kind: "start", version }),
          ...(i < bad ? [rec(`${version}-${i}`, 2000 + i, { kind: "error", reason: "x", version })] : []),
        ]).flat()
      );
    const seances = [...make(12, "10.16.0", 1), ...make(4, "10.17.0")];
    const releases = [{ version: "10.16.0" }, { version: "10.17.0" }];
    // 10.17 seule n'a que 4 séances : on remonte à 10.16, qui compte avec ses suivantes.
    expect(sinceVersionOf(seances, releases)).toEqual({ version: "10.16.0", seances: 16, clean: 15 });
    expect(sinceVersionOf(make(3, "10.18.0"), [{ version: "10.18.0" }])).toBeNull();
  });
});
