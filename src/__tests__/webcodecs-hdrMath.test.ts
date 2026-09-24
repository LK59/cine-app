import { describe, it, expect } from "vitest";
import { pqToNits, toneMapLuma, bt2020ToBt709, linearToSrgb, REFERENCE_WHITE_NITS } from "@/lib/webcodecs/hdrMath";

describe("PQ transfer function", () => {
  // Anchor points from ST 2084 itself. A mistyped constant moves these by a lot while still
  // producing a plausible-looking curve, which is why they are pinned rather than eyeballed.
  it("maps the standard anchor points", () => {
    expect(pqToNits(0)).toBeCloseTo(0, 6);
    expect(pqToNits(1)).toBeCloseTo(10000, 0);
    // ~100 nits — the reference white of an SDR grade — sits just above half the code range.
    expect(pqToNits(0.5081)).toBeGreaterThan(90);
    expect(pqToNits(0.5081)).toBeLessThan(110);
    // ~1000 nits, the usual HDR10 mastering peak.
    expect(pqToNits(0.7518)).toBeGreaterThan(950);
    expect(pqToNits(0.7518)).toBeLessThan(1050);
  });

  it("increases monotonically", () => {
    let previous = -1;
    for (let code = 0; code <= 1; code += 0.05) {
      const nits = pqToNits(code);
      expect(nits).toBeGreaterThan(previous);
      previous = nits;
    }
  });
});

describe("tone mapping", () => {
  // En unités de blanc de référence : 1,0 = 203 nits.
  const nits = (n: number) => n / REFERENCE_WHITE_NITS;

  it("maps black to black and leaves shadows and mid tones exactly as graded", () => {
    expect(toneMapLuma(0)).toBe(0);
    expect(toneMapLuma(nits(20))).toBeCloseTo(nits(20), 9);
    expect(toneMapLuma(nits(100))).toBeCloseTo(nits(100), 9);
  });

  // Ce qui a été tranché à l'œil sur Chrome le 22/09/2026 : 203 nits, c'est le blanc de l'écran.
  // Normalisé sur un pic de 1000 nits, il sortait à 0,52 ; sur 4000 nits (2012), à 0,26.
  it("shows reference white near the screen's white, whatever the mastering peak", () => {
    expect(toneMapLuma(nits(203))).toBeGreaterThan(0.85);
    expect(toneMapLuma(nits(203))).toBeLessThan(1);
  });

  it("compresses highlights toward white instead of clipping them", () => {
    expect(toneMapLuma(nits(1000))).toBeGreaterThan(toneMapLuma(nits(400)));
    expect(toneMapLuma(nits(4000))).toBeGreaterThan(toneMapLuma(nits(1000)));
    expect(toneMapLuma(nits(10000))).toBeLessThan(1);
  });

  it("joins the straight line without an edge, and never inverts", () => {
    const knee = 0.8;
    const slope = (toneMapLuma(knee + 1e-4) - toneMapLuma(knee)) / 1e-4;
    expect(slope).toBeCloseTo(1, 2);
    let previous = -1;
    for (let l = 0; l <= 50; l += 0.05) {
      const mapped = toneMapLuma(l);
      expect(mapped).toBeGreaterThan(previous);
      previous = mapped;
    }
  });
});

describe("colour conversion", () => {
  it("leaves neutral grey neutral through the primaries matrix", () => {
    const [r, g, b] = bt2020ToBt709(0.5, 0.5, 0.5);
    expect(r).toBeCloseTo(0.5, 2);
    expect(g).toBeCloseTo(0.5, 2);
    expect(b).toBeCloseTo(0.5, 2);
  });

  it("keeps white at white", () => {
    const [r, g, b] = bt2020ToBt709(1, 1, 1);
    for (const channel of [r, g, b]) expect(channel).toBeCloseTo(1, 2);
  });

  it("applies the sRGB curve at its documented anchors", () => {
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(1, 6);
    // Linear 0.5 sits near 0.73 once encoded — the classic mid-grey shift.
    expect(linearToSrgb(0.5)).toBeCloseTo(0.735, 2);
  });
});
