import { describe, it, expect } from "vitest";
import {
  ByteRate,
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
    expect(sourceBufferQuota(IPAD, 5)?.video).toBe(WEBKIT_MOBILE_SOURCE_BUFFER_BYTES);
  });

  it("vaut 304 Mo sur un vrai Mac", () => {
    expect(sourceBufferQuota(IPAD, 0)?.video).toBe(WEBKIT_MAC_SOURCE_BUFFER_BYTES);
  });

  it("ne donne au tampon sans image que 5 %", () => {
    expect(sourceBufferQuota(IPHONE)?.audio).toBe(Math.floor(WEBKIT_MOBILE_SOURCE_BUFFER_BYTES * 0.05));
  });

  it("n'invente rien ailleurs que sur WebKit", () => {
    expect(sourceBufferQuota(CHROME)).toBeNull();
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
