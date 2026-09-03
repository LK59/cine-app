import { describe, it, expect, vi } from "vitest";
import { PlaybackGuard, type GuardHost } from "@/lib/webcodecs/playbackGuard";

// The rules about the element's own clock, exercised directly rather than through everything that
// feeds it. Every one of them was measured on a device, and the comments in the guard say which —
// these say what would break if the rule went away.

function ranges(...spans: [number, number][]) {
  return {
    length: spans.length,
    start: (i: number) => spans[i][0],
    end: (i: number) => spans[i][1],
  } as unknown as TimeRanges;
}

function fakeVideo(at = 0) {
  const target = new EventTarget();
  return Object.assign(target, {
    currentTime: at,
    paused: false,
    playbackRate: 1,
    play: vi.fn(function (this: { paused: boolean }) {
      this.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(function (this: { paused: boolean }) {
      this.paused = true;
    }),
  }) as unknown as HTMLVideoElement & { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };
}

function build(options: { at?: number; playable?: TimeRanges; audio?: TimeRanges | null } = {}) {
  const video = fakeVideo(options.at ?? 0);
  const seeks: { at: number; because: string }[] = [];
  const targets: number[] = [];
  const host: GuardHost = {
    destroyed: false,
    delaySeconds: 0.2,
    playable: options.playable ?? ranges([0, 100]),
    audioRanges: options.audio === undefined ? ranges([0, 100]) : options.audio,
    seek: async (at, because) => void seeks.push({ at, because }),
    noteSeekTarget: (at) => void targets.push(at),
  };
  const starting: (number | null)[] = [];
  const guard = new PlaybackGuard(video, host, (at) => starting.push(at));
  return { guard, video, host, seeks, targets, starting };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PlaybackGuard", () => {
  it("remembers exactly where the picture stopped, and settles it at once", () => {
    // The element's clock does not stop where the button was pressed: the sound already handed to
    // the hardware plays out, and the clock follows the sound. Asking the element to be where it
    // already is runs the seek algorithm, which discards what is queued.
    const { guard, video } = build({ at: 12 });
    (video as unknown as { paused: boolean }).paused = true;
    guard.paused();

    expect(video.currentTime).toBe(12);
    expect(guard.debug["Dernière pause"]).toContain("12.000");
  });

  it("re-states the position only for a drift worth correcting, and only a few times", async () => {
    // Each re-statement runs the seek algorithm, and on iOS that re-renders the sound around the
    // position — audible, as a tenth of a second replayed. Once is the fix; every eighty
    // milliseconds for as long as the clock creeps is a stuck record.
    const { guard, video } = build({ at: 12 });
    (video as unknown as { paused: boolean }).paused = true;
    guard.paused();

    const assertions = () => Number(/recalé ×(\d+)/.exec(guard.debug["Dernière pause"])?.[1] ?? 0);
    // One already, made at the pause itself — that is the correction that works.
    expect(assertions()).toBe(1);

    // Below the threshold: left alone.
    (video as unknown as { currentTime: number }).currentTime = 12.1;
    await tick(200);
    expect(assertions()).toBe(1);

    // Above it, repeatedly: corrected, then it stops.
    for (let i = 0; i < 12; i++) {
      (video as unknown as { currentTime: number }).currentTime += 0.4;
      await tick(70);
    }
    expect(assertions()).toBeGreaterThan(1);
    expect(assertions()).toBeLessThanOrEqual(3);
    guard.destroy();
  });

  it("lets a resume land where the sound stopped rather than pulling it back", () => {
    // Measured: the picture freezes at the button, the sound the hardware held plays on for about
    // half a second, and the clock reports that at the moment of resuming. Nothing was skipped.
    const { guard, video, seeks } = build({ at: 12 });
    (video as unknown as { paused: boolean }).paused = true;
    guard.paused();

    (video as unknown as { currentTime: number }).currentTime = 12.49;
    (video as unknown as { paused: boolean }).paused = false;
    guard.playing();

    expect(video.currentTime).toBe(12.49);
    expect(seeks).toEqual([]);
  });

  it("puts the playhead back when the system reclaimed the position during the pause", () => {
    // A gap far larger than the drain is a real discontinuity: media the system took back while
    // nothing was playing, which runs to seconds.
    const { guard, video } = build({ at: 12 });
    (video as unknown as { paused: boolean }).paused = true;
    guard.paused();

    (video as unknown as { currentTime: number }).currentTime = 40;
    (video as unknown as { paused: boolean }).paused = false;
    guard.playing();

    expect(video.currentTime).toBe(12);
  });

  it("shows a wait when play is pressed, and lifts it when the clock moves", () => {
    const { guard, video, starting } = build({ at: 5 });
    guard.playing();
    expect(starting.at(-1)).toEqual(expect.any(Number));

    (video as unknown as { currentTime: number }).currentTime = 5.5;
    guard.clockTicked();
    expect(starting.at(-1)).toBeNull();
  });

  it("never leaves a wait behind when the source dies", () => {
    // A wait nobody will ever answer is a spinner for ever.
    const { guard, starting } = build({ at: 5 });
    guard.playing();
    guard.destroy();
    expect(starting.at(-1)).toBeNull();
  });

  it("steps onto media a seek produced after its target, and only while it has not moved", () => {
    // An index is not exact. Asking a file for 1568 s produced media beginning at 1570.6, and no
    // amount of waiting would ever make it cover 1568.
    const { guard, video } = build({ at: 100, playable: ranges([102.6, 130]) });
    (video as unknown as { paused: boolean }).paused = true;

    // Without a seek behind it, a gap that size is a hole and is left alone.
    guard.nudgeIntoBuffer();
    expect(video.currentTime).toBe(100);

    guard.seekServed(100);
    guard.nudgeIntoBuffer();
    // A hair inside the media, never exactly on its first instant — see LANDING_INSET.
    expect(video.currentTime).toBeCloseTo(102.64, 3);

    // The licence expires with the landing: a pause much later may not step eight seconds.
    (video as unknown as { currentTime: number }).currentTime = 110;
    guard.nudgeIntoBuffer();
    expect(video.currentTime).toBe(110);
  });

  it("closes a gap the size of the presentation delay while playing, and no more", () => {
    const near = build({ at: 100, playable: ranges([100.25, 130]) });
    near.guard.nudgeIntoBuffer();
    expect(near.video.currentTime).toBeCloseTo(100.29, 3);

    const far = build({ at: 100, playable: ranges([101.5, 130]) });
    far.guard.nudgeIntoBuffer();
    expect(far.video.currentTime).toBe(100);
  });

  it("starts a film the element gave up on, once there is something to play", async () => {
    // Measured on an iPhone opening an episode from the beginning. A file with B-frames presents
    // its first picture 210 ms in; play() was called before any of that existed, the element
    // abandoned the attempt and went back to paused with the playhead short of everything, and
    // the film then sat at 0:00 with thirty seconds buffered. Nothing could move it: the
    // playhead was not stepped onto the media because the element was paused, and the element
    // was paused because there was nothing under the playhead.
    const { guard, video } = build({ at: 0, playable: ranges([0.21, 30]) });
    guard.opened(0);

    guard.playing(); // the element fires this as soon as play() is called
    (video as unknown as { paused: boolean }).paused = true;
    (video as unknown as { currentTime: number }).currentTime = 0;
    guard.paused(); // and gives up a moment later, before any frame

    guard.mediaArrived();
    expect(video.currentTime).toBeCloseTo(0.25, 3);
    expect(video.play).toHaveBeenCalled();
  });

  it("does not start a film that played and was then stopped", async () => {
    // The film got as far as moving, so whoever stopped it meant to. Starting it again under
    // them would be the player arguing.
    const { guard, video } = build({ at: 5, playable: ranges([5, 30]) });
    guard.opened(5);
    (video as unknown as { currentTime: number }).currentTime = 12;
    (video as unknown as { paused: boolean }).paused = true;
    guard.paused();

    guard.mediaArrived();
    expect(video.play).not.toHaveBeenCalled();
  });

  it("stops insisting once opening is plainly over", async () => {
    // A viewer stopping a film that never started cannot be told apart from a start that failed,
    // so the window in which this may insist is the length of an opening and no longer.
    const { guard, video } = build({ at: 0, playable: ranges([0.21, 30]) });
    guard.opened(0);
    (video as unknown as { paused: boolean }).paused = true;
    (guard as unknown as { openedAt: number }).openedAt = Date.now() - 60_000;

    guard.mediaArrived();
    expect(video.play).not.toHaveBeenCalled();
  });

  it("starts a film whose element never even announced the attempt", async () => {
    // The case the first fix missed, and the one that kept turning up: when the refusal is
    // immediate there is no play event and therefore no pause event either, so waiting for that
    // pair to arrive is waiting for something that already did not happen.
    const { guard, video } = build({ at: 0, playable: ranges([0.21, 30]) });
    guard.opened(0);
    (video as unknown as { paused: boolean }).paused = true;

    guard.mediaArrived();
    expect(video.currentTime).toBeCloseTo(0.25, 3);
    expect(video.play).toHaveBeenCalled();
  });

  it("gives up asking rather than fighting an element that will not start", async () => {
    const { guard, video } = build({ at: 0, playable: ranges([0.21, 30]) });
    guard.opened(0);
    for (let attempt = 0; attempt < 5; attempt++) {
      guard.playing();
      (video as unknown as { paused: boolean }).paused = true;
      guard.paused();
      guard.mediaArrived();
    }
    expect((video.play as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("holds the picture only once it would run on without sound", async () => {
    // Chrome stalls by itself when a buffer has nothing at the playhead; Safari plays the picture
    // on in silence. Stopping the element up front cost the first a visible pause every time.
    const { guard, video } = build({ at: 10 });
    guard.beginAudioHold();
    await tick(100);
    expect(video.paused).toBe(false); // the sound still covers the playhead

    // Now it does not.
    (guard as unknown as { host: { audioRanges: TimeRanges | null } }).host.audioRanges = ranges([50, 60]);
    await tick(150);
    expect(video.paused).toBe(true);

    // A press of play into that gap is remembered, not obeyed.
    (video as unknown as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));
    expect(video.paused).toBe(true);

    guard.releaseAudioHold();
    expect(video.play).toHaveBeenCalled();
  });
});
