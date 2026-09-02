// Assembles the two kinds of thing a MediaSource is fed: an initialisation segment that describes
// a track, and media segments carrying its samples.
//
// Each segment holds exactly one track. Video and audio therefore go to separate source buffers,
// which is how hls.js does it and what makes switching audio language cheap: the audio buffer is
// re-initialised and refilled while the video buffer is never touched, so the picture does not
// stop. Interleaving both into one segment would mean rebuilding everything on every switch.

import {
  box, concat, fullBox, i32, u16, u32, u64, u8, zeros, UNITY_MATRIX,
} from "./mp4Boxes";

/** The movie header's own clock. Track samples keep their native timescale; only the shell uses this. */
const MOVIE_TIMESCALE = 1000;

export interface MuxTrackInfo {
  id: number;
  kind: "video" | "audio";
  /** The clock the sample times below are expressed in — 1/90000 s for video, the rate for audio. */
  timescale: number;
  /** From mp4SampleEntries: the hvc1 / avc1 / mp4a / ec-3 box describing how to decode the bytes. */
  sampleEntry: Uint8Array;
  width: number;
  height: number;
  /** ISO-639-2, three letters. Anything else is written as "und". */
  language: string;
}

export interface MuxSample {
  data: Uint8Array;
  /** Authoritative: the segment's written durations are derived from these, not the other way. */
  decodeTime: number;
  /** Used only for the last sample of a segment, which has no next decode time to measure against. */
  duration: number;
  /**
   * How much later than its decode time the frame is shown. Negative for a reordered picture,
   * which the version 1 trun below writes as a signed value.
   */
  compositionOffset: number;
  isKeyframe: boolean;
}

/** Three letters at five bits each, biased so that 'a' is 1. */
function packLanguage(language: string): number {
  const code = /^[a-z]{3}$/.test(language) ? language : "und";
  return ((code.charCodeAt(0) - 0x60) << 10) | ((code.charCodeAt(1) - 0x60) << 5) | (code.charCodeAt(2) - 0x60);
}

function mvhd(durationSeconds: number): Uint8Array {
  return fullBox("mvhd", 0, 0,
    u32(0), u32(0), // created, modified
    u32(MOVIE_TIMESCALE),
    // Zero, deliberately: the real length lives in mehd and in the MediaSource's own duration.
    // Two places claiming a duration that disagree is worse than one place saying "ask elsewhere".
    u32(0),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    u16(0), u32(0), u32(0), // reserved
    UNITY_MATRIX,
    zeros(24), // pre-defined
    u32(0xffffffff) // next track id: none to allocate, this movie is closed
  );
}

function tkhd(track: MuxTrackInfo): Uint8Array {
  const isVideo = track.kind === "video";
  return fullBox("tkhd", 0, 0x000007, // enabled, in movie, in preview
    u32(0), u32(0),
    u32(track.id),
    u32(0), // reserved
    u32(0), // duration, deferred to mehd as above
    u32(0), u32(0), // reserved
    u16(0), // layer
    u16(0), // alternate group
    u16(isVideo ? 0 : 0x0100), // volume applies to sound only
    u16(0), // reserved
    UNITY_MATRIX,
    u32(isVideo ? track.width * 65536 : 0), // 16.16 fixed point
    u32(isVideo ? track.height * 65536 : 0)
  );
}

function mdia(track: MuxTrackInfo): Uint8Array {
  const isVideo = track.kind === "video";
  const handlerName = isVideo ? "VideoHandler" : "SoundHandler";

  const mdhd = fullBox("mdhd", 0, 0,
    u32(0), u32(0),
    u32(track.timescale),
    u32(0), // duration
    u16(packLanguage(track.language)),
    u16(0) // pre-defined
  );

  const hdlr = fullBox("hdlr", 0, 0,
    u32(0), // pre-defined
    new TextEncoder().encode(isVideo ? "vide" : "soun"),
    u32(0), u32(0), u32(0), // reserved
    new TextEncoder().encode(handlerName), u8(0)
  );

  // The media header is per-kind, and using the wrong one is rejected outright by strict parsers.
  const mediaHeader = isVideo
    ? fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)) // graphics mode copy, opcolor black
    : fullBox("smhd", 0, 0, u16(0), u16(0)); // balance centre

  // Declares that the media lives in this same file rather than in a referenced one.
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));

  // A fragmented file carries no sample tables in the moov: every one of these is deliberately
  // empty, and the real tables arrive inside each fragment's trun.
  const stbl = box("stbl",
    fullBox("stsd", 0, 0, u32(1), track.sampleEntry),
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0), u32(0)),
    fullBox("stco", 0, 0, u32(0))
  );

  return box("mdia", mdhd, hdlr, box("minf", mediaHeader, dinf, stbl));
}

