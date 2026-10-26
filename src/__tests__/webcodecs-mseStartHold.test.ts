// @vitest-environment jsdom
/**
 * Le départ d'une ouverture depuis le début, retenu jusqu'à la première image (26/10/2026,
 * `OpeningStartHold`).
 *
 * Le constat de production : un départ de 0 sur sept environ restait figé juste après avoir démarré
 * — l'élément, lancé avant le moindre média, jouait déjà quand l'atterrissage posait la tête à
 * 0,25 s (première image d'un fichier à images B à 0,21 s). Aucune reprise ne se figeait : leur tête
 * est posée avant le départ. Ici, la tête atterrit élément à l'arrêt, et le départ n'est permis
 * qu'avec l'image ; une borne le permet quand même si l'image ne s'annonce pas.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MseSource } from "@/lib/webcodecs/mseSource";
import { OpeningStartHold, START_HOLD_LANDED_MS, START_HOLD_MAX_MS } from "@/lib/webcodecs/mseStartHold";
import type { Remuxer, RemuxPlan, RemuxSegment } from "@/lib/webcodecs/remuxer";
import { traceReset, traceText } from "@/lib/webcodecs/trace";

// --- une MediaSource et un élément simulés, réduits à ce que l'ouverture traverse ---------------

/** Où commence le premier média : 0,21 s, la première image d'un fichier à images B. */
const FIRST_PICTURE = 0.21;
let sources: FakeSource[] = [];
const live = new Set<FakeBuffer>();

class FakeBuffer extends EventTarget {
  halted = false;
  updating = false;
  mode = "segments";
  ranges: [number, number][] = [];
  private initSeen = false;
  constructor(private readonly startsAt: () => number) {
    super();
    live.add(this);
  }
  get buffered() {
    const r = this.ranges;
    return { length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] } as unknown as TimeRanges;
  }
  appendBuffer() {
    this.updating = true;
    if (this.initSeen) {
      const start = this.ranges.length ? this.ranges[0][0] : this.startsAt();
      const end = (this.ranges.length ? this.ranges[0][1] : this.startsAt()) + 2;
      this.ranges = [[start, end]];
    }
    this.initSeen = true;
    queueMicrotask(() => {
      this.updating = false;
      if (!this.halted) this.dispatchEvent(new Event("updateend"));
    });
  }
  remove() {
    this.ranges = [];
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      if (!this.halted) this.dispatchEvent(new Event("updateend"));
    });
  }
  abort() {}
  changeType() {}
}

class FakeSource extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  readyState: "closed" | "open" | "ended" = "closed";
  duration = NaN;
  buffers: FakeBuffer[] = [];
  constructor() {
    super();
    sources.push(this);
    queueMicrotask(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }
  addSourceBuffer() {
    const buffer = new FakeBuffer(() => mediaStartsAt);
    this.buffers.push(buffer);
    return buffer as unknown as SourceBuffer;
  }
  removeSourceBuffer() {}
  endOfStream() {
    this.readyState = "ended";
  }
}
let mediaStartsAt = FIRST_PICTURE;

function playable(): TimeRanges {
  const lists = (sources[0]?.buffers ?? []).map((b) => b.ranges);
  if (lists.length === 0 || lists.some((r) => r.length === 0)) return { length: 0 } as unknown as TimeRanges;
  const start = Math.max(...lists.map((r) => r[0][0]));
  const end = Math.min(...lists.map((r) => r[0][1]));
  return { length: 1, start: () => start, end: () => end } as unknown as TimeRanges;
}

type Element = HTMLVideoElement & {
  state: { paused: boolean; seeking: boolean; readyState: number; time: number };
  moves: number[];
  play: ReturnType<typeof vi.fn>;
};

/**
 * Un élément à l'arrêt, comme après l'attache : rien ne l'a lancé. Écrire `currentTime` le met en
 * saut, comme un navigateur ; c'est le test qui dit quand le saut finit et ce qui est décodé.
 */
function fakeVideo(opts: { frames?: boolean } = {}): Element {
  const target = new EventTarget();
  const state = { paused: true, seeking: false, readyState: 1, time: 0 };
  const moves: number[] = [];
  Object.defineProperty(target, "buffered", { get: playable, configurable: true });
  Object.defineProperty(target, "currentTime", {
    get: () => state.time,
    set: (v: number) => {
      moves.push(v);
      state.time = v;
      state.seeking = true;
    },
    configurable: true,
  });
  for (const key of ["paused", "seeking", "readyState"] as const) {
    Object.defineProperty(target, key, { get: () => state[key], configurable: true });
  }
  const frames: (() => void)[] = [];
  return Object.assign(target, {
    state,
    moves,
    frames,
    play: vi.fn(() => {
      const was = state.paused;
      state.paused = false;
      if (was) target.dispatchEvent(new Event("play"));
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      state.paused = true;
    }),
    ...(opts.frames
      ? {
          requestVideoFrameCallback: (cb: () => void) => frames.push(cb),
          cancelVideoFrameCallback: () => {},
        }
      : {}),
    playbackRate: 1,
    disableRemotePlayback: false,
    srcObject: null as unknown,
    src: "",
    error: null,
    removeAttribute: () => {},
    load: () => {},
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 }),
  }) as unknown as Element;
}

