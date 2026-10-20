import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// L'Activité sur trente jours et depuis le début (20/10/2026) : les jours clos sont comptés une fois
// et gardés en base, les trois derniers relus dans les journaux — et un jour sorti des archives
// reste compté.
const { DIR } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const DIR = mkdtempSync(`${tmpdir()}/cine-activity-history-`);
  process.env.DATA_DIR = DIR;
  return { DIR };
});
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: {} }));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: {} }));

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

const DAY = 24 * 3600_000;
/** Midi local, `daysAgo` jours avant le « maintenant » du test. */
const NOW = new Date(2026, 9, 20, 15, 0).getTime();
const at = (daysAgo: number, hour = 12) => {
  const d = new Date(NOW);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, hour).getTime();
};

/** Une séance : un `start` et un `stop` avec le temps regardé, et un blocage si `stall`. */
function seance(id: string, user: string, t: number, watched: number, stall = false) {
  const base = { session: id, user, itemId: "a", title: "X", agent: "Mozilla/5.0 (iPhone)" };
  return [
    { timestamp: new Date(t).toISOString(), kind: "start", ...base },
    ...(stall ? [{ timestamp: new Date(t + 60_000).toISOString(), kind: "stall", ...base }] : []),
    { timestamp: new Date(t + 120_000).toISOString(), kind: "stop", why: "close", watched, ...base },
  ];
}

/** Les journaux réécrits : le lecteur des journaux, qui garde chaque fichier en mémoire et n'en relit que la suite, est remis à zéro. */
async function writeLogs(player: object[], server: object[] = []) {
  (await import("@/lib/activity/logReader")).__testing.reset();
  fs.mkdirSync(path.join(DIR, "logs"), { recursive: true });
  const lines = (rows: object[]) => (rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");
  fs.writeFileSync(path.join(DIR, "logs", "player.log"), lines(player));
  fs.writeFileSync(path.join(DIR, "logs", "server.log"), lines(server));
}

beforeEach(async () => {
  const { getDb } = await import("@/lib/db");
  getDb().prepare("DELETE FROM activity_day_tallies").run();
});

describe("depuis le début", () => {
  it("additionne les jours gardés et les derniers jours relus, depuis la première séance", async () => {
    await writeLogs(
      [...seance("old", "anna", at(40), 3600, true), ...seance("mid", "ben", at(10), 1800), ...seance("new", "anna", at(0), 600)],
      [{ timestamp: new Date(at(10)).toISOString(), level: "error", scope: "api", message: "x" }],
    );
    const { allTimeSignals } = await import("@/lib/activity/activityHistory");
    const all = allTimeSignals(NOW);
    expect(all).toMatchObject({ seances: 3, viewers: 2, watchedSeconds: 6000, stalls: 1, bucket: "week" });
    expect(all.serverErrors).toEqual([{ scope: "api", count: 1 }]);
    expect(all.since).toBe(at(40, 0));
    expect(all.perDay.reduce((n, b) => n + b.seances, 0)).toBe(3);
    // Les barres sont des semaines, du lundi.
    for (const b of all.perDay) expect(new Date(b.day + "T12:00:00").getDay()).toBe(1);

    // Les jours clos sont en base ; aujourd'hui et les trois jours d'avant n'y sont pas.
    const { getDb } = await import("@/lib/db");
    const days = getDb().prepare("SELECT day FROM activity_day_tallies ORDER BY day").all() as { day: string }[];
    const { localDay } = await import("@/lib/activity/accounts");
    expect(days[0].day).toBe(localDay(new Date(at(40))));
    expect(days.at(-1)?.day).toBe(localDay(new Date(at(4))));
  });

  it("un jour sorti des archives reste compté", async () => {
    await writeLogs([...seance("old", "anna", at(40), 3600), ...seance("new", "anna", at(0), 600)]);
    const { allTimeSignals } = await import("@/lib/activity/activityHistory");
    allTimeSignals(NOW);
    // Rotation : l'ancienne séance n'est plus dans aucun journal.
    await writeLogs(seance("new", "anna", at(0), 600));
    expect(allTimeSignals(NOW)).toMatchObject({ seances: 2, watchedSeconds: 4200 });
  });

  it("les jours venus depuis s'ajoutent sans recompter les anciens", async () => {
    await writeLogs(seance("old", "anna", at(40), 3600));
    const { allTimeSignals } = await import("@/lib/activity/activityHistory");
    allTimeSignals(NOW);
    // Cinq jours plus tard, une nouvelle séance ; l'ancienne a quitté les journaux.
    await writeLogs(seance("later", "ben", NOW + DAY, 300));
    expect(allTimeSignals(NOW + 5 * DAY)).toMatchObject({ seances: 2, viewers: 2 });
  });

  it("un compte gardé sous une autre forme est oublié et recompté depuis les journaux", async () => {
    await writeLogs(seance("old", "anna", at(40), 3600));
    const { getDb } = await import("@/lib/db");
    const { localDay } = await import("@/lib/activity/accounts");
    getDb()
      .prepare("INSERT INTO activity_day_tallies (day, version, tally, computed_at) VALUES (?, 0, ?, 0)")
      .run(localDay(new Date(at(60))), JSON.stringify({ seances: 99, viewers: ["zoé"] }));
    const { allTimeSignals } = await import("@/lib/activity/activityHistory");
    expect(allTimeSignals(NOW)).toMatchObject({ seances: 1, viewers: 1 });
  });
});

describe("trente jours", () => {
  it("trente barres de jours, et les incidents effacés s'y comptent encore", async () => {
    await writeLogs([...seance("a", "anna", at(20), 100, true), ...seance("b", "anna", at(2), 100, true)]);
    const { monthSignals, weekSignals } = await import("@/lib/activity/accounts");
    const month = monthSignals(NOW);
    expect(month.perDay).toHaveLength(30);
    expect(month).toMatchObject({ seances: 2, stalls: 2 });
    // La semaine, elle, suit « Effacer les alertes ».
    expect(weekSignals(NOW, NOW - 1000)).toMatchObject({ seances: 1, stalls: 0 });
  });
});
