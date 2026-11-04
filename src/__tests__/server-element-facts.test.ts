// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { elementFacts } from "@/components/player/server/serverLoadWatch";

/**
 * Le renoncement du lecteur serveur sur Safari dit où l'élément en était (05/11/2026) : les segments
 * du HLS natif ne paraissent pas dans les entrées de ressources — la reprise de *Terrifier* partie au
 * segment 822 ne se voyait qu'au journal du proxy.
 */
const ranges = (list: [number, number][]) => ({ length: list.length, start: (i: number) => list[i][0], end: (i: number) => list[i][1] }) as TimeRanges;

describe("elementFacts", () => {
  it("la position, ce qui est atteignable et chargé, l'état", () => {
    const video = { currentTime: 2466.04, seekable: ranges([[0, 4871]]), buffered: ranges([]), readyState: 1 } as unknown as HTMLVideoElement;
    expect(elementFacts(video)).toEqual({ elementAt: 2466, elementSeekable: "0.0–4871.0", elementBuffered: "vide", elementReadyState: 1 });
  });
  it("sans élément, ou s'il lève : rien", () => {
    expect(elementFacts(null)).toEqual({});
    const broken = { get currentTime(): number { throw new Error("démonté"); } } as unknown as HTMLVideoElement;
    expect(elementFacts(broken)).toEqual({});
  });
});