const PLAN: RemuxPlan = {
  videoMimeType: 'video/mp4; codecs="hvc1.2.4.L150.90"',
  audioMimeType: 'audio/mp4; codecs="ec-3"',
  videoInit: new Uint8Array([1]),
  audioInit: new Uint8Array([2]),
  durationSeconds: 3600,
};

/** Deux secondes par segment ; `stall` : le premier segment n'arrive jamais. */
function fakeRemuxer(opts: { stall?: boolean } = {}) {
  let index = 0;
  const seeks: number[] = [];
  return {
    seeks,
    seekable: true,
    plan: () => PLAN,
    keyframeAtOrBefore: (s: number) => Math.floor(s / 2) * 2,
    diagnostics: () => ({ presentationDelaySeconds: 0.21, clampedSamples: 0 }),
    seekTo: (s: number) => {
      seeks.push(s);
      index = 0;
    },
    nextSegment: async (): Promise<RemuxSegment | null> => {
      if (opts.stall) return new Promise(() => {});
      await new Promise((r) => setTimeout(r, 5));
      if (index >= 40) return null;
      index += 1;
      return { video: [new Uint8Array([10])], audio: new Uint8Array([20]), subtitles: [], endSeconds: index * 2 };
    },
  } as unknown as Remuxer & { seeks: number[] };
}

let mse: MseSource | null = null;
async function open(video: Element, start = 0, remuxer = fakeRemuxer(), startPaused = false) {
  mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() }, start, startPaused);
  return mse;
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await tick(5);
  }
  throw new Error(`Toujours faux après ${timeoutMs} ms : ${what}`);
}
/** Ce que fait un navigateur à la fin d'un saut : l'image de la position est là, puis `seeked`. */
function seekDone(video: Element, readyState = 2) {
  video.state.seeking = false;
  video.state.readyState = readyState;
  video.dispatchEvent(new Event("seeked"));
}
function settled(promise: Promise<void> | null) {
  const out = { done: false };
  void promise?.then(() => (out.done = true));
  return out;
}

