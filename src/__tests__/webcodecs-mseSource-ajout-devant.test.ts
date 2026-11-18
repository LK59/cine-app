// @vitest-environment jsdom
/**
 * Un saut qui tombe juste avant le chargé (18/11/2026) : le chargé est gardé et seul ce qui manque
 * est lu devant lui — plus de vidage complet pour un « −10 s » qui manque l'image clé d'arrivée du
 * saut précédent de quelques secondes.
 *
 * Le modèle de webcodecs-mseSource.test.ts fait naître toute plage sous la tête et ne sait pas où
 * tombe un envoi ; celui-ci date chaque fragment (une image clé et un segment toutes les deux
 * secondes, décalage de présentation 0,2 s) et tient les plages de chaque tampon comme un
 * navigateur : réunies à l'envoi, découpées au retrait.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MseSource } from "@/lib/webcodecs/mseSource";
import type { Remuxer, RemuxPlan, RemuxSegment } from "@/lib/webcodecs/remuxer";
import { traceReset, traceText } from "@/lib/webcodecs/trace";
import { seekLineFields } from "@/components/player/nativeHostHelpers";
import { SessionTally } from "@/lib/playerSessionTally";

const DELAY = 0.2;
/** L'étendue (horloge du lecteur) de chaque morceau de média envoyé. */
const spans = new WeakMap<Uint8Array, [number, number]>();

let playhead = 0;
let source: FakeSource | null = null;
const live = new Set<FakeBuffer>();

class FakeBuffer extends EventTarget {
  halted = false;
  updating = false;
  mode = "segments";
  ranges: [number, number][] = [];
  appended: [number, number][] = [];
  removed: [number, number][] = [];
  constructor(readonly type: string) {
    super();
    live.add(this);
  }
  get buffered() {
    const r = this.ranges;
    return { length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] } as unknown as TimeRanges;
  }
  private finish() {
    queueMicrotask(() => {
      this.updating = false;
      if (!this.halted) this.dispatchEvent(new Event("updateend"));
    });
  }
  appendBuffer(data: Uint8Array) {
    if (this.updating) throw new DOMException("busy", "InvalidStateError");
    this.updating = true;
    const span = spans.get(data);
    if (span) {
      this.appended.push(span);
      const all = [...this.ranges, span].sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const [s, e] of all) {
        const last = merged[merged.length - 1];
        if (last && s <= last[1] + 1e-6) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
      }
      this.ranges = merged;
    }
    this.finish();
  }
  remove(start: number, end: number) {
    if (this.updating) throw new DOMException("busy", "InvalidStateError");
    this.updating = true;
    this.removed.push([start, end]);
    const kept: [number, number][] = [];
    for (const [s, e] of this.ranges) {
      if (e <= start || s >= end) kept.push([s, e]);
      else {
        if (s < start) kept.push([s, start]);
        if (e > end) kept.push([end, e]);
      }
    }
    this.ranges = kept;
    this.finish();
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
    source = this;
    queueMicrotask(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }
  addSourceBuffer(type: string) {
    const buffer = new FakeBuffer(type);
    this.buffers.push(buffer);
    return buffer as unknown as SourceBuffer;
  }
  removeSourceBuffer() {}
  endOfStream() {
    this.readyState = "ended";
  }
}

function intersection(): TimeRanges {
  const lists = (source?.buffers ?? []).map((b) => b.ranges);
  if (lists.length === 0 || lists.some((r) => r.length === 0)) return { length: 0 } as unknown as TimeRanges;
  let ranges = lists[0];
  for (const other of lists.slice(1)) {
    const next: [number, number][] = [];
    for (const [s, e] of ranges) for (const [os, oe] of other) if (Math.min(e, oe) > Math.max(s, os)) next.push([Math.max(s, os), Math.min(e, oe)]);
    ranges = next;
  }
  return { length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1] } as unknown as TimeRanges;
}

function fakeVideo() {
  playhead = 0;
  const target = new EventTarget();
  Object.defineProperty(target, "buffered", { get: intersection, configurable: true });
  Object.defineProperty(target, "currentTime", {
    get: () => playhead,
    set: (v: number) => void (playhead = v),
    configurable: true,
  });
  const state = { paused: false, seeking: false, readyState: 4 };
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    Object.defineProperty(target, key, { get: () => state[key], set: (v: never) => void (state[key] = v), configurable: true });
  }
  return Object.assign(target, {
    pause: () => void (state.paused = true),
    play: () => {
      state.paused = false;
      return Promise.resolve();
    },
    playbackRate: 1,
    disableRemotePlayback: false,
    srcObject: null as unknown,
    src: "",
    error: null,
    removeAttribute: () => {},
    load: () => {},
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 }),
  }) as unknown as HTMLVideoElement & { seeking: boolean };
}

