import { describe, it, expect } from "vitest";
import { buildSeances, isPlannedHandoff } from "@/lib/activity/seances";
import { failuresOf } from "@/lib/activity/diagnosis";
import { periodStats } from "@/lib/activity/dashboard";
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
