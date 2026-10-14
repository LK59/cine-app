import { describe, it, expect, beforeEach, vi } from "vitest";
import { diskOf, planQueues, type DiskProbe } from "@/lib/repliques/disks";

/**
 * Le parallélisme de l'indexation (DECISIONS.md §88) : une file par disque **prouvé** distinct, sinon
 * une seule. Et la pause pendant une lecture (`playbackActivity`).
 */

describe("planQueues", () => {
  it("lit en série sans preuve, même si un seul fichier en manque", () => {
    expect(planQueues(["a", "b"], [null, null])).toEqual({ queues: [["a", "b"]], reason: "unproven" });
    expect(planQueues(["a", "b", "c"], [["sda"], ["sdb"], null])).toEqual({ queues: [["a", "b", "c"]], reason: "unproven" });
  });
  it("une file par disque prouvé distinct", () => {
    expect(planQueues(["a", "b", "c"], [["sda"], ["sdb"], ["sda"]])).toEqual({ queues: [["a", "c"], ["b"]], reason: "proven" });
    expect(planQueues(["a", "b"], [["sda"], ["sda"]])).toEqual({ queues: [["a", "b"]], reason: "single-disk" });
  });
  it("refuse deux groupes qui partagent un disque (un RAID et l'un de ses disques)", () => {
    expect(planQueues(["a", "b"], [["sda", "sdb"], ["sdb"]])).toEqual({ queues: [["a", "b"]], reason: "unproven" });
  });
});

function probe(over: Partial<DiskProbe>): DiskProbe {
  return {
    fsType: async () => "ext4",
    xattr: async () => null,
    device: async () => "8:2",
    physicalDisks: async (dev) => (dev === "8:2" ? ["sda"] : dev === "8:32" ? ["sdc"] : null),
    ...over,
  };
}

describe("diskOf", () => {
  it("remonte un système de fichiers ordinaire jusqu'à son disque", async () => {
    expect(await diskOf("/films/a.mkv", probe({}))).toEqual(["sda"]);
  });
  it("mergerfs sans attribut lisible : aucune preuve (la situation de la production au 14/10/2026)", async () => {
    expect(await diskOf("/mnt/media/video/a.mkv", probe({ fsType: async () => "fuse.mergerfs" }))).toBeNull();
  });
  it("mergerfs avec la branche lisible et visible : le disque de la branche", async () => {
    const device = vi.fn(async (p: string) => (p === "/mnt/disk16to/video_data" ? "8:32" : "0:49"));
    const result = await diskOf("/mnt/media/video/a.mkv", probe({ fsType: async () => "fuse.mergerfs", xattr: async () => "/mnt/disk16to/video_data", device }));
    expect(result).toEqual(["sdc"]);
    expect(device).toHaveBeenCalledWith("/mnt/disk16to/video_data");
  });
  it("un autre FUSE, ou un périphérique virtuel : aucune preuve", async () => {
    expect(await diskOf("/x", probe({ fsType: async () => "fuse.sshfs" }))).toBeNull();
    expect(await diskOf("/x", probe({ device: async () => "0:49" }))).toBeNull();
  });
});

const sessions = vi.hoisted(() => ({ list: [] as unknown[], fail: false }));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getSessions: async () => {
      if (sessions.fail) throw new Error("injoignable");
      return sessions.list;
    },
  },
}));

import { mustWaitForPlayback, noteMediaRead, RESUME_AFTER_MS, __testing } from "@/lib/repliques/playbackActivity";
import { recordPlaybackBeat, __testing as presenceTesting } from "@/lib/activity/presence";

describe("la pause pendant une lecture", () => {
  beforeEach(() => {
    __testing.reset();
    presenceTesting.reset();
    sessions.list = [];
    sessions.fail = false;
  });

  it("attend pendant qu'une séance Jellyfin lit quelque chose, puis encore quelques minutes", async () => {
    const now = Date.now();
    sessions.list = [{ NowPlayingItem: { Name: "Film" }, LastPlaybackCheckIn: new Date(now - 10_000).toISOString() }];
    expect((await mustWaitForPlayback(now)).signal.by).toBe("jellyfin");
    sessions.list = [];
    // La lecture vient de finir : on attend encore.
    expect((await mustWaitForPlayback(now + 30_000)).wait).toBe(true);
    expect((await mustWaitForPlayback(now + RESUME_AFTER_MS + 60_000)).wait).toBe(false);
  });

  it("ignore une séance qui ne rapporte plus rien depuis longtemps", async () => {
    const now = Date.now();
    sessions.list = [{ NowPlayingItem: { Name: "Film" }, LastPlaybackCheckIn: new Date(now - 3_600_000).toISOString() }];
    expect((await mustWaitForPlayback(now)).wait).toBe(false);
  });

  it("entend le relais de flux et le battement de lecture, même Jellyfin injoignable", async () => {
    sessions.fail = true;
    const now = Date.now();
    noteMediaRead(now);
    expect((await mustWaitForPlayback(now)).signal.by).toBe("stream");
    __testing.reset();
    recordPlaybackBeat("jti", { user: "u", jfId: null, at: now, visible: true, itemId: "x", device: null });
    expect((await mustWaitForPlayback(now)).signal.by).toBe("beat");
  });
});

// Next charge ces modules deux fois : le relais de flux et la route de progression écrivent dans la
// copie des routes, le moteur (démarré par `instrumentation.ts`) lit la sienne. Chacune avait son
// état : après un redémarrage, l'indexation n'entendait plus que Jellyfin (14/10/2026).
describe("les signaux de lecture, partagés par toutes les copies du module", () => {
  beforeEach(() => {
    __testing.reset();
    presenceTesting.reset();
    sessions.list = [];
    sessions.fail = true;
  });

  it("le relais de flux noté par une copie est entendu par l'autre", async () => {
    const now = Date.now();
    noteMediaRead(now);
    vi.resetModules();
    const other = await import("@/lib/repliques/playbackActivity");
    expect((await other.mustWaitForPlayback(now)).signal.by).toBe("stream");
    // Et la dernière lecture vue par l'une tient l'autre en attente les minutes qui suivent.
    expect((await other.mustWaitForPlayback(now + 120_000)).wait).toBe(true);
  });

  it("le battement de lecture enregistré par une copie est entendu par l'autre", async () => {
    const now = Date.now();
    recordPlaybackBeat("jti", { user: "u", jfId: null, at: now, visible: true, itemId: "x", device: null });
    vi.resetModules();
    const presence = await import("@/lib/activity/presence");
    const other = await import("@/lib/repliques/playbackActivity");
    expect(presence.anyPlaybackBeat(now)).toBe(true);
    expect((await other.mustWaitForPlayback(now)).signal.by).toBe("beat");
  });
});
