// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { announcesLowBandwidth, LINK_FRESH_MS, linkMbpsOf, recentLinkMbps, rememberLink, withLowBandwidth } from "@/components/player/lumen/lumenLink";

// La règle du débit annoncé au quart (17/11/2026) : seulement quand la connexion le permet.
const seg = (path: string, startTime: number, ms: number, bytes: number) => ({ name: `https://x/api/lumen/i/6-a/sess1/${path}`, startTime, responseEnd: startTime + ms, transferSize: bytes });

afterEach(() => localStorage.clear());

describe("lumenLink", () => {
  it("le débit : médiane des derniers gros segments de cette lecture, requête entière comptée", () => {
    const mb = 1_000_000;
    const entries = [
      seg("v/1.m4s", 0, 400, 2 * mb), // 40 Mb/s
      seg("a2/1.m4s", 10, 100, 100_000), // trop petit : ignoré
      seg("v/2.m4s", 500, 800, 2 * mb), // 20 Mb/s
      seg("v/3.m4s", 1400, 200, 2 * mb), // 80 Mb/s
      seg("v.m3u8", 1600, 10, 2 * mb), // une liste : ignorée
      { name: "https://x/api/lumen/i/6-a/autre/v/4.m4s", startTime: 1700, responseEnd: 1701, transferSize: 2 * mb }, // une autre lecture
    ];
    expect(linkMbpsOf("sess1", entries)).toBe(40);
    expect(linkMbpsOf("sess1", entries.slice(0, 2))).toBeNull();
  });

  it("gardé dix minutes sur l'appareil", () => {
    rememberLink(42, 1_000);
    expect(recentLinkMbps(1_000 + LINK_FRESH_MS - 1)).toBe(42);
    expect(recentLinkMbps(1_000 + LINK_FRESH_MS)).toBeNull();
    localStorage.setItem("cine:lumen-debit", "{pas du json");
    expect(recentLinkMbps()).toBeNull();
  });

  it("le quart seulement à 1,5 fois le débit moyen du film, avec une mesure", () => {
    expect(announcesLowBandwidth(30, 20_000_000)).toBe(true);
    expect(announcesLowBandwidth(29.9, 20_000_000)).toBe(false);
    expect(announcesLowBandwidth(null, 20_000_000)).toBe(false);
    expect(announcesLowBandwidth(100, undefined)).toBe(false);
  });

  it("l'adresse : `bw=bas` avant le fragment, une seule fois", () => {
    expect(withLowBandwidth("/m.m3u8?audio=2#t=600")).toBe("/m.m3u8?audio=2&bw=bas#t=600");
    expect(withLowBandwidth("/m.m3u8")).toBe("/m.m3u8?bw=bas");
    expect(withLowBandwidth("/m.m3u8?audio=2&bw=bas")).toBe("/m.m3u8?audio=2&bw=bas");
  });
});

describe("lowestServedBps", () => {
  it("l'échelon le plus léger, sinon le film ; rien sans rien", async () => {
    const { lowestServedBps } = await import("@/components/player/lumen/lumenLink");
    expect(lowestServedBps([{ averageBps: 8e6 }, { averageBps: 3e6 }], 20e6)).toBe(3e6);
    expect(lowestServedBps([], 5.6e6)).toBe(5.6e6);
    expect(lowestServedBps(undefined, undefined)).toBeNull();
  });
});
