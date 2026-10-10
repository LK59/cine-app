import { describe, it, expect } from "vitest";
import {
  serverStartFields,
  serverStopFields,
  isServerRestart,
  isServerFailureRestart,
  serverStartWhyLabel,
  formatRestarts,
  type ServerPlayerContext,
} from "@/lib/serverPlayerLog";
import { SessionTally } from "@/lib/playerSessionTally";
import { buildSeances } from "@/lib/activity/seances";
import { failuresOf } from "@/lib/activity/diagnosis";
import { friseModel } from "@/lib/activity/frise";
import type { LogRecord } from "@/lib/activity/logReader";

// Le journal du lecteur serveur dit pourquoi il (re)négocie et fait le bilan de sa séance
// (10/10/2026) : les quatre essais de « Ruby » sur une Fire TV et trois départs d'Augustine sur
// Edge se lisaient tous « transcodé par le serveur », sans arrêt ni temps regardé.

const CTX: ServerPlayerContext = { itemId: "item-1", title: "Elle s'appelle Ruby", cast: false, session: "abc12345", agent: "Silk" };
const STREAM = { directPlay: false, nativeHls: false, resumeAt: 0, audioStreamIndex: undefined };

describe("ligne start du lecteur serveur — le pourquoi", () => {
  it("porte le motif, l'échelon et l'erreur qui l'a déclenché", () => {
    const line = serverStartFields(CTX, STREAM, { why: "ladder", rung: 2, trigger: "élément : code 4" });
    expect(line).toMatchObject({ why: "ladder", rung: 2, trigger: "élément : code 4", player: "serveur", session: "abc12345", reason: "transcodé par le serveur" });
  });

  it("sans motif, la ligne reste celle d'avant", () => {
    const line = serverStartFields(CTX, STREAM);
    expect(line).not.toHaveProperty("why");
    expect(line).not.toHaveProperty("rung");
  });

  it("distingue l'ouverture, les gestes et les pannes", () => {
    expect(isServerRestart("open")).toBe(false);
    expect(isServerRestart("handover")).toBe(false);
    expect(isServerRestart("audio")).toBe(true);
    expect(isServerRestart("ladder")).toBe(true);
    expect(isServerRestart("n'importe quoi")).toBe(false);
    expect(isServerFailureRestart("ladder")).toBe(true);
    expect(isServerFailureRestart("retry-reload")).toBe(true);
    expect(isServerFailureRestart("audio")).toBe(false);
    expect(isServerFailureRestart("retry")).toBe(false);
    expect(serverStartWhyLabel("ladder", 3)).toBe("relance après erreur (essai 3)");
    expect(serverStartWhyLabel(undefined)).toBeNull();
  });
});

describe("ligne stop du lecteur serveur — le bilan", () => {
  it("porte le décompte partagé avec le lecteur natif, les relances par motif et la durée", () => {
    const tally = new SessionTally();
    tally.waitStarted(1000);
    tally.waitEnded(1600);
    tally.seekArrived(800);
    tally.audioSwitched();
    const line = serverStopFields(CTX, "close", 1834.6, 1200, {
      duration: 6012.4,
      ended: false,
      tally: tally.summary(2000),
      subtitleSwitches: 2,
      restarts: { ladder: 3, audio: 1 },
      sleepTimer: "episode",
    });
    expect(line).toMatchObject({
      why: "close",
      at: 1835,
      watched: 1200,
      duration: 6012,
      ended: false,
      waits: 1,
      waitedMs: 600,
      longestWaitMs: 600,
      seeks: 1,
      seekWaitMs: 800,
      audioSwitches: 1,
      subtitleSwitches: 2,
      restarts: 4,
      restartWhy: "ladder×3, audio×1",
      sleepTimer: "episode",
    });
  });

  it("une séance fermée avant la première image dit combien de temps on a attendu", () => {
    expect(serverStopFields(CTX, "close", 0, 0, { gaveUpAfterMs: 4213.7 })).toMatchObject({ gaveUpAfterMs: 4214 });
  });

  it("une durée inconnue (NaN, Infinity d'un direct) n'est pas écrite", () => {
    expect(serverStopFields(CTX, "close", 0, 0, { duration: Number.NaN })).not.toHaveProperty("duration");
    expect(serverStopFields(CTX, "close", 0, 0, { duration: Number.POSITIVE_INFINITY })).not.toHaveProperty("duration");
  });

  it("sans relance, pas de libellé vide", () => {
    const line = serverStopFields(CTX, "page", 10, 5, { restarts: {} });
    expect(line).toMatchObject({ why: "page", restarts: 0 });
    expect(line).not.toHaveProperty("restartWhy");
    expect(formatRestarts({ audio: 0 })).toBe("");
  });
});

