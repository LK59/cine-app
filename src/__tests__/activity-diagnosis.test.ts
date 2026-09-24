import { describe, it, expect } from "vitest";
import { buildSeances } from "@/lib/activity/seances";
import { diagnoseTitles } from "@/lib/activity/diagnosis";
import { friseModel } from "@/lib/activity/frise";
import { localDay } from "@/lib/activity/accounts";
import type { LogRecord } from "@/lib/activity/logReader";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15";

let n = 0;
/** Une séance : une ouverture, et un blocage si elle échoue. */
function seance(user: string, itemId: string, agent: string, failed: boolean, extra: Partial<LogRecord>[] = []): LogRecord[] {
  const session = `s${++n}`;
  const t = 1_790_000_000_000 + n * 60_000;
  const base = { user, itemId, title: `Titre ${itemId}`, agent, session, _file: "player.log", _line: n };
  return [
    { ...base, kind: "start", at: 0, _t: t },
    ...(failed ? [{ ...base, kind: "stall", position: 30, _t: t + 30_000 }] : []),
    ...extra.map((e, i) => ({ ...base, _t: t + 40_000 + i, ...e })),
  ] as LogRecord[];
}

const verdictOf = (records: LogRecord[], itemId: string) => diagnoseTitles(buildSeances(records)).find((d) => d.itemId === itemId)?.verdict;

describe("le fichier ou l'appareil", () => {
  it("échoue chez tous : le fichier", () => {
    expect(verdictOf([...seance("a", "x", IPHONE, true), ...seance("b", "x", MAC, true)], "x")).toEqual({ kind: "file" });
  });

  // Love Story, 23/09/2026 : des écrans noirs sur un seul iPhone, l'épisode passait partout ailleurs.
  it("échoue chez un seul et passe ailleurs : cet appareil — et dit s'il peine partout", () => {
    const records = [...seance("charlotte", "x", IPHONE, true), ...seance("sarah", "x", MAC, false), ...seance("louis", "x", IPHONE, false)];
    expect(verdictOf(records, "x")).toEqual({ kind: "device", user: "charlotte", device: "iPhone · Safari", everywhere: false });
    const struggling = [...records, ...["y", "z", "w"].flatMap((id) => seance("charlotte", id, IPHONE, true))];
    expect(verdictOf(struggling, "x")).toMatchObject({ kind: "device", everywhere: true });
  });

  it("échoue sur un même type d'appareil chez plusieurs, passe ailleurs : ce type d'appareil", () => {
    const records = [...seance("a", "x", IPHONE, true), ...seance("b", "x", IPHONE, true), ...seance("c", "x", MAC, false)];
    expect(verdictOf(records, "x")).toEqual({ kind: "platform", device: "iPhone · Safari" });
  });

  it("un seul témoin : à confirmer ; sans point commun : pas tranché", () => {
    expect(verdictOf(seance("a", "x", IPHONE, true), "x")).toMatchObject({ kind: "alone", user: "a" });
    const mixed = [...seance("a", "x", IPHONE, true), ...seance("b", "x", MAC, true), ...seance("c", "x", MAC, false)];
    expect(verdictOf(mixed, "x")).toEqual({ kind: "mixed" });
  });

  // Un saut lent tient au réseau, un retour d'arrière-plan à iOS : ni l'un ni l'autre n'accuse le fichier.
  it("ne compte ni les sauts lents ni les retours d'arrière-plan", () => {
    const records = seance("a", "x", IPHONE, false, [
      { kind: "seek", from: 0, to: 600, tookMs: 8000 },
      { kind: "rebuild", position: 600, hiddenMs: 120_000, reason: "source fermée en arrière-plan" },
    ]);
    const [s] = buildSeances(records);
    expect(s.rebuilds).toBe(0);
    expect(s.backgroundRebuilds).toBe(1);
    expect(diagnoseTitles([s])).toEqual([]);
  });
});

