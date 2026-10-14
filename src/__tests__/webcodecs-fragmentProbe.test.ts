import { describe, it, expect } from "vitest";
import { fragmentTimes } from "@/lib/webcodecs/fragmentProbe";
import { mediaSegment, type MuxTrackInfo } from "@/lib/webcodecs/mp4Muxer";

const track = { id: 1 } as MuxTrackInfo;

describe("fragmentTimes", () => {
  it("lit le numéro, le dts et le pts de la première image d'un fragment du muxer", () => {
    const fragment = mediaSegment(track, 812, [
      { data: new Uint8Array([1, 2]), decodeTime: 600_040_000, duration: 41_708, isKeyframe: true, compositionOffset: 83_416 },
      { data: new Uint8Array([3]), decodeTime: 600_081_708, duration: 41_708, isKeyframe: false, compositionOffset: -41_708 },
    ]);
    const times = fragmentTimes(fragment)!;
    expect(times.seq).toBe(812);
    expect(times.dts).toBeCloseTo(600.04, 6);
    expect(times.pts).toBeCloseTo(600.123416, 6);
  });

  it("répond null à ce qui n'est pas un fragment, sans lever", () => {
    expect(fragmentTimes(new Uint8Array([1]))).toBeNull();
    expect(fragmentTimes(new Uint8Array(0))).toBeNull();
    const fragment = mediaSegment(track, 1, [{ data: new Uint8Array([1]), decodeTime: 0, duration: 1, isKeyframe: true, compositionOffset: 0 }]);
    // Tronqué au milieu du moof.
    expect(fragmentTimes(fragment.subarray(0, 30))).toBeNull();
    // Une taille de boîte qui ment.
    const lying = fragment.slice();
    new DataView(lying.buffer).setUint32(0, 0xfffffff0);
    expect(fragmentTimes(lying)).toBeNull();
  });
});
