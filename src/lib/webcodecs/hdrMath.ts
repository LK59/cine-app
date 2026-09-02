// Reference implementation of the colour maths the HDR shader performs.
//
// The shader itself cannot be unit-tested — there is no GPU in CI — and a single mistyped
// constant in the PQ curve produces a picture that is merely "a bit wrong", which is exactly the
// kind of error that survives eyeballing. These functions mirror the shader line for line so the
// constants and the curve shape can be pinned against known anchor points instead.

/** SMPTE ST 2084 (PQ) electro-optical transfer function: code value 0-1 to nits. */
export function pqToNits(code: number): number {
  const m1 = 0.1593017578125;
  const m2 = 78.84375;
  const c1 = 0.8359375;
  const c2 = 18.8515625;
  const c3 = 18.6875;
  const p = Math.pow(Math.max(code, 0), 1 / m2);
  const numerator = Math.max(p - c1, 0);
  const denominator = c2 - c3 * p;
  return Math.pow(numerator / Math.max(denominator, 1e-6), 1 / m1) * 10000;
}

/**
 * Extended Reinhard on luminance, normalised so 1.0 is the mastering peak.
 * Leaves dark and mid tones near-linear and compresses only near the top.
 */
export function toneMapLuma(luma: number, white = 1): number {
  return (luma * (1 + luma / Math.max(white * white, 1e-6))) / (1 + luma);
}

/** BT.2020 to BT.709 primaries, same matrix the shader applies. */
export function bt2020ToBt709(r: number, g: number, b: number): [number, number, number] {
  return [
    1.6605 * r - 0.5876 * g - 0.0728 * b,
    -0.1246 * r + 1.1329 * g - 0.0083 * b,
    -0.0182 * r - 0.1006 * g + 1.1187 * b,
  ];
}

/** sRGB opto-electronic transfer function. */
export function linearToSrgb(value: number): number {
  const v = Math.min(Math.max(value, 0), 1);
  return v < 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
