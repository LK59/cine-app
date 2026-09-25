import { describe, it, expect } from "vitest";
import {
  ByteRate,
  CHROMIUM_ANDROID,
  CHROMIUM_DESKTOP,
  GECKO,
  GECKO_BEFORE_130,
  WEBKIT_MAC_SOURCE_BUFFER_BYTES,
  WEBKIT_MOBILE_SOURCE_BUFFER_BYTES,
  laneBudget,
  sourceBufferQuota,
  tightest,
} from "@/lib/webcodecs/bufferBudget";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";
/** L'iPad de la maison, qui se présente comme un Mac. */
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

describe("le plafond d'un SourceBuffer", () => {
  // Les chiffres de WebKit (SettingsBaseCocoa.mm), relus le 25/09/2026 : 105 Mo sur iOS et iPadOS,
  // 304 Mo sur macOS — et non 304 Mo partout, qui est la valeur des WebKit hors Apple.
  it("vaut 105 Mo sur iPhone, et sur un iPad même quand il se dit Mac", () => {
    expect(sourceBufferQuota(IPHONE)?.video).toBe(WEBKIT_MOBILE_SOURCE_BUFFER_BYTES);
    expect(sourceBufferQuota(IPAD, { maxTouchPoints: 5 })?.video).toBe(WEBKIT_MOBILE_SOURCE_BUFFER_BYTES);
  });

  it("vaut 304 Mo sur un vrai Mac", () => {
    expect(sourceBufferQuota(IPAD, { maxTouchPoints: 0 })?.video).toBe(WEBKIT_MAC_SOURCE_BUFFER_BYTES);
  });

  it("ne donne au tampon sans image que 5 %", () => {
    expect(sourceBufferQuota(IPHONE)?.audio).toBe(Math.floor(WEBKIT_MOBILE_SOURCE_BUFFER_BYTES * 0.05));
  });

});

describe("le plafond de Chromium", () => {
  // media/base/demuxer_memory_limit_default.cc et _android.cc, relus le 25/09/2026.
  const EDGE = CHROME + " Edg/152.0.0.0";
  const OPERA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 OPR/135.0.0.0";
  const ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";
  const CHROME_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.108 Mobile/15E148 Safari/604.1";

  it.each([["Chrome", CHROME], ["Edge", EDGE], ["Opera", OPERA]])("%s sur ordinateur : 150 Mio d'image, 12 de son", (_n, ua) => {
    expect(sourceBufferQuota(ua)).toEqual({ engine: "Chromium", ...CHROMIUM_DESKTOP });
    expect(CHROMIUM_DESKTOP).toEqual({ video: 157_286_400, audio: 12_582_912 });
  });

  it.each([
    [8, CHROMIUM_ANDROID.default],
    [4, CHROMIUM_ANDROID.medium],
    [2, CHROMIUM_ANDROID.medium],
    [1, CHROMIUM_ANDROID.low],
    [0.5, CHROMIUM_ANDROID.veryLow],
  ])("Android avec %s Go annoncés : le palier le plus bas que ça autorise", (memory, tier) => {
    expect(sourceBufferQuota(ANDROID, { deviceMemory: memory })).toEqual({ engine: "Chromium Android", ...tier });
  });

  it("Android sans mémoire annoncée : le palier du milieu", () => {
    expect(sourceBufferQuota(ANDROID)).toEqual({ engine: "Chromium Android", ...CHROMIUM_ANDROID.medium });
  });

  it("Chrome sur iPhone est WebKit, et en prend les chiffres", () => {
    expect(sourceBufferQuota(CHROME_IOS)?.engine).toBe("WebKit mobile");
  });
});