beforeEach(() => {
  traceReset();
  sources = [];
  mediaStartsAt = FIRST_PICTURE;
  vi.stubGlobal("ManagedMediaSource", FakeSource);
  vi.stubGlobal("MediaSource", FakeSource);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
});
afterEach(() => {
  mse?.destroy();
  mse = null;
  for (const buffer of live) buffer.halted = true;
  live.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MseSource — le départ d'une ouverture depuis le début attend sa première image", () => {
  it("pose la tête élément à l'arrêt, sans le lancer, et ne permet le départ qu'avec l'image", async () => {
    const video = fakeVideo();
    const source = await open(video);
    const hold = source.openingHold();
    expect(hold).not.toBeNull();
    const state = settled(hold);

    // Le premier média arrive à 0,21 s : la tête y atterrit, l'élément toujours à l'arrêt.
    await until(() => video.moves.length > 0, "l'atterrissage");
    expect(video.moves[0]).toBeGreaterThan(FIRST_PICTURE);
    expect(video.moves[0]).toBeLessThan(FIRST_PICTURE + 0.1);
    expect(video.state.paused).toBe(true);
    // D'autres segments arrivent : la garde ne relance pas le départ elle-même (`mediaArrived`).
    await until(() => (sources[0]?.buffers[0]?.ranges[0]?.[1] ?? 0) > 6, "quelques segments de plus");
    await tick(150);
    expect(video.play).not.toHaveBeenCalled();
    expect(state.done).toBe(false);
    // Ni la position redemandée de l'ouverture : elle relancerait le saut qu'on attend.
    expect(video.moves).toHaveLength(1);

    // Le saut d'atterrissage finit, l'image est décodée : le départ est permis.
    seekDone(video);
    await tick();
    expect(state.done).toBe(true);
    expect(source.openingHold()).toBeNull();
    expect(traceText()).toContain("ouverture : départ permis (image prête)");
    // Et c'est l'hôte qui lance — la source ne l'a toujours pas fait.
    expect(video.play).not.toHaveBeenCalled();
  });

  it("un seeked sans image décodée ne suffit pas ; l'image qui arrive ensuite, si (canplay)", async () => {
    const video = fakeVideo();
    const source = await open(video);
    const state = settled(source.openingHold());
    await until(() => video.moves.length > 0, "l'atterrissage");
    seekDone(video, 1);
    await tick();
    expect(state.done).toBe(false);
    video.state.readyState = 3;
    video.dispatchEvent(new Event("canplay"));
    await tick();
    expect(state.done).toBe(true);
  });

  it("l'image présentée (requestVideoFrameCallback) permet aussi le départ", async () => {
    const video = fakeVideo({ frames: true });
    const source = await open(video);
    const state = settled(source.openingHold());
    await until(() => video.moves.length > 0, "l'atterrissage");
    const frames = (video as unknown as { frames: (() => void)[] }).frames;
    expect(frames.length).toBe(1);
    // Présentée pendant le saut : encore celle d'avant, on attend la suivante.
    frames.shift()!();
    await tick();
    expect(state.done).toBe(false);
    expect(frames.length).toBe(1);
    video.state.seeking = false;
    frames.shift()!();
    await tick();
    expect(state.done).toBe(true);
    expect(traceText()).toContain("départ permis (image présentée)");
  });

  it("sans image annoncée, le départ est permis quand même au bout de la borne courte — et la position redemandée revient", async () => {
    const video = fakeVideo();
    const source = await open(video);
    const state = settled(source.openingHold());
    await until(() => video.moves.length > 0, "l'atterrissage");
    await tick(START_HOLD_LANDED_MS - 200);
    expect(state.done).toBe(false);
    await until(() => state.done, "la borne courte", 1000);
    expect(traceText()).toContain(`pas d'image ${START_HOLD_LANDED_MS} ms après l'atterrissage`);
    // L'hôte lance alors l'élément, toujours en saut : la position redemandée de l'ouverture, qui
    // n'avait pas été armée pendant la retenue, l'est maintenant — le départ d'avant, filet compris.
    await video.play();
    await until(() => video.moves.length > 1, "la position redemandée", 1000);
    expect(video.moves[1]).toBeCloseTo(video.moves[0] + 0.08, 5);
  });

  it("un élément lancé par quelqu'un d'autre (le spectateur) lève la retenue", async () => {
    const video = fakeVideo();
    const source = await open(video);
    const state = settled(source.openingHold());
    await video.play();
    await tick();
    expect(state.done).toBe(true);
    expect(traceText()).toContain("départ permis (élément déjà lancé)");
  });

  it("la source détruite résout la promesse, pour que l'hôte n'attende jamais pour rien", async () => {
    const video = fakeVideo();
    const source = await open(video);
    const state = settled(source.openingHold());
    source.destroy();
    await tick();
    expect(state.done).toBe(true);
    expect(traceText()).not.toContain("départ permis");
  });

  it("une reprise ne retient rien : pas de promesse, l'hôte lance comme avant", async () => {
    mediaStartsAt = 1200;
    const video = fakeVideo();
    const remuxer = fakeRemuxer();
    const source = await open(video, 1200, remuxer);
    expect(remuxer.seeks).toEqual([1200]);
    expect(source.openingHold()).toBeNull();
  });

  it("une ouverture laissée à l'arrêt (changement de piste en pause) ne retient rien non plus", async () => {
    const video = fakeVideo();
    const source = await open(video, 0, fakeRemuxer(), true);
    expect(source.openingHold()).toBeNull();
  });
});

describe("OpeningStartHold — la borne longue", () => {
  it("sans aucun média, le départ est permis au bout de START_HOLD_MAX_MS", async () => {
    vi.useFakeTimers();
    const video = fakeVideo();
    const released = vi.fn();
    const hold = new OpeningStartHold({ video, headOnMedia: () => false, released });
    const state = settled(hold.released);
    await vi.advanceTimersByTimeAsync(START_HOLD_MAX_MS - 1);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.done).toBe(true);
    expect(released).toHaveBeenCalledWith(true);
    expect(hold.holding).toBe(false);
  });

  it("permis une fois, les écouteurs sont retirés et rien ne se redéclare", async () => {
    const video = fakeVideo();
    const released = vi.fn();
    const hold = new OpeningStartHold({ video, headOnMedia: () => true, released });
    video.state.readyState = 2;
    video.dispatchEvent(new Event("loadeddata"));
    expect(released).toHaveBeenCalledWith(false);
    video.dispatchEvent(new Event("canplay"));
    hold.check();
    hold.destroy();
    expect(released).toHaveBeenCalledTimes(1);
  });
});
