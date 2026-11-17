// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { APP_LIKE_LEVERS, appLikeCause, appLikeVariants, runAppLikeVariant, type AppLikeResult } from "@/components/lumenTest/appLikePass";
import { lumenRequestsSeen, resetLumenRequestWatch, watchLumenRequests } from "@/components/player/lumen/lumenLog";
import { lumenTestReport } from "@/lib/lumenServer/testReport";

/**
 * Le refus code 4 de Lumen serveur dans l'application (17/11/2026, docs/remux-serveur/README.md « Le refus code 4
 * dans l'app ») : la passe « Comme l'app » de `/lumen-test`, qui rejoue les gestes de l'hôte un à un, et le `seen`
 * de la ligne `fallback`, vide sur l'iPhone parce que le tampon Resource Timing du cinéma était plein d'affiches.
 */

afterEach(() => {
  resetLumenRequestWatch();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const res = (name: string, startTime: number, extra: Partial<PerformanceResourceTiming> = {}) =>
  ({ name: `https://app.test${name}`, startTime, duration: 40, transferSize: 1024, ...extra }) as PerformanceResourceTiming;

describe("ce que Safari a demandé (`seen`)", () => {
  it("tampon plein : les requêtes reçues par l'observateur posé au montage de l'hôte sont dites quand même", () => {
    let deliver: ((list: { getEntries: () => PerformanceEntry[] }) => void) | null = null;
    const observe = vi.fn();
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        constructor(cb: (list: { getEntries: () => PerformanceEntry[] }) => void) {
          deliver = cb;
        }
        observe = observe;
        disconnect() {}
      }
    );
    const grow = vi.fn();
    (performance as Performance & { setResourceTimingBufferSize: (n: number) => void }).setResourceTimingBufferSize = grow;
    const stop = watchLumenRequests();
    expect(observe).toHaveBeenCalledWith({ type: "resource", buffered: false });
    expect(grow).toHaveBeenCalledWith(1500);
    deliver!({
      getEntries: () => [
        res("/api/jellyfin/image?x=1", 5),
        res("/api/lumen/i/5-v/s123/tv.TOKEN/master.m3u8?audio=2", 10),
        res("/api/lumen/i/5-v/s123/tv.TOKEN/v.m3u8", 20),
        res("/api/lumen/i/5-v/autre/master.m3u8", 25),
        res("/api/lumen/i/5-v/s123/tv.TOKEN/master.m3u8?audio=2", 30, { responseStatus: 200 } as Partial<PerformanceResourceTiming>),
      ],
    });
    // Le tampon de la page ne garde rien de Lumen (plein d'affiches) : l'observateur suffit.
    expect(lumenRequestsSeen("s123", [res("/api/jellyfin/image?x=2", 1)])).toBe("master.m3u8?audio=2 40ms 1.0k | v.m3u8 40ms 1.0k | master.m3u8?audio=2 40ms 1.0k 200");
    stop();
    expect(lumenRequestsSeen("s123", [])).toBeUndefined();
  });

  it("une même requête vue par l'observateur et par le tampon n'est dite qu'une fois, dans l'ordre de départ", () => {
    let deliver: ((list: { getEntries: () => PerformanceEntry[] }) => void) | null = null;
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        constructor(cb: (list: { getEntries: () => PerformanceEntry[] }) => void) {
          deliver = cb;
        }
        observe() {}
        disconnect() {}
      }
    );
    const stop = watchLumenRequests();
    deliver!({ getEntries: () => [res("/api/lumen/i/v/s9/v.m3u8", 20)] });
    expect(lumenRequestsSeen("s9", [res("/api/lumen/i/v/s9/master.m3u8", 10), res("/api/lumen/i/v/s9/v.m3u8", 20)])).toBe("master.m3u8 40ms 1.0k | v.m3u8 40ms 1.0k");
    stop();
  });
});