describe("le plafond de Gecko", () => {
  // dom/media/mediasource/TrackBuffersManager.cpp, relu le 25/09/2026 ; 100 → 150 Mio au bug 1760529.
  it.each([
    ["Firefox sous Linux", "Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0"],
    ["Firefox sous Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0"],
    ["Firefox sur Android", "Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0"],
  ])("%s : 150 Mio d'image, 20 de son", (_n, ua) => {
    expect(sourceBufferQuota(ua)).toEqual({ engine: "Gecko", ...GECKO });
    expect(GECKO).toEqual({ video: 157_286_400, audio: 20_971_520 });
  });

  it("avant Firefox 130 : 100 Mio d'image", () => {
    expect(sourceBufferQuota("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0")).toEqual({ engine: "Gecko", ...GECKO_BEFORE_130 });
  });

  it("Firefox sur iPhone est WebKit", () => {
    expect(sourceBufferQuota("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/126.0 Mobile/15E148 Safari/605.1.15")?.engine).toBe("WebKit mobile");
  });
});

describe("un moteur qu'on ne connaît pas", () => {
  it("garde le comportement d'avant", () => {
    expect(sourceBufferQuota("Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2; Trident/6.0)")).toBeNull();
    expect(sourceBufferQuota("")).toBeNull();
  });
});

describe("le budget d'un tampon", () => {
  /** Ted Lasso S04 : 27 Mb/s d'image, 3,4 Mo/s. */
  const TED_LASSO = 27e6 / 8;

  it("tient sous le plafond d'un iPad en 4K, avance et arrière réunis", () => {
    const b = laneBudget(WEBKIT_MOBILE_SOURCE_BUFFER_BYTES, TED_LASSO, 30, 30, 8)!;
    expect(b.aheadSeconds).toBeLessThan(30);
    expect(b.aheadSeconds).toBeGreaterThanOrEqual(15);
    expect((b.aheadSeconds + b.behindSeconds) * TED_LASSO).toBeLessThanOrEqual(WEBKIT_MOBILE_SOURCE_BUFFER_BYTES * 0.85 + 1);
  });

  it("laisse les trente secondes d'avant sur un Mac, ou pour un fichier léger", () => {
    expect(laneBudget(WEBKIT_MAC_SOURCE_BUFFER_BYTES, TED_LASSO, 30, 30, 8)!.aheadSeconds).toBe(30);
    expect(laneBudget(WEBKIT_MOBILE_SOURCE_BUFFER_BYTES, 6e6 / 8, 30, 30, 8)!.aheadSeconds).toBe(30);
  });

  it("garde l'avance minimale même pour un débit énorme, et fait céder l'arrière", () => {
    const b = laneBudget(WEBKIT_MOBILE_SOURCE_BUFFER_BYTES, 80e6 / 8, 30, 30, 8)!;
    expect(b.aheadSeconds).toBe(8);
    expect(b.behindSeconds).toBeGreaterThanOrEqual(1);
    expect(b.behindSeconds).toBeLessThan(6);
  });

  it("ne dit rien tant que le débit n'est pas mesuré", () => {
    expect(laneBudget(WEBKIT_MOBILE_SOURCE_BUFFER_BYTES, null, 30, 30, 8)).toBeNull();
  });

  it("prend le plus serré des deux tampons", () => {
    expect(tightest({ aheadSeconds: 20, behindSeconds: 10 }, { aheadSeconds: 12, behindSeconds: 15 }, null)).toEqual({ aheadSeconds: 12, behindSeconds: 10 });
    expect(tightest(null, null)).toBeNull();
  });
});

describe("le débit mesuré", () => {
  it("penche vers la scène la plus lourde de la fenêtre", () => {
    const rate = new ByteRate();
    rate.record(2e6, 2);
    rate.record(2e6, 2);
    rate.record(8e6, 2);
    // Moyenne 2 Mo/s, pointe 4 Mo/s : 3 Mo/s.
    expect(rate.bytesPerSecond).toBeCloseTo(2e6 * 0.5 + 4e6 * 0.5 - 0, -3);
  });

  it("ignore un segment sans durée mesurable", () => {
    const rate = new ByteRate();
    rate.record(5e6, 0.05);
    expect(rate.bytesPerSecond).toBeNull();
  });
});
