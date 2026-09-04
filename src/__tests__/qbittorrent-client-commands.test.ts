import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// qBittorrent 5.0 renamed both endpoints: `torrents/pause` and `torrents/resume` are gone and
// answer 404. Measured on this instance, which runs v5.2.3 — the two buttons had been dead since
// the upgrade, and silently, because the failure never reached the page.

vi.mock("@/lib/config", () => ({
  config: { qbittorrent: { url: "http://qb.local", username: "admin", password: "x" } },
}));

let calls: string[] = [];
let missing: string[] = [];

beforeEach(() => {
  calls = [];
  missing = [];
  vi.resetModules();
  vi.stubGlobal("fetch", async (url: string) => {
    const path = String(url).replace("http://qb.local", "");
    if (path.endsWith("/auth/login")) {
      return { ok: true, status: 200, headers: { get: () => "SID=abc; path=/", getSetCookie: () => ["SID=abc"] }, text: async () => "Ok." };
    }
    calls.push(path);
    if (missing.includes(path)) {
      return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => "" }, text: async () => "Not Found" };
    }
    return { ok: true, status: 200, headers: { get: () => "" }, text: async () => "" };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("les commandes de torrent", () => {
  it("emploie les noms de qBittorrent 5", async () => {
    const { qbittorrent } = await import("@/lib/clients/qbittorrent");
    await qbittorrent.pause(["h1"]);
    await qbittorrent.resume(["h1"]);
    expect(calls).toContain("/api/v2/torrents/stop");
    expect(calls).toContain("/api/v2/torrents/start");
  });

  it("retombe sur les anciens noms quand le serveur ne les connaît pas", async () => {
    // Un 404 est la façon dont une version antérieure dit qu'elle ne connaît pas ce nom — et la
    // seule qui n'oblige pas à demander sa version au serveur, ce qui vieillirait à son tour.
    missing = ["/api/v2/torrents/stop", "/api/v2/torrents/start"];
    const { qbittorrent } = await import("@/lib/clients/qbittorrent");
    await qbittorrent.pause(["h1"]);
    await qbittorrent.resume(["h1"]);
    expect(calls).toEqual([
      "/api/v2/torrents/stop",
      "/api/v2/torrents/pause",
      "/api/v2/torrents/start",
      "/api/v2/torrents/resume",
    ]);
  });

  it("ne masque pas une vraie panne derrière un repli", async () => {
    // Un 500 n'est pas un nom inconnu : il n'y a rien à réessayer sous un autre nom.
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("http://qb.local", "");
      if (path.endsWith("/auth/login")) {
        return { ok: true, status: 200, headers: { get: () => "SID=abc", getSetCookie: () => ["SID=abc"] }, text: async () => "Ok." };
      }
      calls.push(path);
      return { ok: false, status: 500, statusText: "Server Error", headers: { get: () => "" }, text: async () => "boom" };
    });
    const { qbittorrent } = await import("@/lib/clients/qbittorrent");
    await expect(qbittorrent.pause(["h1"])).rejects.toThrow();
    expect(calls.filter((c) => c.includes("torrents/"))).toEqual(["/api/v2/torrents/stop"]);
  });
});
