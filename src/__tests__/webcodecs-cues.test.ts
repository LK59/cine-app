import { describe, it, expect } from "vitest";
import { clusterOffsetForTime, type MatroskaFile, type CuePoint } from "@/lib/webcodecs/matroska";

// A cue point carries one set of positions per indexed track. They are not interchangeable: an
// audio entry marks where the sound can be picked up, which on a real 4K file turned out to be
// nowhere near a picture a decoder could start on — one seek in six landed somewhere the browser
// held media it could never show.

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;

function file(cues: CuePoint[]): MatroskaFile {
  return {
    timestampScaleNs: 1_000_000,
    durationSeconds: 3600,
    tracks: [],
    cues,
    segmentDataStart: 0,
    segmentEnd: 10_000_000,
    firstClusterOffset: 1000,
  };
}

const cue = (track: number, seconds: number, offset: number): CuePoint => ({
  track,
  timeUs: seconds * 1_000_000,
  clusterOffset: offset,
});

describe("clusterOffsetForTime", () => {
  it("follows the asked-for track's index and ignores the others", () => {
    const mixed = file([
      cue(VIDEO_TRACK, 0, 1000),
      cue(AUDIO_TRACK, 0, 1000),
      cue(VIDEO_TRACK, 10, 5000),
      // Interleaved between the video entries and closer to the target — this is the one that
      // used to win, purely by being written first in its cue point.
      cue(AUDIO_TRACK, 14, 7777),
      cue(VIDEO_TRACK, 20, 9000),
    ]);
    expect(clusterOffsetForTime(mixed, 15_000_000, VIDEO_TRACK)).toBe(5000);
    expect(clusterOffsetForTime(mixed, 15_000_000, AUDIO_TRACK)).toBe(7777);
  });

  it("lands at or before the requested time, never after it", () => {
    const cues = file([cue(VIDEO_TRACK, 0, 100), cue(VIDEO_TRACK, 30, 200), cue(VIDEO_TRACK, 60, 300)]);
    // A decoder starts at a keyframe and runs forward, so an index point after the target is
    // useless — there would be nothing to decode between the two.
    expect(clusterOffsetForTime(cues, 29_000_000, VIDEO_TRACK)).toBe(100);
    expect(clusterOffsetForTime(cues, 30_000_000, VIDEO_TRACK)).toBe(200);
    expect(clusterOffsetForTime(cues, 59_999_999, VIDEO_TRACK)).toBe(200);
  });

  it("falls back to whatever index exists rather than refusing to move", () => {
    // A file that indexes only its audio is still better served by that than by starting over.
    const audioOnly = file([cue(AUDIO_TRACK, 0, 100), cue(AUDIO_TRACK, 30, 200)]);
    expect(clusterOffsetForTime(audioOnly, 40_000_000, VIDEO_TRACK)).toBe(200);
  });

  it("starts at the beginning when there is no index at all", () => {
    expect(clusterOffsetForTime(file([]), 600_000_000, VIDEO_TRACK)).toBe(1000);
  });

  it("uses the earliest entry for a time before the first one", () => {
    const cues = file([cue(VIDEO_TRACK, 12, 400), cue(VIDEO_TRACK, 24, 800)]);
    expect(clusterOffsetForTime(cues, 3_000_000, VIDEO_TRACK)).toBe(400);
  });
});
