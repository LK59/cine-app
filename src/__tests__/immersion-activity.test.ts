import { describe, it, expect } from "vitest";
import { buildSeances } from "@/lib/activity/seances";
import { diagnoseTitles } from "@/lib/activity/diagnosis";
import type { LogRecord } from "@/lib/activity/logReader";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";
const PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

let n = 0;
function seance(user: string, itemId: string, agent: string, failed: boolean, extra: Partial<LogRecord> = {}): LogRecord[] {
  const session = `i${++n}`;
  const t = 1_790_000_000_000 + n * 60_000;
  const base = { user, itemId, title: `Titre ${itemId}`, agent, session, _file: "player.log", _line: n, ...extra };
  return [
    { ...base, kind: "start", at: 0, _t: t },
    ...(failed ? [{ ...base, kind: "stall", position: 30, _t: t + 30_000 }] : []),
    { ...base, kind: "stop", why: "close", watched: 600, _t: t + 600_000 },
  ] as LogRecord[];
}

// Le mode Immersion (DECISIONS.md §144) écrit ses lignes marquées `player: "immersion"`.
describe("les séances du mode Immersion dans l'activité", () => {
  it("sont reconnues comme telles, jamais comme celles du lecteur serveur ni du lecteur natif", () => {
    const [s] = buildSeances(seance("a", "x", PC, false, { player: "immersion", sdr: "serveur" }));
    expect(s.player).toBe("immersion");
  });

  // Un flux transcodé pour la télévision du chalet n'est pas le fichier lu par le lecteur : sa réussite
  // ne doit pas innocenter un titre qui échoue ailleurs.
  it("n'innocentent pas un titre qui échoue dans le lecteur", () => {
    const failing = seance("a", "x", IPHONE, true);
    const witness = seance("b", "x", PC, false, { player: "immersion" });
    const verdict = (records: LogRecord[]) => diagnoseTitles(buildSeances(records)).find((d) => d.itemId === "x")?.verdict;
    expect(verdict([...failing, ...witness])).toEqual(verdict(failing));
    // Le même témoin, dans le lecteur : là, il compte.
    expect(verdict([...failing, ...seance("b", "x", PC, false)])).not.toEqual(verdict(failing));
  });

  it("et leurs échecs n'accusent pas le fichier", () => {
    const records = seance("a", "y", PC, true, { player: "immersion" });
    expect(diagnoseTitles(buildSeances(records)).find((d) => d.itemId === "y")).toBeUndefined();
  });
});