export function initSegment(track: MuxTrackInfo, durationSeconds: number): Uint8Array {
  const ftyp = box("ftyp",
    new TextEncoder().encode("iso5"),
    u32(1), // minor version
    new TextEncoder().encode("iso5"),
    new TextEncoder().encode("iso6"),
    new TextEncoder().encode("mp41")
  );

  // mehd is where the total length is stated once. version 1 so a long film cannot overflow it.
  const mehd = fullBox("mehd", 1, 0, u64(Math.round(durationSeconds * MOVIE_TIMESCALE)));
  const trex = fullBox("trex", 0, 0,
    u32(track.id),
    u32(1), // sample description index
    u32(0), u32(0), u32(0) // no defaults: every fragment states its samples in full
  );

  return concat(ftyp, box("moov", mvhd(durationSeconds), box("trak", tkhd(track), mdia(track)), box("mvex", mehd, trex)));
}

/**
 * The 32-bit sample flags field. Only two of its sub-fields carry meaning for us, but a decoder
 * uses them to decide what it may discard when seeking, so getting the sync flag wrong turns a
 * seek into a block of corrupt frames.
 */
function sampleFlags(isKeyframe: boolean): Uint8Array {
  return isKeyframe
    ? u32(0x02000000) // depends on nothing, is a sync sample
    : u32(0x01010000); // depends on others, is not a sync sample
}

export function mediaSegment(track: MuxTrackInfo, sequenceNumber: number, samples: MuxSample[]): Uint8Array {
  if (samples.length === 0) throw new Error("Segment média vide.");

  // A trun does not store decode times. Only the first one is written, in tfdt; every later one
  // is the running sum of the durations before it. So the duration a sample declares is not its
  // frame duration — it is the gap to the *next* decode time, and writing anything else quietly
  // bends the decode timeline away from the one the caller computed. The two are identical at a
  // constant frame rate, which is exactly why the difference stays invisible until a file with
  // uneven durations turns up.
  const perSample = concat(
    ...samples.flatMap((sample, index) => {
      const next = samples[index + 1];
      const duration = next ? Math.max(1, next.decodeTime - sample.decodeTime) : sample.duration;
      return [
        u32(duration),
        u32(sample.data.length),
        sampleFlags(sample.isKeyframe),
        i32(sample.compositionOffset),
      ];
    })
  );

  const buildMoof = (dataOffset: number) => {
    const traf = box("traf",
      // default-base-is-moof: sample positions are measured from the start of this moof, so the
      // segment is self-contained and can be appended at any point in any order.
      fullBox("tfhd", 0, 0x020000, u32(track.id)),
      fullBox("tfdt", 1, 0, u64(samples[0].decodeTime)),
      // Version 1: composition offsets are signed. A reordered picture is shown before a
      // picture decoded earlier, so its offset is genuinely negative. The alternative — version 0
      // and delaying the whole presentation timeline — only works if every track is delayed by
      // the same amount, and getting that wrong is a lip-sync error rather than a visible break.
      // data-offset, sample-duration, sample-size, sample-flags, composition-offset all present.
      fullBox("trun", 1, 0x000f01, u32(samples.length), i32(dataOffset), perSample)
    );
    return box("moof", fullBox("mfhd", 0, 0, u32(sequenceNumber)), traf);
  };

  // The offset has to point past the moof that contains it, so the moof is built once at the
  // right size to measure it, then again with the value filled in. Every field here is
  // fixed-width, so the second build is byte-for-byte the same length as the first.
  const moofLength = buildMoof(0).length;
  const moof = buildMoof(moofLength + 8);

  return concat(moof, box("mdat", ...samples.map((sample) => sample.data)));
}

export const __testing = { packLanguage, MOVIE_TIMESCALE };