describe("la passe « Comme l'app »", () => {
  it("le témoin, chaque levier seul, tous, tous sauf un, le témoin de nouveau", () => {
    const v = appLikeVariants();
    expect(v[0]).toEqual({ name: "témoin", levers: [] });
    expect(v.at(-1)).toEqual({ name: "témoin-fin", levers: [] });
    expect(v.find((x) => x.name === "tout")?.levers).toEqual([...APP_LIKE_LEVERS]);
    for (const lever of APP_LIKE_LEVERS) {
      expect(v.find((x) => x.name === `+${lever}`)?.levers).toEqual([lever]);
      expect(v.find((x) => x.name === `tout-${lever}`)?.levers).not.toContain(lever);
    }
    expect(v).toHaveLength(2 + 1 + 2 * APP_LIKE_LEVERS.length);
  });

  const outcome = (fails: string[]): AppLikeResult[] => appLikeVariants().map((x) => ({ variant: x.name, levers: x.levers.join(","), outcome: fails.includes(x.name) ? "erreur" : "image", s: "s" }));

  it("nomme la cause : un levier seul, une combinaison, le témoin, la page, ou rien de reproduit", () => {
    expect(appLikeCause(outcome(["+fetch", "tout", "tout-preload", "tout-attrs", "tout-tracks", "tout-tv"]))).toBe("cause : fetch (échoue seul)");
    expect(appLikeCause(outcome(["tout", "tout-attrs", "tout-tracks", "tout-tv"]))).toBe("cause : la combinaison ; nécessaire : fetch, preload");
    expect(appLikeCause(outcome(["témoin"]))).toMatch(/^le témoin échoue/);
    expect(appLikeCause(outcome(["témoin-fin"]))).toMatch(/^le témoin de fin échoue/);
    expect(appLikeCause(outcome([]))).toMatch(/^tout passe/);
  });

  it("« tout » : la page lit la liste maître avant l'adresse, les `<track>` et les attributs de l'hôte, `load()` après `src`", async () => {
    const master = "/api/lumen/i/5-v/s/tv.T/master.m3u8?audio=2";
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/eligibility?")) {
          expect(url).toContain("tv=1");
          return new Response(JSON.stringify({ ok: true, master }), { status: 200 });
        }
        order.push(`fetch ${url} (src ${document.querySelector("video")?.getAttribute("src") ?? "aucune"})`);
        return new Response("#EXTM3U", { status: 200 });
      })
    );
    let seenAtLoad: { preload: string; autoplay: boolean; airplay: string | null; tracks: number } | null = null;
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (this: HTMLMediaElement) {
      if (this.getAttribute("src")) {
        order.push("load");
        seenAtLoad = { preload: this.preload, autoplay: this.autoplay, airplay: this.getAttribute("x-webkit-airplay"), tracks: this.querySelectorAll("track").length };
      }
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      order.push("play");
      queueMicrotask(() => this.dispatchEvent(new Event("loadeddata")));
      return Promise.resolve();
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const r = await runAppLikeVariant({
      itemId: "i",
      variant: { name: "tout", levers: [...APP_LIKE_LEVERS] },
      host,
      subtitles: [{ url: "/api/sub/1.vtt", language: "fre", label: "Français" }],
      stopped: () => false,
    });
    expect(r.outcome).toBe("image");
    expect(r.via).toBe("loadeddata");
    expect(order).toEqual([`fetch ${master} (src aucune)`, "load", "play"]);
    expect(seenAtLoad).toEqual({ preload: "auto", autoplay: true, airplay: "allow", tracks: 1 });
    // L'élément est rendu et retiré : une séance HLS à la fois.
    expect(host.querySelector("video")).toBeNull();
  });

  it("le témoin : ce que fait la page de banc — ni lecture par la page, ni `load()`, ni `<track>`, `preload` none", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ ok: true, master: "/api/lumen/i/5-v/s/master.m3u8" }), { status: 200 });
      })
    );
    const loads = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    let preload = "";
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      preload = this.preload;
      queueMicrotask(() => {
        Object.defineProperty(this, "error", { value: { code: 4, message: "" }, configurable: true });
        this.dispatchEvent(new Event("error"));
      });
      return Promise.resolve();
    });
    const host = document.createElement("div");
    const r = await runAppLikeVariant({ itemId: "i", variant: { name: "témoin", levers: [] }, host, subtitles: [{ url: "/x.vtt", label: "x" }], stopped: () => false });
    expect(r).toMatchObject({ outcome: "erreur", code: 4, levers: "aucun" });
    expect(r.message).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("tv=1");
    expect(preload).toBe("none");
    // Un seul `load()` : celui du nettoyage, après le verdict.
    expect(loads).toHaveBeenCalledTimes(1);
  });

  it("la ligne de startup.log garde la variante, son verdict et ce que Safari a demandé ; le reste tombe", () => {
    const report = lumenTestReport(
      {
        build: "abc",
        appLike: { itemId: "80b2edc0cc145182f3db3c18969871c8", variant: "tout-tv", levers: "fetch,preload,attrs,tracks", outcome: "erreur", code: 4, ms: 312, seen: "master.m3u8 40ms", s: "al0011", evil: "x" },
      },
      "louis"
    );
    expect(report.appLike).toEqual({ itemId: "80b2edc0cc145182f3db3c18969871c8", variant: "tout-tv", levers: "fetch,preload,attrs,tracks", outcome: "erreur", code: 4, ms: 312, seen: "master.m3u8 40ms", s: "al0011" });
    const summary = lumenTestReport({ appLike: { summary: true, cause: "cause : fetch (échoue seul)", results: [{ variant: "témoin", outcome: "image", ms: 900, junk: 1 }] } }, "louis");
    expect(summary.appLike).toEqual({ summary: true, cause: "cause : fetch (échoue seul)", results: [{ variant: "témoin", outcome: "image", ms: 900 }] });
  });
});
