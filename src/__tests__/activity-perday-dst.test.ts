import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Les barres « séances par jour » de l'activité se découpent en jours locaux. La suite tourne en
// UTC, où aucun jour ne dure 23 ou 25 h : le fuseau est donc fixé ici, avant tout import (Node
// relit `process.env.TZ` à chaque changement). Symptôme d'origine : une séance le 25/10/2026 à
// 23 h 30 à Paris (jour de 25 h) comptait dans le total de la semaine, et dans aucune barre.
const { DIR, previousTz } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const previousTz = process.env.TZ;
  process.env.TZ = "Europe/Paris";
  const DIR = mkdtempSync(`${tmpdir()}/cine-perday-dst-`);
  process.env.DATA_DIR = DIR;
  return { DIR, previousTz };
});
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: {} }));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: {} }));

afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
  fs.rmSync(DIR, { recursive: true, force: true });
});

function writePlayerLog(timestamps: string[]) {
  fs.mkdirSync(path.join(DIR, "logs"), { recursive: true });
  const lines = timestamps.map((timestamp, i) =>
    JSON.stringify({ timestamp, kind: "start", session: `s${i}`, user: "viewer", itemId: "a", title: "X", agent: "Mozilla/5.0 (iPhone)" }),
  );
  fs.writeFileSync(path.join(DIR, "logs", "player.log"), lines.join("\n") + "\n");
}

describe("weekSignals.perDay aux changements d'heure", () => {
  it("le fuseau du test est bien celui de Paris", () => {
    // 25/10/2026 : passage à l'heure d'hiver, le jour local dure 25 h.
    expect(new Date(2026, 9, 26).getTime() - new Date(2026, 9, 25).getTime()).toBe(25 * 3600_000);
  });

  it("une séance à 23 h 30 un jour de 25 h compte dans la barre de ce jour", async () => {
    // 23:30 heure de Paris le 25/10/2026 (CET, UTC+1) = 22:30Z
    writePlayerLog(["2026-10-25T22:30:00.000Z"]);
    const { weekSignals } = await import("@/lib/activity/accounts");
    const w = weekSignals(Date.parse("2026-10-27T11:00:00Z"));
    expect(w.seances).toBe(1);
    expect(w.perDay.reduce((n, d) => n + d.seances, 0)).toBe(1);
    expect(w.perDay.find((d) => d.seances === 1)?.day).toBe("2026-10-25");
  });

  it("un jour de 23 h ne déborde pas sur le lendemain, et les sept jours se suivent", async () => {
    // 29/03/2026 : passage à l'heure d'été. 00:30 le 30/03 à Paris (CEST, UTC+2) = 22:30Z le 29.
    writePlayerLog(["2026-03-29T22:30:00.000Z"]);
    const { weekSignals } = await import("@/lib/activity/accounts");
    const w = weekSignals(Date.parse("2026-04-02T10:00:00Z"));
    expect(w.perDay.map((d) => d.day)).toEqual([
      "2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31", "2026-04-01", "2026-04-02",
    ]);
    expect(w.perDay.find((d) => d.day === "2026-03-29")?.seances).toBe(0);
    expect(w.perDay.find((d) => d.day === "2026-03-30")?.seances).toBe(1);
  });
});
