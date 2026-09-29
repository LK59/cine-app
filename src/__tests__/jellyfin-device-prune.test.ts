import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jf", apiKey: "cle" } } }));
const liveJfDevices = vi.fn((): string[] => []);
vi.mock("@/lib/db", () => ({ sessionDb: { liveJfDevices: () => liveJfDevices() } }));
const mockLogError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => mockLogError(...a) }));
const mockAuthEvent = vi.fn();
vi.mock("@/lib/eventLogs", () => ({ logAuthEvent: (...a: unknown[]) => mockAuthEvent(...a) }));

import { selectPrunableDevices, pruneJellyfinDevices, DEVICE_MAX_IDLE_MS, MAX_DELETIONS_PER_RUN } from "@/lib/jellyfinDevicePrune";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const DAY = 24 * 3600_000;
const iso = (ageMs: number) => new Date(NOW - ageMs).toISOString();
const old = iso(31 * DAY);

function device(over: Partial<{ Id: string; AppName: string; LastUserName: string; DateLastActivity: string | undefined }> = {}) {
  return { Id: "cine-app-1", AppName: "CineApp", LastUserName: "alice", DateLastActivity: old, ...over };
}

describe("selectPrunableDevices", () => {
  it("retient un appareil CineApp, à nous, inactif depuis plus de trente jours", () => {
    expect(selectPrunableDevices([device()], NOW).map((d) => d.Id)).toEqual(["cine-app-1"]);
  });

  it("ne touche jamais un autre client, même vieux et même avec notre préfixe", () => {
    expect(selectPrunableDevices([device({ AppName: "Jellyfin Web" }), device({ AppName: "Jellyfin Android TV" })], NOW)).toEqual([]);
  });

  it("ne touche jamais un identifiant qui n'est pas le nôtre, même sous le nom CineApp", () => {
    expect(selectPrunableDevices([device({ Id: "TW96aWxsYS81LjA" }), device({ Id: "xcine-app-1" })], NOW)).toEqual([]);
  });

  it("garde un appareil récent, y compris juste sous les trente jours", () => {
    expect(selectPrunableDevices([device({ DateLastActivity: iso(2 * DAY) }), device({ DateLastActivity: iso(DEVICE_MAX_IDLE_MS - 60_000) })], NOW)).toEqual([]);
  });

  it("garde un appareil sans date ou à la date illisible", () => {
    expect(selectPrunableDevices([device({ DateLastActivity: undefined }), device({ DateLastActivity: "" }), device({ DateLastActivity: "hier" })], NOW)).toEqual([]);
  });

  it("garde l'appareil d'une session encore vivante, si vieux soit-il", () => {
    expect(selectPrunableDevices([device({ Id: "cine-app-vivant" }), device({ Id: "cine-app-mort" })], NOW, new Set(["cine-app-vivant"])).map((d) => d.Id)).toEqual(["cine-app-mort"]);
  });

  it("s'arrête à la borne", () => {
    const many = Array.from({ length: MAX_DELETIONS_PER_RUN + 10 }, (_, i) => device({ Id: `cine-app-${i}` }));
    expect(selectPrunableDevices(many, NOW)).toHaveLength(MAX_DELETIONS_PER_RUN);
  });
});

describe("pruneJellyfinDevices", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    liveJfDevices.mockReturnValue([]);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function listing(items: unknown[]) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ Items: items }), { status: 200 });
      return new Response(null, { status: 204 });
    });
  }
  const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => url as string);

  it("ne supprime que les bonnes entrées, avec la clé d'administration et un délai", async () => {
    listing([
      device({ Id: "cine-app-a" }),
      device({ Id: "cine-app-b", DateLastActivity: iso(DAY) }),
      device({ Id: "tv", AppName: "Jellyfin Android TV" }),
      device({ Id: "cine-app-c", LastUserName: "bob" }),
      device({ Id: "cine-app-vivant" }),
    ]);
    liveJfDevices.mockReturnValue(["cine-app-vivant"]);
    const r = await pruneJellyfinDevices(NOW);
    expect(r.deleted).toBe(2);
    expect(deletes()).toEqual(["http://jf/Devices?id=cine-app-a", "http://jf/Devices?id=cine-app-c"]);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({ Authorization: 'MediaBrowser Token="cle"' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(mockAuthEvent).toHaveBeenCalledWith("devices-pruned", { user: "alice", count: 1 });
    expect(mockAuthEvent).toHaveBeenCalledWith("devices-pruned", { user: "bob", count: 1 });
  });

  it("respecte la borne par passage", async () => {
    listing(Array.from({ length: MAX_DELETIONS_PER_RUN + 5 }, (_, i) => device({ Id: `cine-app-${i}` })));
    await pruneJellyfinDevices(NOW);
    expect(deletes()).toHaveLength(MAX_DELETIONS_PER_RUN);
  });

  it("ne lève pas quand Jellyfin est injoignable, et ne supprime rien", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(pruneJellyfinDevices(NOW)).resolves.toEqual({ deleted: 0 });
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockAuthEvent).not.toHaveBeenCalled();
  });

  it("ne lève pas sur une réponse en erreur", async () => {
    fetchMock.mockResolvedValue(new Response("non", { status: 500 }));
    await expect(pruneJellyfinDevices(NOW)).resolves.toEqual({ deleted: 0 });
    expect(deletes()).toEqual([]);
  });

  it("une suppression refusée n'arrête pas les autres ni ne lève", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ Items: [device({ Id: "cine-app-x" }), device({ Id: "cine-app-y" })] }), { status: 200 });
      if (url.endsWith("cine-app-x")) throw new TypeError("fetch failed");
      return new Response(null, { status: 204 });
    });
    await expect(pruneJellyfinDevices(NOW)).resolves.toEqual({ deleted: 1 });
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockAuthEvent).toHaveBeenCalledWith("devices-pruned", { user: "alice", count: 1 });
  });
});