const PLAN: RemuxPlan = {
  videoMimeType: 'video/mp4; codecs="hvc1.2.4.L150.90"',
  audioMimeType: 'audio/mp4; codecs="ec-3"',
  videoInit: new Uint8Array([1]),
  audioInit: new Uint8Array([2]),
  durationSeconds: 3600,
};

/**
 * Le remultiplexeur : une image clé et un segment toutes les deux secondes (horloge du fichier). Un
 * `seekTo` repart de l'image clé qui précède ; avec une borne, la lecture s'arrête juste avant la
 * première image clé à cette borne ou après — `stoppedShort` dès le dernier segment, puis null.
 */
function timedRemuxer() {
  let next = 0;
  let stopAt: number | null = null;
  let stopped = false;
  const seeks: [number, number | null][] = [];
  return {
    seeks,
    seekable: true,
    plan: () => PLAN,
    keyframeAtOrBefore: (s: number) => Math.floor(s / 2) * 2,
    keyframeAfter: (s: number) => Math.floor(s / 2) * 2 + 2,
    diagnostics: () => ({ presentationDelaySeconds: DELAY, clampedSamples: 0, segmentStartSeconds: next - 2 }),
    seekTo: (s: number, stop: number | null = null) => {
      seeks.push([s, stop]);
      next = Math.floor(s / 2) * 2;
      stopAt = stop;
      stopped = false;
    },
    get stoppedShort() {
      return stopped;
    },
    get stopAhead() {
      return stopAt !== null && !stopped;
    },
    nextSegment: async (): Promise<RemuxSegment | null> => {
      await new Promise((r) => setTimeout(r, 1));
      if (stopAt !== null && next >= stopAt) {
        stopped = true;
        return null;
      }
      if (next >= PLAN.durationSeconds) return null;
      const start = next;
      next += 2;
      const video = new Uint8Array([10]);
      const audio = new Uint8Array([20]);
      spans.set(video, [start + DELAY, start + 2 + DELAY]);
      spans.set(audio, [start + DELAY, start + 2 + DELAY]);
      // Comme le vrai : le groupe se ferme en lisant l'image clé de la borne, avant d'être rendu.
      if (stopAt !== null && next >= stopAt) stopped = true;
      return { video: [video], audio, subtitles: [], endSeconds: start + 2 };
    },
  } as unknown as Remuxer & { seeks: [number, number | null][] };
}

async function until(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`jamais arrivé : ${what}\n${traceText()}`);
}

/** Le geste du spectateur : l'élément part vers `to`, puis s'y pose quand le média le couvre. */
async function viewerSeeks(video: HTMLVideoElement & { seeking: boolean }, to: number) {
  playhead = to;
  video.seeking = true;
  video.dispatchEvent(new Event("seeking"));
  await until(() => covered(video.currentTime), `du média sous la tête à ${to} s`);
  video.seeking = false;
  video.dispatchEvent(new Event("seeked"));
}

const covered = (t: number) => {
  const r = intersection();
  for (let i = 0; i < r.length; i++) if (r.start(i) <= t && t < r.end(i)) return true;
  return false;
};

beforeEach(() => {
  traceReset();
  source = null;
  vi.stubGlobal("ManagedMediaSource", FakeSource);
  vi.stubGlobal("MediaSource", FakeSource);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
});
afterEach(() => {
  for (const b of live) b.halted = true;
  live.clear();
  vi.unstubAllGlobals();
});

