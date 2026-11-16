import { describe, it, expect, vi, afterEach } from "vitest";
import { aheadOf, bestClock, buildCascade, clockSample, probeMbps, summarizeCascades, syncClock, toPageTime, type PageEvent, type ServerEntry } from "@/components/lumenTest/chronology";

// La chronologie de la page de banc `/lumen-test` (étape 3e de docs/remux-serveur/, DECISIONS §160) : la partie sans
// navigateur. Les horloges se recalent à la manière de NTP sur l'échange au plus court aller-retour ; l'avance se lit
// dans la plage de `buffered` qui contient la position ; une cascade ramène chaque requête du serveur sur l'horloge de
// la page et dit, pour un saut, ce qui était demandé, prêt, remis et en réserve à `seeked` et à la reprise.

afterEach(() => vi.unstubAllGlobals());

const ranges = (list: [number, number][]) => ({ length: list.length, start: (i: number) => list[i][0], end: (i: number) => list[i][1] });

describe("les horloges", () => {
  it("un échange : le décalage au milieu de l'aller-retour, le temps passé dans le serveur retiré", () => {
    // Page à 1 000, serveur en avance de 250 ms ; 20 ms à l'aller, 30 ms dans le serveur, 20 ms au retour.
    const s = clockSample(1000, 1270, 1300, 1070);
    expect(s.offsetMs).toBe(250);
    expect(s.rttMs).toBe(40);
  });

  it("garde l'échange au plus court aller-retour", () => {
    const best = bestClock([
      { offsetMs: 300, rttMs: 180 },
      { offsetMs: 251.26, rttMs: 22.04 },
      { offsetMs: 240, rttMs: 60 },
    ]);
    expect(best).toEqual({ offsetMs: 251.3, rttMs: 22, samples: 3 });
    expect(bestClock([])).toBeNull();
    expect(toPageTime(10_250, best!, 9_000)).toBeCloseTo(998.7, 5);
  });

  it("`syncClock` : cinq échanges, un perdu ne compte pas, et la lecture `s` est nommée à chaque échange", async () => {
    const urls: string[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      n += 1;
      if (n === 2) throw new Error("coupé");
      const now = performance.timeOrigin + performance.now();
      return new Response(JSON.stringify({ t1: now + 500, t2: now + 501 }), { status: 200 });
    });
    const clock = await syncClock("a".repeat(32), "lt1234", 5, fetchImpl);
    expect(clock?.samples).toBe(4);
    expect(clock!.offsetMs).toBeGreaterThan(400);
    expect(urls.every((u) => u.startsWith(`/api/lumen/${"a".repeat(32)}/chrono?s=lt1234`))).toBe(true);
  });
});

describe("l'avance devant la position", () => {
  it("la fin de la plage qui contient la position, moins la position ; rien hors des plages", () => {
    expect(aheadOf(ranges([[0, 12.34]]), 4)).toBe(8.3);
    expect(aheadOf(ranges([[0, 10], [600, 640]]), 610.05)).toBe(30);
    // Juste avant le début d'une plage (le temps d'un saut) : comptée.
    expect(aheadOf(ranges([[600.2, 612]]), 600)).toBe(12);
    expect(aheadOf(ranges([[0, 10]]), 300)).toBeNull();
    expect(aheadOf(null, 1)).toBeNull();
    expect(probeMbps(4 * 1024 * 1024, 200)).toBe(168);
    expect(probeMbps(0, 200)).toBeNull();
  });
});

