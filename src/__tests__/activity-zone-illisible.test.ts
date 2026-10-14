import { describe, it, expect } from "vitest";
import { buildSeances } from "@/lib/activity/seances";
import { diagnoseTitles, failuresOf } from "@/lib/activity/diagnosis";
import type { LogRecord } from "@/lib/activity/logReader";

// Une zone illisible dans le fichier (DECISIONS.md §93), au panneau Activité : la preuve contre le
// fichier, dès une seule séance — le diagnostic « fichier ou appareil » n'a rien à croiser.

const EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";

let n = 0;
function lines(user: string, agent: string, extra: Partial<LogRecord>[], itemId = "grinch"): LogRecord[] {
  const session = `z${++n}`;
  const t = 1_790_000_000_000 + n * 60_000;
  const base = { user, itemId, title: "Le Grinch", agent, session, _file: "player.log", _line: n };
  return [{ ...base, kind: "start", at: 0, _t: t }, ...extra.map((e, i) => ({ ...base, _t: t + 35_000 + i, ...e }))] as LogRecord[];
}

const REASON = "zone illisible dans le fichier vers 234,9 s (octet 169510505)";
const zoneFallback = { kind: "fallback", reason: REASON, path: "remux", zoneByte: 169510505, zoneSeconds: 234.9, resumeAt: 228.5, watched: 228 };

describe("une zone illisible, au panneau Activité", () => {
  it("un repli qui compte comme un échec, et une preuve contre le fichier", () => {
    const [s] = buildSeances(lines("mathis", EDGE, [zoneFallback]));
    expect(s.fallbacks).toBe(1);
    expect(s.fileDefects).toBe(1);
    expect(failuresOf(s)).toBe(1);
    expect(s.incidents).toEqual([expect.objectContaining({ kind: "fallback", reason: REASON })]);
    // Sans lecteur serveur : une erreur, la même preuve.
    const [e] = buildSeances(lines("mathis", EDGE, [{ ...zoneFallback, kind: "error" }]));
    expect(e.errors).toBe(1);
    expect(e.fileDefects).toBe(1);
  });

  it("le fichier, dès une seule séance — même quand d'autres l'ont regardé sans souci", () => {
    const records = [...lines("mathis", EDGE, [zoneFallback]), ...lines("louis", IPHONE, []), ...lines("kab", EDGE, [], "grinch")];
    const d = diagnoseTitles(buildSeances(records)).find((x) => x.itemId === "grinch");
    expect(d?.verdict).toEqual({ kind: "file", proven: true });
    // Les motifs se regroupent sans les nombres qui changent.
    expect(d?.reasons[0].reason).toBe("fallback: zone illisible dans le fichier vers #,# s (octet #)");
  });

  it("un autre repli garde le croisement d'avant", () => {
    const records = [...lines("mathis", EDGE, [{ kind: "fallback", reason: "aucune image après 35 s", path: "remux" }]), ...lines("louis", IPHONE, [])];
    const d = diagnoseTitles(buildSeances(records)).find((x) => x.itemId === "grinch");
    expect(d?.verdict.kind).toBe("device");
  });
});
