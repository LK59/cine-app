// @vitest-environment jsdom
/**
 * Empreinte de comportement — `MseSource`, la boucle qui remplit les tampons du lecteur natif.
 *
 * Une MediaSource et un élément simulés (le même modèle que webcodecs-mseSource.test.ts, réduit) qui
 * notent chaque opération dans l'ordre : tampons créés, ajouts (taille et premier octet), retraits,
 * `abort`, `changeType`, fin du flux, durée ; ordres à l'élément (horloge posée, pause, lecture) ;
 * demandes au remultiplexeur (`seekTo`, segments lus) ; rappels vers l'hôte (`onError`,
 * `onStarting`, `onStall`, `onWarning`) ; et la trace locale, ligne à ligne. Des séances écrites à la
 * main, puis des séances tirées d'une graine fixe : la même suite de gestes à chaque exécution.
 * Voir README.md de ce dossier.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installRecorder, type Recorder } from "./recorder";

const fil = vi.hoisted(() => ({ rec: null as null | { entries: unknown[][] } }));
const note = (...entry: unknown[]) => void fil.rec?.entries.push(entry);

vi.mock("@/lib/webcodecs/trace", async (original) => {
  const real = await original<typeof import("@/lib/webcodecs/trace")>();
  return {
    ...real,
    trace: (step: string) => {
      note("trace", step);
      real.trace(step);
    },
  };
});

import { MseSource } from "@/lib/webcodecs/mseSource";
import type { Remuxer, RemuxPlan, RemuxSegment } from "@/lib/webcodecs/remuxer";
import { traceReset } from "@/lib/webcodecs/trace";

// --- la MediaSource simulée ---------------------------------------------------------------------

let playhead = 0;
let sourceInstance: FakeSource | null = null;

class FakeBuffer extends EventTarget {
  static live = new Set<FakeBuffer>();
  halted = false;
  updating = false;
  mode = "segments";
  ranges: [number, number][] = [];
  initSeen = false;
  quotaOnNextAppend = false;
  failOnNextAppend = false;
  secondsPerAppend = 2;
  constructor(readonly name: string) {
    super();
    FakeBuffer.live.add(this);
  }
  private emit(type: string) {
    if (!this.halted) this.dispatchEvent(new Event(type));
  }
  get buffered() {
    const r = this.ranges;
    return { length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] } as unknown as TimeRanges;
  }
  private busy(what: string) {
    if (this.updating) throw new DOMException(`${what} while updating`, "InvalidStateError");
  }
  appendBuffer(data: Uint8Array) {
    this.busy("appendBuffer");
    if (this.quotaOnNextAppend) {
      this.quotaOnNextAppend = false;
      note("buffer", this.name, "append", data.byteLength, data[0], "QuotaExceededError");
      throw new DOMException("full", "QuotaExceededError");
    }
    note("buffer", this.name, "append", data.byteLength, data[0]);
    this.updating = true;
    if (this.initSeen) {
      const start = this.ranges.length ? this.ranges[0][0] : playhead;
      const end = (this.ranges.length ? this.ranges[0][1] : playhead) + this.secondsPerAppend;
      this.ranges = [[start, end]];
    }
    this.initSeen = true;
    queueMicrotask(() => {
      this.updating = false;
      if (this.failOnNextAppend) {
        this.failOnNextAppend = false;
        note("buffer", this.name, "error");
        this.emit("error");
      } else this.emit("updateend");
    });
  }
  remove(start: number, end: number) {
    this.busy("remove");
    note("buffer", this.name, "remove", round(start), round(end));
    const kept: [number, number][] = [];
    for (const [s, e] of this.ranges) {
      if (e <= start || s >= end) kept.push([s, e]);
      else {
        if (s < start) kept.push([s, start]);
        if (e > end) kept.push([end, e]);
      }
    }
    this.ranges = kept;
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.emit("updateend");
    });
  }
  abort() {
    note("buffer", this.name, "abort");
  }
  changeType(type: string) {
    this.busy("changeType");
    note("buffer", this.name, "changeType", type);
  }
}

class FakeSource extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  readyState: "closed" | "open" | "ended" = "closed";
  private _duration = NaN;
  buffers: FakeBuffer[] = [];
  constructor() {
    super();
    sourceInstance = this;
    note("source", "new");
    queueMicrotask(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }
  get duration() {
    return this._duration;
  }
  set duration(v: number) {
    note("source", "duration=", v);
    this._duration = v;
  }
  addSourceBuffer(type: string) {
    const name = type.startsWith("video") ? "vidéo" : "son";
    note("source", "addSourceBuffer", type);
    const buffer = new FakeBuffer(name);
    this.buffers.push(buffer);
    return buffer as unknown as SourceBuffer;
  }
  removeSourceBuffer(buffer: SourceBuffer) {
    note("source", "removeSourceBuffer", (buffer as unknown as FakeBuffer).name);
  }
  endOfStream() {
    if (this.buffers.some((b) => b.updating)) throw new DOMException("endOfStream while updating", "InvalidStateError");
    note("source", "endOfStream");
    this.readyState = "ended";
  }
}

const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n);

function intersection(): TimeRanges {
  const lists = (sourceInstance?.buffers ?? []).map((b) => b.ranges);
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
    set: (v: number) => {
      note("élément", "currentTime=", round(v));
      playhead = v;
    },
    configurable: true,
  });
  const state = { paused: false, seeking: false, readyState: 4 };
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    Object.defineProperty(target, key, { get: () => state[key], set: (v: never) => void (state[key] = v), configurable: true });
  }
  return Object.assign(target, {
    pause: () => {
      note("élément", "pause");
      state.paused = true;
    },
    play: () => {
      note("élément", "play");
      state.paused = false;
      return Promise.resolve();
    },
    playbackRate: 1,
    disableRemotePlayback: false,
    srcObject: null as unknown,
    src: "",
    error: null,
    removeAttribute: (name: string) => note("élément", "removeAttribute", name),
    load: () => note("élément", "load"),
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 }),
  }) as unknown as HTMLVideoElement;
}

const PLAN: RemuxPlan = {
  videoMimeType: 'video/mp4; codecs="hvc1.2.4.L150.90"',
  audioMimeType: 'audio/mp4; codecs="ec-3"',
  videoInit: new Uint8Array([1]),
  audioInit: new Uint8Array([2]),
  durationSeconds: 3600,
};

/** Le remultiplexeur : deux secondes par segment, une image clé toutes les deux secondes. */
function fakeRemuxer(segments = 2000, readMs = 40) {
  let index = 0;
  let from = 0;
  return {
    seekable: true,
    plan: () => PLAN,
    keyframeAtOrBefore: (s: number) => Math.floor(s / 2) * 2,
    diagnostics: () => ({ presentationDelaySeconds: 0.2, clampedSamples: 0 }),
    seekTo: (s: number) => {
      note("remuxer", "seekTo", round(s));
      from = Math.floor(s / 2);
      index = 0;
    },
    nextSegment: async (): Promise<RemuxSegment | null> => {
      await new Promise((r) => setTimeout(r, readMs));
      if (from + index >= segments) return null;
      index += 1;
      const n = from + index;
      return {
        video: [new Uint8Array(1000 + (n % 7)).fill(n % 256)],
        audio: new Uint8Array(100 + (n % 3)).fill((n + 100) % 256),
        subtitles: [{ track: 4, startSeconds: n * 2, endSeconds: n * 2 + 1.5, text: `ligne ${n}` }],
        endSeconds: n * 2,
      };
    },
  } as unknown as Remuxer;
}

