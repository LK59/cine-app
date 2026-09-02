import { describe, it, expect } from "vitest";
import { pqToNits, toneMapLuma, bt2020ToBt709, linearToSrgb } from "@/lib/webcodecs/hdrMath";

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
  it("maps black to black and the mastering peak to display white", () => {
    expect(toneMapLuma(0)).toBe(0);
    expect(toneMapLuma(1)).toBeCloseTo(1, 6);
  });

  it("leaves the low end nearly untouched — that's what keeps faces from going grey", () => {
    // Under 10% of peak, the curve stays within a few percent of linear.
    expect(toneMapLuma(0.05)).toBeGreaterThan(0.045);
    expect(toneMapLuma(0.1)).toBeGreaterThan(0.09);
  });

  it("compresses above the peak instead of clipping", () => {
    expect(toneMapLuma(2)).toBeGreaterThan(1);
    expect(toneMapLuma(4)).toBeGreaterThan(toneMapLuma(2));
  });

  it("never inverts", () => {
    let previous = -1;
    for (let l = 0; l <= 3; l += 0.1) {
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
