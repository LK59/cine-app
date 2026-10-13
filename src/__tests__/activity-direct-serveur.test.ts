import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * La vue d'ensemble de l'Activité, côté serveur, après l'accélération du 13/10/2026.
 *
 * Mesuré ce jour-là : la route attendait à chaque appel `/Devices` de Jellyfin, 780 à 990 ms, pour
 * dater le dernier passage des comptes. Les appareils sont désormais gardés une minute
 * (`cachedJellyfinDevices`) ; tout ce qui vit — les lectures en cours (`/Sessions`), les séances
 * du journal du lecteur — est relu à chaque appel. Ces tests tiennent les deux moitiés.
 */
const { DIR } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const DIR = mkdtempSync(`${tmpdir()}/cine-activite-direct-`);
  process.env.DATA_DIR = DIR;
  return { DIR };
});

const jf = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  devicesCalls: 0,
}));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getUsers: async () => [{ Id: "lucas-id", Name: "Lucas", Policy: {} }],
    getSessions: async () => jf.sessions,
    getDevices: async () => {
      jf.devicesCalls += 1;
      return [{ Id: "d1", LastUserId: "lucas-id", DateLastActivity: new Date().toISOString() }];
    },
  },
}));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: {} }));
vi.mock("@/lib/activity/adminOnly", () => ({ adminOnly: async () => ({ role: "admin" }) }));

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

const LOG = path.join(DIR, "logs", "player.log");
const line = (fields: Record<string, unknown>) =>
  JSON.stringify({ user: "Lucas", session: "s1", itemId: "ted", title: "Ted Lasso — S01E01 · Pilot", ...fields }) + "\n";

async function overview() {
  const { GET } = await import("@/app/api/admin/activity/route");
  const res = await GET(new Request("http://localhost/api/admin/activity") as never);
  return (await res.json()) as {
    accounts: { name: string; nowPlaying: { title: string } | null }[];
    recent: { id: string; title: string; stop: { why: string | null } | null }[];
  };
}

describe("Activité — la vue d'ensemble reste en direct", () => {
  it("une séance qui démarre puis s'arrête se voit à l'appel suivant ; les appareils ne sont demandés qu'une fois", async () => {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.writeFileSync(LOG, "");
    const t0 = Date.now();

    const first = await overview();
    expect(first.accounts[0].nowPlaying).toBeNull();
    expect(first.recent).toHaveLength(0);
    expect(jf.devicesCalls).toBe(1);

    // Démarre : Jellyfin la voit, le lecteur écrit son `start` — le fichier grandit, la lecture
    // reprend où elle s'était arrêtée (`logReader`).
    jf.sessions = [{ UserId: "lucas-id", NowPlayingItem: { Id: "ted", Name: "Pilot", SeriesName: "Ted Lasso", IndexNumber: 1, ParentIndexNumber: 1 } }];
    fs.appendFileSync(LOG, line({ timestamp: new Date(t0).toISOString(), kind: "start", openedMs: 900 }));
    const playing = await overview();
    expect(playing.accounts[0].nowPlaying?.title).toContain("Ted Lasso");
    expect(playing.recent).toHaveLength(1);
    expect(playing.recent[0].stop).toBeNull();

    // S'arrête.
    jf.sessions = [];
    fs.appendFileSync(LOG, line({ timestamp: new Date(t0 + 1000).toISOString(), kind: "stop", why: "close", watched: 40 }));
    const stopped = await overview();
    expect(stopped.accounts[0].nowPlaying).toBeNull();
    expect(stopped.recent[0].stop?.why).toBe("close");

    // Trois appels, une seule liste d'appareils : la minute de `cachedJellyfinDevices`.
    expect(jf.devicesCalls).toBe(1);
  });
});

describe("withBackgroundRefresh", () => {
  it("attend la première fois, rend la valeur expirée tout de suite ensuite, et attend de nouveau après un long silence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { withBackgroundRefresh } = await import("@/lib/server-cache");
      let n = 0;
      let release: (() => void) | null = null;
      const slow = () =>
        new Promise<number>((resolve) => {
          n += 1;
          const value = n;
          release = () => resolve(value);
        });
      const call = () => withBackgroundRefresh("test:bg", 60_000, 600_000, slow);

      const firstCall = call();
      release!();
      expect(await firstCall).toBe(1);

      // Dans la minute : la valeur gardée, sans appel.
      vi.setSystemTime(Date.now() + 30_000);
      expect(await call()).toBe(1);
      expect(n).toBe(1);

      // Expirée mais récente : rendue aussitôt, la relecture part derrière.
      vi.setSystemTime(Date.now() + 60_000);
      expect(await call()).toBe(1);
      expect(n).toBe(2);
      release!();
      await Promise.resolve();
      await Promise.resolve();
      expect(await call()).toBe(2);

      // Plus de dix minutes sans lecture : on attend la source plutôt que de rendre un état ancien.
      vi.setSystemTime(Date.now() + 11 * 60_000);
      let settled = false;
      const late = call().then((v) => {
        settled = true;
        return v;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      release!();
      expect(await late).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
