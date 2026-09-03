import { describe, it, expect } from "vitest";
import { parseMatroska, forgetMatroskaHeader, clusterOffsetForTime, type MatroskaFile, type CuePoint } from "@/lib/webcodecs/matroska";

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

describe("le cache d'en-tête", () => {
  /** A source that counts how often it is read, so a second parse cannot hide. */
  function countingSource(bytes: Uint8Array) {
    let reads = 0;
    return {
      reads: () => reads,
      source: {
        size: bytes.length,
        read: async (offset: number, length: number) => {
          reads += 1;
          return bytes.subarray(offset, Math.min(offset + length, bytes.length));
        },
        close: () => {},
      },
    };
  }

  /** The smallest file parseMatroska accepts: an EBML header, a timestamp scale, one track. */
  const minimal = () =>
    new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, 0x18, 0x53, 0x80,
      0x67, 0xa1, 0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f,
      0x42, 0x40, 0x16, 0x54, 0xae, 0x6b, 0x90, 0xae, 0x8e, 0xd7, 0x81, 0x01,
      0x83, 0x81, 0x01, 0x86, 0x86, 0x56, 0x5f, 0x54, 0x45, 0x53, 0x54,
    ]);

  it("ne relit pas un fichier déjà connu", async () => {
    // The header and the index cost two round trips to opposite ends of the file, and they do not
    // change while it is being watched. That was paid again on every rebuild, which is exactly
    // when the viewer is least willing to wait.
    forgetMatroskaHeader("/film.mkv");
    const first = countingSource(minimal());
    await parseMatroska(first.source, "/film.mkv");
    expect(first.reads()).toBeGreaterThan(0);

    const second = countingSource(minimal());
    await parseMatroska(second.source, "/film.mkv");
    expect(second.reads()).toBe(0);

    forgetMatroskaHeader("/film.mkv");
  });

  it("n'invente rien quand on ne lui donne pas de nom", async () => {
    const a = countingSource(minimal());
    await parseMatroska(a.source);
    const b = countingSource(minimal());
    await parseMatroska(b.source);
    expect(b.reads()).toBeGreaterThan(0);
  });

  it("oublie ce qu'on lui dit d'oublier", async () => {
    forgetMatroskaHeader("/autre.mkv");
    const a = countingSource(minimal());
    await parseMatroska(a.source, "/autre.mkv");
    forgetMatroskaHeader("/autre.mkv");
    const b = countingSource(minimal());
    await parseMatroska(b.source, "/autre.mkv");
    expect(b.reads()).toBeGreaterThan(0);
  });
});