describe("la frise d'une séance", () => {
  const start = Date.parse("2026-09-24T13:29:36.000Z");
  const at = (s: number) => new Date(start + s * 1000).toISOString();

  it("relie les positions connues, coupe à chaque saut, et marque l'attente et l'arrière-plan", () => {
    const m = friseModel(
      [
        { timestamp: at(0), kind: "start", at: 0 },
        { timestamp: at(10), kind: "seek", from: 10, to: 600, tookMs: 1000 },
        { timestamp: at(100), kind: "rebuild", position: 650, hiddenMs: 30_000 },
        { timestamp: at(120), kind: "stop", at: 670, why: "close" },
      ],
      start,
      3600
    );
    expect(m.top).toBe(3600);
    expect(m.jumps).toEqual([{ t: 9000, from: 10, to: 600, took: 1000 }]);
    expect(m.runs).toHaveLength(2);
    expect(m.runs[0].at(-1)).toEqual({ t: 9000, pos: 10 });
    expect(m.bands).toContainEqual({ from: 9000, to: 10_000, kind: "wait" });
    expect(m.bands).toContainEqual({ from: 70_000, to: 100_000, kind: "background" });
    expect(m.marks.map((k) => k.kind)).toEqual(["start", "background", "stop"]);
  });

  it("sans durée de film, l'axe s'arrête un peu au-dessus de la plus grande position vue", () => {
    const m = friseModel([{ timestamp: at(0), kind: "start", at: 100 }, { timestamp: at(60), kind: "stop", at: 160 }], start);
    expect(m.top).toBeGreaterThan(160);
    expect(m.top).toBeLessThan(200);
  });
});

describe("relus le 24/09/2026 au soir", () => {
  it("une diffusion vers la télévision n'est pas un échec", () => {
    const records = [
      ...seance("a", "x", IPHONE, false, [{ kind: "fallback", reason: "diffusion demandée" }]),
      ...seance("b", "x", MAC, false, [{ kind: "fallback", reason: "autre raison", cast: true }]),
    ];
    const seances = buildSeances(records);
    expect(seances.map((s) => [s.fallbacks, s.casts])).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(diagnoseTitles(seances)).toEqual([]);
  });

  it("une relance du lecteur serveur n'ouvre pas une nouvelle séance", () => {
    const base = { user: "a", itemId: "x", title: "Titre", player: "serveur", _file: "player.log" };
    const lines = [
      { ...base, kind: "start", at: 0, _t: 1_000, _line: 1 },
      { ...base, kind: "start", at: 0, retry: 1, _t: 7_000, _line: 2 },
      { ...base, kind: "start", at: 0, retry: 2, _t: 13_000, _line: 3 },
    ] as LogRecord[];
    expect(buildSeances(lines)).toHaveLength(1);
  });

  it("un témoin sans appareil connu n'innocente pas un titre", () => {
    const serverWithoutAgent = [{ user: "c", itemId: "x", title: "Titre x", player: "serveur", session: "srv", kind: "start", at: 0, _t: 1_790_000_900_000, _file: "player.log", _line: 900 }] as LogRecord[];
    const records = [...seance("a", "x", IPHONE, true), ...seance("b", "x", MAC, true), ...serverWithoutAgent];
    expect(verdictOf(records, "x")).toEqual({ kind: "file" });
  });

  it("le lien d'un témoin mène à son échec le plus récent", () => {
    const records = [...seance("a", "x", IPHONE, true), ...seance("a", "x", IPHONE, true), ...seance("b", "x", MAC, false)];
    const seances = buildSeances(records);
    const [d] = diagnoseTitles(seances);
    const newest = seances.filter((s) => s.user === "a").sort((p, q) => q.start - p.start)[0];
    expect(d.viewers[0].failedSeances[0]).toBe(newest.id);
  });

  it("un bilan perdu est placé à l'instant qu'il décrit, pas à son arrivée", () => {
    const start = Date.parse("2026-09-24T14:35:20Z");
    const lines = [
      { timestamp: "2026-09-24T14:35:20Z", kind: "start", at: 1874 },
      { timestamp: "2026-09-24T15:32:39Z", kind: "stop", at: 2448, why: "lost", lateByMs: 2_833_000 },
    ];
    const m = friseModel(lines, start, 3436);
    // Environ dix minutes de séance, pas une heure.
    expect(m.duration).toBeLessThan(11 * 60_000);
    const records = lines.map((l, i) => ({ ...l, user: "c", itemId: "love", session: "s1", _t: Date.parse(l.timestamp), _file: "player.log", _line: i })) as LogRecord[];
    const [s] = buildSeances(records);
    expect(s.end - s.start).toBeLessThan(11 * 60_000);
  });

  it("date un jour dans l'heure du foyer, pas en UTC", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Europe/Paris";
    try {
      const justAfterMidnight = new Date(2026, 8, 24, 0, 30);
      // Le défaut : la date UTC de minuit et demie à Paris est la veille.
      expect(justAfterMidnight.toISOString().slice(0, 10)).toBe("2026-09-23");
      expect(localDay(justAfterMidnight)).toBe("2026-09-24");
    } finally {
      process.env.TZ = tz;
    }
  });
});