let rec: Recorder;
let video: HTMLVideoElement;
let mse: MseSource | null = null;

const callbacks = () => ({
  onError: (message: string, kind?: string, facts?: Record<string, unknown>) => note("onError", message, kind ?? null, facts ? Object.keys(facts).sort() : null),
  onWarning: (w: { code: string }) => note("onWarning", w.code),
  onStarting: (at: number | null) => note("onStarting", at),
  onStall: (facts: Record<string, unknown>) => note("onStall", Object.keys(facts).sort()),
  onSubtitles: (cues: unknown[]) => note("onSubtitles", cues.length),
});

async function attach(start = 0, paused = false, remuxer = fakeRemuxer()) {
  video = fakeVideo();
  rec.step(`ouverture à ${start}${paused ? " en pause" : ""}`);
  const opening = MseSource.attach(video, remuxer, PLAN, callbacks(), start, paused);
  await rec.advance(0);
  mse = await opening;
  await rec.advance(500);
}
async function fire(type: string) {
  video.dispatchEvent(new Event(type));
  await rec.advance(0);
}
/** La lecture qui avance de `seconds`, un `timeupdate` par seconde. */
async function playFor(seconds: number) {
  for (let i = 0; i < seconds; i++) {
    await rec.advance(1000);
    if (!(video as unknown as { paused: boolean }).paused) playhead += 1;
    await fire("timeupdate");
  }
}
async function seek(to: number, waitMs = 400) {
  rec.step(`saut à ${to}`);
  const done = mse!.seek(to, "le viseur");
  (video as unknown as { seeking: boolean }).seeking = true;
  await fire("seeking");
  await rec.advance(waitMs);
  (video as unknown as { seeking: boolean }).seeking = false;
  await fire("seeked");
  await done;
  await rec.advance(0);
}
function summary() {
  const m = mse!;
  note("état", {
    lost: m.lost,
    seekPending: m.seekPending,
    position: round(m.position),
    lead: round(m.bufferedLead),
    delay: m.presentationDelay,
    buffers: sourceInstance?.buffers.map((b) => b.ranges.map(([s, e]) => [round(s), round(e)])),
  });
}

