import { describe, it, expect } from "vitest";
import { buildSeances } from "@/lib/activity/seances";
import { diagnoseTitles, failuresOf } from "@/lib/activity/diagnosis";
import { friseModel } from "@/lib/activity/frise";
import { problemsOf } from "@/lib/activity/accounts";
import type { LogRecord } from "@/lib/activity/logReader";

// « Connexion trop lente » (DECISIONS.md §77) au panneau Activité : une séance arrêtée par le lien
// du spectateur ne doit pas accuser le fichier dans le diagnostic « fichier ou appareil » — elle est
// comptée à part, et sa raison se lit telle quelle.

const EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";

let n = 0;
function lines(user: string, agent: string, extra: Partial<LogRecord>[]): LogRecord[] {
  const session = `s${++n}`;
  const t = 1_790_000_000_000 + n * 60_000;
  const base = { user, itemId: "rookie", title: "The Rookie — S08E18", agent, session, _file: "player.log", _line: n };
  return [{ ...base, kind: "start", at: 0, _t: t }, ...extra.map((e, i) => ({ ...base, _t: t + 35_000 + i, ...e }))] as LogRecord[];
}

const slowError = { kind: "error", reason: "connexion trop lente", path: "non décidé", recvMbps: 0.32, needMbps: 3.9, measuredS: 34, bytes: 1_400_000 };
const slowFallback = { ...slowError, kind: "fallback", serverCanCarry: true };

describe("une connexion trop lente, au panneau Activité", () => {
  it("comptée à part, jamais comme un échec du fichier", () => {
    const [s] = buildSeances(lines("augustine", EDGE, [slowError]));
    expect(s.slowLinks).toBe(1);
    expect(s.errors).toBe(0);
    expect(s.fallbacks).toBe(0);
    expect(failuresOf(s)).toBe(0);
    // Un problème vécu par le spectateur, tout de même.
    expect(problemsOf(s)).toBe(1);
    expect(s.incidents).toEqual([expect.objectContaining({ kind: "slowLink", reason: "connexion trop lente" })]);
    const [r] = buildSeances(lines("augustine", EDGE, [slowFallback]));
    expect(r.slowLinks).toBe(1);
    expect(r.fallbacks).toBe(0);
  });

  it("« Version allégée » demandée depuis le message de l'ouverture : rangée de même, raison lisible", () => {
    const reason = "connexion trop lente (version allégée demandée)";
    const [s] = buildSeances(lines("augustine", EDGE, [{ ...slowFallback, reason, slowChoice: "allégée", slowNoticeAt: 10_400 }]));
    expect(s.slowLinks).toBe(1);
    expect(s.fallbacks).toBe(0);
    expect(failuresOf(s)).toBe(0);
    expect(s.incidents).toEqual([expect.objectContaining({ kind: "slowLink", reason })]);
  });

  it("n'accuse pas le titre : chez un seul et lente, le titre ne figure pas au diagnostic", () => {
    const records = [...lines("augustine", EDGE, [slowError]), ...lines("louis", IPHONE, [])];
    expect(diagnoseTitles(buildSeances(records)).find((d) => d.itemId === "rookie")).toBeUndefined();
  });

  it("l'ancien motif reste un échec, comme avant", () => {
    const [s] = buildSeances(lines("augustine", EDGE, [{ kind: "fallback", reason: "aucune image après 35 s", path: "non décidé" }]));
    expect(s.fallbacks).toBe(1);
    expect(s.slowLinks).toBe(0);
    expect(failuresOf(s)).toBe(1);
  });

  it("la frise montre la raison telle quelle", () => {
    const records = lines("augustine", EDGE, [slowError]);
    const model = friseModel(records.map((r) => ({ ...r, timestamp: new Date(r._t).toISOString() })), records[0]._t);
    expect(model.marks.some((m) => m.label === "connexion trop lente")).toBe(true);
  });
});