describe("un saut juste avant le chargé", () => {
  /** Ouvert, sauté à 1001 s (image clé à 1000 s), joué jusqu'à 1005 s : le chargé commence à l'image clé d'arrivée. */
  async function afterASeek() {
    const video = fakeVideo();
    const remuxer = timedRemuxer();
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await until(() => intersection().length > 0, "le premier média");
    await mse.seek(1001);
    await until(() => covered(1029), "l'avance du saut à 1001 s");
    playhead = 1005;
    video.dispatchEvent(new Event("timeupdate"));
    await until(() => covered(1034), "l'avance depuis 1005 s");
    const [videoBuffer] = source!.buffers;
    expect(intersection().start(0)).toBeCloseTo(1000.2, 5);
    return { video, remuxer, mse, videoBuffer, keptBefore: videoBuffer.appended.length };
  }

  it("garde le chargé, ne lit que ce qui manque devant lui, et la tête va à la cible exacte", async () => {
    const { video, remuxer, mse, videoBuffer, keptBefore } = await afterASeek();
    videoBuffer.removed.length = 0;
    const seeksBefore = remuxer.seeks.length;

    // « −10 s » : 995 s, cinq secondes avant l'image clé d'arrivée (1000,2 s sur l'horloge du lecteur).
    await viewerSeeks(video, 995);
    await until(() => !mse.seekPending && covered(1020), "le raccord");
    await until(() => remuxer.seeks.length >= seeksBefore + 2, "la reprise au bout du chargé");

    // Pas de vidage : aucun retrait depuis 0 ; seule l'avance au-delà de celle d'un saut ordinaire
    // (cible + 30 s) est retirée.
    expect(videoBuffer.removed.some(([from]) => from === 0)).toBe(false);
    expect(videoBuffer.removed.every(([from]) => from >= 1025 - 1e-6)).toBe(true);
    // Lu depuis l'image clé d'avant la cible, borné juste après le début du chargé…
    expect(remuxer.seeks[seeksBefore][0]).toBeCloseTo(994.8, 5);
    expect(remuxer.seeks[seeksBefore][1]).toBeCloseTo(1000.5, 5);
    // … puis repris au bout de ce qui est gardé, sans borne.
    const [resume, resumeStop] = remuxer.seeks[seeksBefore + 1];
    expect(resume).toBeGreaterThanOrEqual(1024);
    expect(resumeStop).toBeNull();
    // Ce qui a été envoyé pour ce saut : l'écart et le premier groupe du chargé, rien de 1002,2 à 1024 s.
    const sent = videoBuffer.appended.slice(keptBefore);
    expect(sent.map(([s]) => s)).toEqual([994.2, 996.2, 998.2, 1000.2]);
    // Une seule plage, de l'image clé d'avant la cible à l'avance gardée ; la tête est à la cible.
    expect(intersection().length).toBe(1);
    expect(intersection().start(0)).toBeCloseTo(994.2, 5);
    expect(intersection().end(0)).toBeGreaterThanOrEqual(1024);
    expect(video.currentTime).toBe(995);
    expect(traceText()).toMatch(/ajout devant : la cible est à 5\.20 s du chargé/);
    // Pour la ligne `seek` : servi devant, 24,8 s d'avance gardées (1000,2 → 1025 s).
    expect(mse.seekPathFor(995)).toEqual({ target: 995, path: "devant", keptS: 24.8 });
    // Le seul vidage est celui du saut à 1001 s.
    expect(traceText().match(/vidage fait/g)).toHaveLength(1);
    mse.destroy();
  });

  it("trop loin avant le chargé (au-delà de la moitié de l'avance), c'est le saut ordinaire : tout est vidé", async () => {
    const { video, remuxer, mse, videoBuffer } = await afterASeek();
    videoBuffer.removed.length = 0;
    const seeksBefore = remuxer.seeks.length;

    await viewerSeeks(video, 980);
    await until(() => !mse.seekPending, "le saut");
    expect(videoBuffer.removed[0][0]).toBe(0);
    expect(remuxer.seeks[seeksBefore]).toEqual([979.8, null]);
    expect(mse.seekPathFor(980)).toEqual({ target: 980, path: "complet", keptS: null });
    expect(traceText()).toMatch(/vidage fait/);
    mse.destroy();
  });
});

describe("la ligne `seek` classe chaque saut", () => {
  const timing = (buffered: boolean, beforeStartS: number | null) => ({
    from: 1005,
    to: 995,
    startedAt: Date.now(),
    hiddenAtStart: 0,
    buffered,
    ranges: "1000.2–1035.0",
    beforeStartS,
  });

  it("devant : le chemin, l'écart au début du chargé et l'avance gardée", () => {
    const fields = seekLineFields(new SessionTally(), timing(false, 5.2), {}, { target: 995, path: "devant", keptS: 24.8 });
    expect(fields).toMatchObject({ buffered: false, seekPath: "devant", beforeStartS: 5.2, keptS: 24.8 });
  });

  it("complet sans plage après la cible : ni écart ni avance gardée", () => {
    const fields = seekLineFields(new SessionTally(), timing(false, null), {}, { target: 995, path: "complet", keptS: null });
    expect(fields.seekPath).toBe("complet");
    expect("beforeStartS" in fields).toBe(false);
    expect("keptS" in fields).toBe(false);
  });

  it("mémoire, et un saut que la source n'a pas servi n'a pas de chemin", () => {
    expect(seekLineFields(new SessionTally(), timing(true, null), {}, { target: 995, path: "mémoire", keptS: null }).seekPath).toBe("mémoire");
    expect("seekPath" in seekLineFields(new SessionTally(), timing(false, 5.2))).toBe(false);
  });

  it("dans le tampon, la source dit « mémoire »", async () => {
    const video = fakeVideo();
    const mse = await MseSource.attach(video, timedRemuxer(), PLAN, { onError: vi.fn() });
    await until(() => covered(20), "l'avance de l'ouverture");
    playhead = 10;
    video.dispatchEvent(new Event("seeking"));
    expect(mse.seekPathFor(10)).toEqual({ target: 10, path: "mémoire", keptS: null });
    mse.destroy();
  });
});