beforeEach(() => {
  traceReset();
  rec = installRecorder({ seed: 3 });
  fil.rec = rec;
  rec.entries.length = 0;
  sourceInstance = null;
  vi.stubGlobal("ManagedMediaSource", FakeSource);
  vi.stubGlobal("MediaSource", FakeSource);
  class BlobUrl extends URL {
    static createObjectURL = () => "blob:x";
    static revokeObjectURL = () => {};
  }
  vi.stubGlobal("URL", BlobUrl);
});
afterEach(() => {
  try {
    mse?.destroy();
  } catch {
    /* la destruction n'est pas examinée ici */
  }
  mse = null;
  for (const b of FakeBuffer.live) b.halted = true;
  FakeBuffer.live.clear();
  fil.rec = null;
  rec.uninstall();
});

describe("empreinte — MseSource", () => {
  it("ouverture, remplissage, lecture d'une minute (retrait derrière), destruction", async () => {
    await attach(0);
    await fire("playing");
    summary();
    await playFor(60);
    summary();
    rec.step("destruction");
    mse!.destroy();
    await rec.advance(0);
    await rec.fingerprint("mse");
  });

  it("reprise à 1200 en pause, lecture, sauts (dont un remplacé), fin du fichier", async () => {
    await attach(1200, true, fakeRemuxer(660));
    summary();
    await fire("play");
    await fire("playing");
    await playFor(10);
    await seek(600);
    summary();
    rec.step("saut remplacé");
    const first = mse!.seek(900, "le viseur");
    await rec.advance(50);
    await seek(1300);
    await first;
    summary();
    await playFor(30);
    summary();
    await rec.fingerprint("mse");
  });

  it("tampon plein (quota), échec d'ajout, source fermée", async () => {
    await attach(0);
    await fire("playing");
    await playFor(20);
    rec.step("quota");
    sourceInstance!.buffers[0].quotaOnNextAppend = true;
    await playFor(10);
    summary();
    rec.step("ajout refusé");
    sourceInstance!.buffers[0].failOnNextAppend = true;
    await playFor(10);
    summary();
    rec.step("source fermée");
    sourceInstance!.readyState = "closed";
    sourceInstance!.dispatchEvent(new Event("sourceclose"));
    await rec.advance(1000);
    summary();
    await rec.fingerprint("mse");
  });

  // Des séances tirées d'une graine fixe : la même suite de gestes à chaque exécution.
  it.each([1, 2, 3])("séance tirée de la graine %i", async (seed) => {
    let a = seed * 2654435761;
    const random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    await attach(Math.floor(random() * 3000));
    await fire("playing");
    for (let step = 0; step < 25; step++) {
      const r = random();
      if (r < 0.35) await playFor(1 + Math.floor(random() * 8));
      else if (r < 0.55) await seek(Math.floor(random() * 3500), Math.floor(random() * 600));
      else if (r < 0.65) {
        rec.step("pause");
        (video as unknown as { paused: boolean }).paused = true;
        await fire("pause");
        await rec.advance(Math.floor(random() * 5000));
      } else if (r < 0.75) {
        rec.step("lecture");
        (video as unknown as { paused: boolean }).paused = false;
        await fire("play");
        await fire("playing");
      } else if (r < 0.82) {
        rec.step("attente");
        await fire("waiting");
        await rec.advance(Math.floor(random() * 3000));
      } else if (r < 0.88) {
        rec.step("quota");
        sourceInstance!.buffers[Math.floor(random() * 2)].quotaOnNextAppend = true;
        await playFor(2);
      } else if (r < 0.92) {
        rec.step("retour au réseau");
        window.dispatchEvent(new Event("online"));
        await rec.advance(100);
      } else {
        await rec.advance(Math.floor(random() * 10_000));
      }
    }
    summary();
    await rec.fingerprint("mse");
  });
});