describe("la cascade d'un saut", () => {
  // Horloge : le serveur a 1 000 ms d'avance sur la page ; l'origine de la page est 5 000.
  const clock = { offsetMs: 1000, rttMs: 20, samples: 5 };
  const origin = 5_000;
  /** Une requête arrivée au serveur à l'instant `page` (horloge de la page). */
  const at = (page: number, name: string, rest: Partial<ServerEntry> = {}): ServerEntry => ({ name, at: page + origin + clock.offsetMs, ...rest });
  const ev = (t: number, e: string, rs: number, ahead: number | null): PageEvent => ({ t, e, rs, ct: 600, ahead });

  it("ramène les requêtes sur l'horloge de la page, et dit ce qui était demandé, remis et en réserve à seeked et à la reprise", () => {
    const entries: ServerEntry[] = [
      at(900, "v/90.m4s", { ready: 10, first: 11, last: 30, bytes: 3_000_000 }), // avant le geste : pas dans la fenêtre
      at(10_040, "a2/150.m4s", { ready: 20, first: 21, last: 25, bytes: 400_000 }),
      at(10_045, "v/150.m4s", { ready: 90, first: 91, last: 160, bytes: 6_000_000, build: 80, wait: 2 }),
      at(10_300, "v/151.m4s", { ready: 30, first: 31, last: 200, bytes: 6_000_000, reused: true }),
      at(10_700, "v/152.m4s", { ready: 25, first: 26, last: 400, bytes: 6_000_000 }),
      at(11_400, "v/153.m4s", { ready: 25, first: 26, last: 300, bytes: 6_000_000, aborted: true }),
      at(13_000, "v/160.m4s", { ready: 25 }), // après la fenêtre
    ];
    const events = [ev(10_001, "seeking", 1, null), ev(10_250, "buf", 1, 4), ev(10_600, "seeked", 2, 8), ev(10_610, "playing", 2, 8), ev(11_000, "buf", 3, 16), ev(11_450, "reprise", 4, 22)];
    const c = buildCascade({ kind: "saut", to: 600.04, startedAt: 10_000, seekedAt: 10_600, playingAt: 10_610, advanceAt: 11_450, endAt: 12_950 }, events, { entries, clock, timeOrigin: origin });
    expect(c).toMatchObject({
      k: "saut",
      to: 600,
      firstReqMs: 40,
      firstSegMs: 40,
      firstVideoReadyMs: 135,
      firstVideoSentMs: 205,
      seekedMs: 600,
      playingMs: 610,
      advanceMs: 1450,
      aheadSeekedS: 8,
      aheadPlayingS: 8,
      aheadAdvanceS: 22,
      videoSeeked: 2,
      videoAdvance: 4,
      readyMaxMs: 90,
    });
    // Remis avant seeked : a2/150 (fini à 65) et v/150 (205) et v/151 (500) ; avant la reprise, v/152 aussi (1 100).
    expect(c.sentSeekedMB).toBe(12.4);
    expect(c.sentAdvanceMB).toBe(18.4);
    expect(c.req).toEqual(["+40 a2/150.m4s r20 f21 l25 k391", "+45 v/150.m4s r90 f91 l160 k5859", "+300 v/151.m4s r30 f31 l200 k5859 p", "+700 v/152.m4s r25 f26 l400 k5859", "+1400 v/153.m4s r25 f26 l300 k5859 x"]);
    expect(c.ev[0]).toBe("+1 seeking rs1 a-");
    expect(c.ev.at(-1)).toBe("+1450 reprise rs4 a22");
    // Vu du serveur : 18,4 Mo remis entre 61 et 1 100 ms — un majorant (les tampons absorbent les envois).
    expect(c.srvMbps).toBe(142);
  });

  it("sans horloge (lecteur actuel) : les requêtes que la page a faites elle-même, par Resource Timing", () => {
    const c = buildCascade({ kind: "saut", to: 30, startedAt: 1000, seekedAt: 1200, advanceAt: 1500, endAt: 3000 }, [], {
      resources: [
        { name: "https://x/api/jellyfin/stream/abc?static=true", startTime: 1010, responseStart: 1050, responseEnd: 1180, encodedBodySize: 1_048_576 },
        { name: "https://x/api/other", startTime: 4000, responseStart: 4001, responseEnd: 4002 },
      ],
    });
    expect(c.req).toEqual(["+10 stream f40 l170 k1024"]);
    expect(c.firstReqMs).toBe(10);
  });

  it("un démarrage préparé d'avance : la fenêtre commence à la pose de la source, ses instants sont négatifs", () => {
    const entries = [at(4_000, "master.m3u8", { ready: 3 }), at(4_100, "v.m3u8", { ready: 2 }), at(9_100, "v/0.m4s", { ready: 4, last: 30, bytes: 1000 })];
    const c = buildCascade({ kind: "départ", to: 0, startedAt: 9_000, from: 4_000, frameAt: 9_300, endAt: 11_300 }, [], { entries, clock, timeOrigin: origin });
    expect(c.req.map((r) => r.split(" ").slice(0, 2).join(" "))).toEqual(["-5000 master.m3u8", "-4900 v.m3u8", "+100 v/0.m4s"]);
    expect(c.frameMs).toBe(300);
  });

  it("le résumé d'un essai : des médianes sur les sauts repris, le pire du serveur sur toutes les fenêtres", () => {
    const saut = (advanceMs: number | undefined, ahead: number, readyMaxMs: number) => ({ k: "saut" as const, to: 1, seekedMs: 500, advanceMs, aheadAdvanceS: ahead, aheadSeekedS: 4, firstReqMs: 30, videoAdvance: 5, readyMaxMs, req: [], ev: [] });
    const summary = summarizeCascades([{ k: "départ", to: 0, readyMaxMs: 400, req: [], ev: [] }, saut(1300, 20, 50), saut(1500, 30, 60), saut(undefined, 99, 70)]);
    expect(summary).toEqual({ aheadAdvanceS: 25, aheadSeekedS: 4, firstReqMs: 30, seekedToAdvanceMs: 900, videoAdvance: 5, readyMaxMs: 400 });
  });
});