describe("la page Activité lit le journal du lecteur serveur", () => {
  const t0 = 1_790_000_000_000;
  const base = { user: "timothe", itemId: "ruby", title: "Elle s'appelle Ruby", agent: "Silk", session: "s-ruby", player: "serveur", path: "serveur", _file: "player.log" };
  const ruby: LogRecord[] = [
    { ...base, player: undefined, kind: "fallback", reason: "Le navigateur a refusé une opération sur le tampon.", _t: t0, _line: 1 },
    { ...base, kind: "start", why: "handover", at: 0, _t: t0 + 2000, _line: 2 },
    { ...base, kind: "start", why: "ladder", rung: 1, trigger: "élément : code 4", at: 0, retry: 1, _t: t0 + 8000, _line: 3 },
    { ...base, kind: "start", why: "ladder", rung: 2, trigger: "élément : code 4", at: 0, retry: 2, _t: t0 + 14000, _line: 4 },
    { ...base, kind: "start", why: "audio", at: 300, _t: t0 + 60_000, _line: 5 },
    { ...base, kind: "stop", why: "close", at: 900, watched: 840, seeks: 3, audioSwitches: 1, restarts: 3, _t: t0 + 900_000, _line: 6 },
  ] as unknown as LogRecord[];

  it("une séance, ses relances nommées, la panne distinguée du geste", () => {
    const [s] = buildSeances(ruby);
    expect(buildSeances(ruby)).toHaveLength(1);
    expect(s.player).toBe("serveur");
    expect(s.watched).toBe(840);
    expect(s.restarts.map((r) => [r.why, r.failure])).toEqual([
      ["ladder", true],
      ["ladder", true],
      ["audio", false],
    ]);
    expect(s.restarts[1].label).toBe("relance après erreur (essai 2)");
    // Les sauts et la piste viennent du bilan : le lecteur serveur n'écrit pas de ligne par saut.
    expect(s.seeks).toBe(3);
    expect(s.audioSwitches).toBe(1);
  });

  it("le diagnostic « fichier ou appareil » compte les échelons comme des pannes, pas le changement de piste", () => {
    const [s] = buildSeances(ruby);
    // Le repli du natif (1) + deux échelons de l'échelle (2).
    expect(failuresOf(s)).toBe(3);
  });

  it("un bilan perdu puis le vrai bilan ne comptent les sauts qu'une fois", () => {
    const twice = [
      ...ruby,
      { ...base, kind: "stop", why: "lost", at: 900, watched: 840, seeks: 3, audioSwitches: 1, lateByMs: 1000, _t: t0 + 901_000, _line: 7 },
    ] as unknown as LogRecord[];
    expect(buildSeances(twice)[0].seeks).toBe(3);
  });

  it("une ligne d'avant ce champ (seulement `retry`) compte encore comme un échelon", () => {
    const legacy = [
      { ...base, kind: "start", at: 0, _t: t0, _line: 1 },
      { ...base, kind: "start", at: 0, retry: 1, _t: t0 + 5000, _line: 2 },
    ] as unknown as LogRecord[];
    const [s] = buildSeances(legacy);
    expect(s.restarts).toEqual([expect.objectContaining({ why: "ladder", failure: true })]);
  });

  it("la frise nomme les relances : un échelon en incident, une piste comme telle", () => {
    const lines = ruby.map(({ _t, ...rest }) => ({ ...rest, timestamp: new Date(_t).toISOString() }));
    const model = friseModel(lines as Record<string, unknown>[], t0);
    const restartMarks = model.marks.filter((m) => m.label.includes("relance") || m.label.includes("piste"));
    expect(restartMarks.map((m) => m.kind)).toEqual(["rebuild", "rebuild", "audio"]);
    expect(restartMarks[0].label).toBe("relance après erreur (essai 1) — élément : code 4");
    // Le relais, lui, est une ouverture (marque `start`), pas une relance.
    expect(model.marks.filter((m) => m.kind === "start")).toHaveLength(1);
  });
});
