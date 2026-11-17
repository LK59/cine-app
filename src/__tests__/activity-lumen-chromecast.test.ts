import { describe, it, expect } from "vitest";
import { buildSeances } from "@/lib/activity/seances";
import type { LogRecord } from "@/lib/activity/logReader";

// Un Chromecast qui ne lit pas Lumen serveur (DECISIONS.md §192) : sa ligne `fallback` porte `cast: true` — c'est une
// diffusion —, mais elle compte comme un repli raté, pas comme une diffusion de plus. La fin d'une diffusion, elle,
// reste une diffusion.

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

function lines(extra: Partial<LogRecord>[]): LogRecord[] {
  const t = 1_790_000_000_000;
  const base = { user: "louis", itemId: "film", title: "Le Film", agent: CHROME, session: "c1", target: "chromecast", cast: true, _file: "player.log", _line: 1 };
  return [{ ...base, kind: "start", at: 0, player: "lumen-serveur", path: "remux-serveur", _t: t }, ...extra.map((e, i) => ({ ...base, _t: t + 1000 + i, ...e }))] as LogRecord[];
}

describe("le repli d'un Chromecast hors de Lumen serveur, au panneau Activité", () => {
  it("compte comme un repli ; la fin de la diffusion reste une diffusion", () => {
    const [s] = buildSeances(
      lines([
        { kind: "fallback", player: "lumen-serveur", path: "remux-serveur", to: "jellyfin", reason: "chromecast : remux serveur — chargement refusé", code: "load_media_failed" },
        { kind: "fallback", player: "serveur", path: "serveur", reason: "fin de diffusion (téléviseur)" },
      ])
    );
    expect(s.fallbacks).toBe(1);
    expect(s.casts).toBe(1);
  });
});
