import { describe, it, expect } from "vitest";
import { assignDecodeTimes, deriveDurations } from "@/lib/webcodecs/decodeOrder";

// Decode timestamps are the one part of Matroska-to-MP4 that has to be *reconstructed* rather
// than copied, and getting it wrong produces stutter or drifting audio rather than an error. So
// the cases here are the real ones: no reordering, a classic IBBP pattern, and a long
// hierarchical GOP.

function samples(presentations: number[], duration = 1000) {
  return presentations.map((presentation) => ({ presentation, duration }));
}

describe("assignDecodeTimes", () => {
  it("leaves a stream without reordering exactly as it is", () => {
    const out = assignDecodeTimes(samples([0, 1000, 2000, 3000]), 0);
    expect(out.samples.map((s) => s.decode)).toEqual([0, 1000, 2000, 3000]);
    expect(out.samples.map((s) => s.compositionOffset)).toEqual([0, 0, 0, 0]);
    expect(out.presentationDelay).toBe(0);
  });

  // IBBP: displayed 0,1,2,3 but decoded I(0) P(3) B(1) B(2).
  it("recovers the decode timeline of a reordered group", () => {
    const out = assignDecodeTimes(samples([0, 3000, 1000, 2000]), 0);
    expect(out.samples.map((s) => s.decode)).toEqual([0, 1000, 2000, 3000]);
  });

  it("preserves every presentation time exactly, which is the only thing the viewer sees", () => {
    for (const order of [[0, 3000, 1000, 2000], [0, 6000, 2000, 4000, 1000, 3000, 5000]]) {
      const out = assignDecodeTimes(samples(order), 0);
      // Decode times are reconstructed, presentations are not: they must come back untouched, in
      // the same order as the input. Any change of spacing here is stutter on screen.
      expect(out.samples.map((s) => s.decode + s.compositionOffset)).toEqual(order);
    }
  });

  // This is the safety argument for writing signed composition offsets rather than delaying the
  // whole timeline: a negative offset can never push a picture out of the fragment it is in,
  // because the fragment's first decode time is the smallest presentation in it.
  it("never presents a picture before the group's own start, even with negative offsets", () => {
    for (const order of [[0, 3000, 1000, 2000], [0, 6000, 2000, 4000, 1000, 3000, 5000]]) {
      const out = assignDecodeTimes(samples(order), 90_000);
      const start = out.samples[0].decode;
      for (const sample of out.samples) {
        expect(sample.decode + sample.compositionOffset).toBeGreaterThanOrEqual(start);
      }
      // And reordering really is happening here, so the case is not vacuous.
      expect(Math.min(...out.samples.map((s) => s.compositionOffset))).toBeLessThan(0);
    }
  });

  it("reports the delay a caller unable to write signed offsets would need", () => {
    const out = assignDecodeTimes(samples([0, 3000, 1000, 2000]), 0);
    expect(out.presentationDelay).toBe(-Math.min(...out.samples.map((s) => s.compositionOffset)));
    // Applying it uniformly is what would make every offset non-negative.
    for (const sample of out.samples) {
      expect(sample.compositionOffset + out.presentationDelay).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the decode timeline strictly increasing, which is what a demuxer requires", () => {
    const out = assignDecodeTimes(samples([0, 4000, 2000, 1000, 3000]), 0);
    for (let i = 1; i < out.samples.length; i++) {
      expect(out.samples[i].decode).toBeGreaterThan(out.samples[i - 1].decode);
    }
  });

  it("survives duplicate timestamps rather than producing a timeline that goes backwards", () => {
    const out = assignDecodeTimes(samples([0, 1000, 1000, 2000]), 0);
    for (let i = 1; i < out.samples.length; i++) {
      expect(out.samples[i].decode).toBeGreaterThan(out.samples[i - 1].decode);
    }
  });

  it("starts where the previous group ended, and says where the next one must", () => {
    const out = assignDecodeTimes(samples([10_000, 13_000, 11_000, 12_000]), 90_000);
    expect(out.samples[0].decode).toBe(90_000);
    expect(out.samples.map((s) => s.decode)).toEqual([90_000, 91_000, 92_000, 93_000]);
    expect(out.endDecodeTime).toBe(94_000);
  });

  // Found on a real 23.976 fps file whose millisecond timestamps make frame durations alternate
  // between 41 and 42 ms. With a constant frame rate this is invisible; with uneven ones the next
  // group starts on the wrong tick and its whole presentation timeline shifts.
  it("ends the group after the picture shown last, not the one stored last", () => {
    // Decode order I(0) P(3000) B(1000) B(2000): the file's last sample is presented in the
    // middle, and its duration must not be the one that closes the group.
    const uneven = [
      { presentation: 0, duration: 1000 },
      { presentation: 3000, duration: 500 },
      { presentation: 1000, duration: 1000 },
      { presentation: 2000, duration: 1000 },
    ];
    const out = assignDecodeTimes(uneven, 0);
    expect(out.endDecodeTime).toBe(3500); // last decode time 3000, plus the 500 belonging to it

    // And the next group, starting there, must line up with where this one left off — which is
    // the property the bug actually broke.
    const next = assignDecodeTimes(samples([4000, 5000]), out.endDecodeTime);
    expect(next.samples[0].decode).toBe(3500);
  });

  it("returns nothing for an empty group", () => {
    expect(assignDecodeTimes([], 0)).toEqual({ samples: [], presentationDelay: 0, endDecodeTime: 0 });
  });
});

describe("deriveDurations", () => {
  // Matroska rarely stores a video block's duration: a frame lasts until the next one is shown.
  it("measures each duration against the next picture shown, not the next decoded", () => {
    expect(deriveDurations([0, 3000, 1000, 2000], 1000)).toEqual([1000, 1000, 1000, 1000]);
  });

  it("gives the last picture the group's typical duration instead of nothing", () => {
    const out = deriveDurations([0, 1000, 2000], 999);
    expect(out[2]).toBe(1000);
  });

  it("falls back to the given duration when there is only one picture", () => {
    expect(deriveDurations([5000], 1234)).toEqual([1234]);
  });

  it("is not thrown off by one irregular gap", () => {
    // A single long gap should not become everyone's duration.
    expect(deriveDurations([0, 1000, 2000, 9000], 1000)).toEqual([1000, 1000, 7000, 1000]);
  });
});

describe("PresentationDeduper — deux images ne partagent jamais un instant", () => {
  // Dirty Dancing (21/09/2026) : une image lue à 2,5 s datée de 42 ms, des images de tête datées
  // comme la dernière image du groupe d'avant. MediaSource retire l'image déjà en mémoire au même
  // instant, et Safari échouait peu après.
  it("laisse passer des instants tous différents", async () => {
    const { PresentationDeduper } = await import("@/lib/webcodecs/decodeOrder");
    const d = new PresentationDeduper();
    expect([0, 41708, 83417].map((t) => d.take(t))).toEqual([0, 41708, 83417]);
    expect(d.nudged).toBe(0);
  });

  it("décale d'une milliseconde une image qui reprend l'instant d'une autre", async () => {
    const { PresentationDeduper, DUPLICATE_NUDGE_US } = await import("@/lib/webcodecs/decodeOrder");
    const d = new PresentationDeduper();
    d.take(42000);
    d.take(83000);
    expect(d.take(42000)).toBe(42000 + DUPLICATE_NUDGE_US);
    // Et encore une fois si le décalage lui-même est pris.
    expect(d.take(42000)).toBe(42000 + 2 * DUPLICATE_NUDGE_US);
    expect(d.nudged).toBe(2);
  });

  it("place après elle une image qui commence une milliseconde avant une autre", async () => {
    // 19,978 s et 19,979 s dans le même fichier : l'image de 42 ms qui commence la première
    // recouvre l'autre, que MediaSource retire tout autant.
    const { PresentationDeduper, DUPLICATE_NUDGE_US } = await import("@/lib/webcodecs/decodeOrder");
    const d = new PresentationDeduper();
    d.take(19_979_000);
    expect(d.take(19_978_000)).toBe(19_979_000 + DUPLICATE_NUDGE_US);
    expect(d.nudged).toBe(1);
  });

  it("ne touche pas à une image qui commence juste après une autre : elle ne recouvre rien", async () => {
    const { PresentationDeduper } = await import("@/lib/webcodecs/decodeOrder");
    const d = new PresentationDeduper();
    d.take(19_978_000);
    expect(d.take(19_979_000)).toBe(19_979_000);
    expect(d.nudged).toBe(0);
  });

  it("n'oublie qu'au-delà de sa mémoire, et oublie proprement", async () => {
    const { PresentationDeduper } = await import("@/lib/webcodecs/decodeOrder");
    const d = new PresentationDeduper();
    for (let i = 0; i < 5000; i++) d.take(i * 41_708);
    // Le tout premier est sorti de la mémoire : le reprendre ne décale rien.
    expect(d.take(0)).toBe(0);
    // Un récent, si.
    expect(d.take(4999 * 41_708)).not.toBe(4999 * 41_708);
  });

  it("repart à neuf après un saut", async () => {
    const { PresentationDeduper } = await import("@/lib/webcodecs/decodeOrder");
    const d = new PresentationDeduper();
    d.take(42000);
    d.reset();
    expect(d.take(42000)).toBe(42000);
  });
});
