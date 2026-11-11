import { describe, it, expect, beforeEach } from "vitest";
import { endXrayUsage, forgetXrayUsage, noteXrayOffered, noteXrayScene, noteXrayTap, xrayLogFields, XRAY_USAGE_VALUE } from "@/lib/xrayUsage";
import { aiUsageStats } from "@/lib/activity/aiUsage";
import type { LogRecord } from "@/lib/activity/logReader";

/**
 * L'usage des acteurs à l'écran (11/11/2026) : trois compteurs sur le bilan `stop`, rien sans l'option, et une
 * tuile d'Activité qui relit ce bilan et `recherche.log` sans rien écrire de plus.
 */
const ITEM = "a".repeat(32);

beforeEach(() => forgetXrayUsage());

describe("les compteurs d'une séance", () => {
  it("rien sur le bilan tant que l'option n'est pas proposée — les empreintes du lecteur n'en voient rien", () => {
    noteXrayScene(ITEM, 10);
    noteXrayTap(ITEM, 1);
    expect(xrayLogFields(ITEM)).toEqual({});
  });

  it("scènes distinctes, touchers, personnes distinctes ; une reconstruction garde la séance", () => {
    noteXrayOffered(ITEM);
    noteXrayScene(ITEM, 10);
    noteXrayScene(ITEM, 10);
    noteXrayScene(ITEM, 95.5);
    noteXrayTap(ITEM, 1);
    noteXrayTap(ITEM, 1);
    noteXrayTap(ITEM, 2);
    // Les commandes remontées (reconstruction, passage au lecteur serveur) : la même séance continue.
    noteXrayOffered(ITEM);
    noteXrayTap(ITEM, 3);
    const fields = xrayLogFields(ITEM);
    expect(fields).toEqual({ xray: "s2 t4 p3" });
    expect(XRAY_USAGE_VALUE.test(fields.xray!)).toBe(true);
  });

  it("proposée sans rien toucher : le bilan dit zéro, pour compter les séances où elle était là", () => {
    noteXrayOffered(ITEM);
    expect(xrayLogFields(ITEM)).toEqual({ xray: "s0 t0 p0" });
  });

  it("le bilan parti, la prochaine ouverture repart de zéro", () => {
    noteXrayOffered(ITEM);
    noteXrayTap(ITEM, 1);
    endXrayUsage(ITEM);
    noteXrayTap(ITEM, 2);
    noteXrayOffered(ITEM);
    expect(xrayLogFields(ITEM)).toEqual({ xray: "s0 t0 p0" });
  });
});

describe("la tuile d'Activité", () => {
  const rec = (t: number, fields: Record<string, unknown>): LogRecord => ({ _file: "x", _line: 0, _t: t, ...fields });

  it("une séance compte une fois (bilan renvoyé), et seules les lignes de la semaine comptent", () => {
    const player = [
      rec(5, { kind: "stop", user: "Emma", session: "s1", xray: "s3 t1 p1" }),
      rec(6, { kind: "stop", user: "emma", session: "s1", xray: "s3 t2 p1", why: "lost" }),
      rec(7, { kind: "stop", user: "nath", session: "s2", xray: "s4 t0 p0" }),
      rec(8, { kind: "stop", user: "kab", session: "s3" }),
      rec(1, { kind: "stop", user: "vieux", session: "s0", xray: "s1 t9 p1" }),
      rec(9, { kind: "stop", user: "kab", session: "s4", xray: "pas la bonne forme" }),
    ];
    const search = [
      rec(5, { kind: "question", user: "emma", status: "ok" }),
      rec(5, { kind: "question", user: "emma", status: "abandon" }),
      rec(6, { kind: "question", user: "nath", status: "erreur" }),
      rec(6, { kind: "jusquici", user: "emma", status: "ok" }),
      rec(7, { kind: "jusquici", user: "kab", status: "vide" }),
      rec(7, { kind: "description", user: "kab", status: "ok" }),
    ];
    expect(aiUsageStats(player, search, 2)).toEqual({
      xraySeances: 2,
      xrayTapSeances: 1,
      xrayTaps: 2,
      xrayAccounts: 1,
      questions: 2,
      questionAccounts: 2,
      sofar: 2,
      sofarEmpty: 1,
      sofarAccounts: 2,
      failures: 1,
    });
  });
});
