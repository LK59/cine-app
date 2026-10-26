import { describe, it, expect, vi } from "vitest";

vi.mock("@/components/PlaybackProvider", () => ({ PLAYER_RELOAD_INTENT_KEY: "reload-intent" }));

import { withStartFragment } from "@/components/player/server/serverElement";
import { ServerStartup } from "@/lib/serverStartup";

// Une reprise sur Safari (HLS natif) part de la position par `#t=` (26/10/2026) : sans lui, Safari
// demandait le segment 0 et Jellyfin lançait ffmpeg au début, puis une seconde fois à la reprise.

describe("withStartFragment", () => {
  it("ajoute la position de départ à une reprise", () => {
    expect(withStartFragment("https://x/master.m3u8?a=1", 1055.7591)).toBe("https://x/master.m3u8?a=1#t=1055.759");
  });

  it("laisse l'adresse telle quelle depuis le début, sans position, ou avec un fragment déjà là", () => {
    expect(withStartFragment("https://x/m.m3u8", 0)).toBe("https://x/m.m3u8");
    expect(withStartFragment("https://x/m.m3u8", undefined)).toBe("https://x/m.m3u8");
    expect(withStartFragment("https://x/m.m3u8", Number.NaN)).toBe("https://x/m.m3u8");
    expect(withStartFragment("https://x/m.m3u8#t=5", 60)).toBe("https://x/m.m3u8#t=5");
  });
});

describe("la preuve au journal", () => {
  const entry = (name: string, startTime: number) =>
    ({ name, startTime, responseStart: startTime + 10, responseEnd: startTime + 100, encodedBodySize: 10, transferSize: 10 }) as unknown as PerformanceEntry;

  it("le premier segment média demandé, l'init mis à part", () => {
    const s = new ServerStartup(1000, () => 5000);
    s.fromResources(
      [
        entry("https://x/api/jellyfin/stream/i/master.m3u8", 1100),
        entry("https://x/api/jellyfin/stream/i/main.m3u8", 1200),
        entry("https://x/api/jellyfin/stream/i/hls1/main/-1.mp4?s=1", 1300),
        entry("https://x/api/jellyfin/stream/i/hls1/main/351.mp4?s=1", 1400),
        entry("https://x/api/jellyfin/stream/i/hls1/main/352.mp4?s=1", 1500),
      ],
      "/api/jellyfin/stream/"
    );
    expect(s.fields().startup).toMatchObject({ firstSegment: 351 });
  });

  it("le bilan dit qu'un fragment a été posé", () => {
    const s = new ServerStartup(0, () => 10);
    s.resumeAsked(1055);
    s.resumeFragment();
    expect(s.resumeFields()).toMatchObject({ resumeAt: 1055, resumeFragment: 1 });
  });

  it("sans reprise, pas de marque", () => {
    const s = new ServerStartup(0, () => 10);
    s.resumeFragment();
    expect(s.resumeFields()).toEqual({});
  });
});
