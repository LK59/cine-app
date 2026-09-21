// Rebuilding decode timestamps from presentation timestamps.
//
// This is the hard part of turning Matroska into MP4, and it exists because the two formats
// disagree about what a timestamp is.
//
// H.264 and HEVC reorder pictures: a B-frame is decoded after the frames it references but shown
// between them. So every sample has two times — when it must be decoded (DTS) and when it must be
// shown (PTS). Matroska stores only the second one; MP4 requires both, DTS in the sample table
// and the difference as a per-sample composition offset.
//
// The reconstruction rests on one fact: samples are stored in decode order, and the set of decode
// times is the same set of values as the presentation times, only assigned in a different order.
// Sorting the presentation times of a group and handing them out in decode order therefore
// recovers the decode timeline exactly, for any reorder depth, without knowing anything about the
// codec's structure. A group is a segment, cut at a keyframe, which is where reordering cannot
// cross.
//
// Getting this wrong does not crash anything: it produces stutter, or audio drifting away from
// the picture. That is precisely why it is one small pure function with its own tests rather than
// something inlined in the muxer.

export interface TimedSample {
  /** Presentation time, in the muxer's timescale. */
  presentation: number;
  duration: number;
}

export interface OrderedSample {
  decode: number;
  /**
   * presentation - decode. Negative for a reordered picture, which is normal and is why the
   * muxer writes a version 1 trun: that version's composition offsets are signed.
   */
  compositionOffset: number;
  duration: number;
}

export interface OrderedGroup {
  samples: OrderedSample[];
  /**
   * What a caller that *cannot* emit signed composition offsets would have to add to every
   * presentation in this group to make them all non-negative.
   *
   * This muxer does not need it: signed offsets are written directly. It is kept because the
   * alternative is a trap worth naming — a caller taking that route must apply the same delay to
   * every other track, since delaying only the video moves the picture away from the sound by
   * exactly this much. That is the classic lip-sync error in a badly built remux, and using
   * signed offsets is precisely how this muxer avoids having to coordinate tracks at all.
   */
  presentationDelay: number;
  /** Where the next group's decode timeline must start. */
  endDecodeTime: number;
}

/**
 * @param samples in decode order — the order they appear in the file.
 * @param startDecodeTime the decode time this group must begin at, so groups join seamlessly.
 */
export function assignDecodeTimes(samples: TimedSample[], startDecodeTime: number): OrderedGroup {
  if (samples.length === 0) return { samples: [], presentationDelay: 0, endDecodeTime: startDecodeTime };

  const sortedPresentation = samples.map((s) => s.presentation).sort((a, b) => a - b);
  const origin = sortedPresentation[0];

  // The decode timeline is the presentation times sorted — that is the whole reconstruction —
  // rebased so this group starts exactly where the previous one ended.
  const decodeTimes: number[] = [];
  let previous = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    // Clamped: a file with duplicate or out-of-order timestamps would otherwise produce a decode
    // timeline that goes backwards, which no demuxer accepts.
    const decode = Math.max(startDecodeTime + (sortedPresentation[i] - origin), previous + 1);
    decodeTimes.push(decode);
    previous = decode;
  }

  const out: OrderedSample[] = samples.map((sample, i) => ({
    decode: decodeTimes[i],
    compositionOffset: startDecodeTime + (sample.presentation - origin) - decodeTimes[i],
    duration: sample.duration,
  }));

  // Reported, not applied. Note that no presentation can ever fall before the group's own first
  // decode time — that time is the smallest presentation in the group, by construction above —
  // so a negative offset never pushes a picture outside the fragment it belongs to.
  const delay = Math.max(0, ...out.map((sample) => -sample.compositionOffset));

  // The group ends one frame after its *last decoded* picture — and the duration to add is the
  // one belonging to the picture shown last, which in a reordered group is not the sample that
  // sits last in the file. With a constant frame rate the two are interchangeable, which is
  // exactly why picking the wrong one goes unnoticed until a file with uneven durations shows up
  // and every group after the first starts a millisecond off.
  let latest = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].presentation > samples[latest].presentation) latest = i;
  }

  return {
    samples: out,
    presentationDelay: delay,
    endDecodeTime: decodeTimes[decodeTimes.length - 1] + samples[latest].duration,
  };
}

/**
 * Per-sample durations from presentation times.
 *
 * Matroska rarely stores a duration for video blocks — the duration of a frame is implied by when
 * the next one is shown. The last sample of a group has no successor, so it inherits the group's
 * typical duration rather than being given a guess of zero, which some players render as a
 * dropped frame.
 */
export function deriveDurations(presentationTimes: number[], fallbackDuration: number): number[] {
  if (presentationTimes.length === 0) return [];

  // Sorted, because a duration is the distance to the next picture *shown*, not the next decoded.
  const sorted = [...presentationTimes].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) gaps.push(sorted[i + 1] - sorted[i]);

  const typical = gaps.length > 0 ? median(gaps) : fallbackDuration;
  const byPresentation = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    byPresentation.set(sorted[i], i < sorted.length - 1 ? sorted[i + 1] - sorted[i] : typical);
  }
  return presentationTimes.map((pts) => byPresentation.get(pts) ?? typical);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}
