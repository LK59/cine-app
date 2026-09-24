// @vitest-environment jsdom
//
// Fuzz du lecteur natif : des milliers de séquences aléatoires jouées sur MseSource, et des règles
// qui doivent toujours tenir.
//
// Les tests unitaires éprouvent un scénario à la fois, écrit à la main. Les défauts trouvés le
// 24/09/2026 étaient des enchaînements que personne n'avait écrits : une reprise demandée pendant
// une suspension, une relecture lancée pendant une attente réseau, un saut réveillé après une
// destruction. Ici, un générateur enchaîne au hasard sauts, pauses, coupures réseau, tampons
// pleins, source fermée par la plateforme et destruction, sur un faux navigateur plus fidèle que
// celui des tests unitaires : chaque segment porte sa vraie plage de temps, le tampon la garde, la
// retire et la réunit comme un SourceBuffer, un tampon trop plein est refusé, et la tête avance
// d'elle-même quand il y a du média sous elle.
//
// Enrichi le même jour d'un second flux d'actions : changement de piste audio (qui reconstruit),
// arrière-plan (plus de données voulues, source parfois reprise par iOS), élément qui échoue au
// décodage, éviction par la plateforme loin de la tête, tampon lent à digérer — et l'hôte qui
// reconstruit une source perdue, comme ExperimentalPlayerHost, trois fois au plus. Une règle de
// plus : depuis le dernier geste, la tête n'a bougé que par la lecture (« saut-perdu »).
//
// Sauté sans FUZZ. Voir /home/louis/cine-tests/fuzz/run.sh.
//   FUZZ=1 FUZZ_SEED=1234 FUZZ_RUNS=200 FUZZ_LOG=/logs/fuzz.jsonl npx vitest run fuzz.spec.ts

import { appendFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MseSource } from "@/lib/webcodecs/mseSource";
import { traceReset, traceText } from "@/lib/webcodecs/trace";
import type { Remuxer, RemuxPlan } from "@/lib/webcodecs/remuxer";

const RUNS = Number(process.env.FUZZ_RUNS ?? 100);
const BASE_SEED = Number(process.env.FUZZ_SEED ?? 1);
/** Une liste de graines à rejouer, à la place d'une plage : `FUZZ_SEEDS=12,345,6789`. */
const SEEDS = process.env.FUZZ_SEEDS ? process.env.FUZZ_SEEDS.split(",").map(Number) : null;
const LOG = process.env.FUZZ_LOG ?? "";
const DELAY = 0.2;
const GOP = 2;
const DURATION = 1800;
/** Au-delà, un SourceBuffer refuse : ce que Safari fait autour de 150 Mo de 4K. */
const QUOTA_SECONDS = 70;
/** Le pas du monde simulé : la moitié d'une seconde, deux tours du chien de garde du lecteur. */
const STEP_MS = 500;

/** Un générateur déterministe : une graine suffit à rejouer une séquence qui a échoué. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Un segment porte sa plage de temps (horloge du lecteur), comme un vrai fragment porte ses images. */
function encode(start: number, end: number): Uint8Array {
  return new Uint8Array(new Float64Array([start, end]).buffer);
}
function decode(data: Uint8Array): [number, number] | null {
  if (data.byteLength !== 16) return null; // un segment d'initialisation
  const f = new Float64Array(data.slice().buffer);
  return [f[0], f[1]];
}

type Ranges = [number, number][];
function union(ranges: Ranges, add: [number, number]): Ranges {
  const all = [...ranges, add].sort((a, b) => a[0] - b[0]);
  const out: Ranges = [];
  for (const [s, e] of all) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 0.05) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
function removeRange(ranges: Ranges, from: number, to: number): Ranges {
  const out: Ranges = [];
  for (const [s, e] of ranges) {
    if (e <= from || s >= to) out.push([s, e]);
    else {
      if (s < from) out.push([s, from]);
      if (e > to) out.push([to, e]);
    }
  }
  return out;
}
function covers(ranges: Ranges, t: number): boolean {
  return ranges.some(([s, e]) => s <= t + 0.01 && t < e);
}
function asTimeRanges(ranges: Ranges): TimeRanges {
  return { length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1] } as unknown as TimeRanges;
}
function intersect(a: Ranges, b: Ranges): Ranges {
  const out: Ranges = [];
  for (const [s1, e1] of a) for (const [s2, e2] of b) {
    const s = Math.max(s1, s2);
    const e = Math.min(e1, e2);
    if (e > s) out.push([s, e]);
  }
  return out;
}

/** Ce que le monde fait subir au lecteur pendant une séance. */
interface World {
  random: () => number;
  quotaStrict: boolean;
  networkFailures: number;
  slowReads: boolean;
  sourceClosed: boolean;
  destroyed: boolean;
  activityAfterDestroy: number;
  /** Ce qui a été touché après la destruction, pour le rapport. */
  activityLog: string[];
  /**
   * Le second flux de hasard, celui des actions ajoutées le 24/09/2026 (arrière-plan, éviction,
   * reconstruction…). Séparé du premier pour que les graines de régression, trouvées avant ces
   * actions, rejouent exactement la même séquence : elles tournent sans lui.
   */
  extra: () => number;
  /** Un SourceBuffer qui met des centaines de millisecondes à digérer chaque envoi — un vieil iPhone. */
  slowUpdates: boolean;
}

class FakeBuffer extends EventTarget {
  mode = "segments";
  updating = false;
  ranges: Ranges = [];
  constructor(private readonly world: World, private readonly owner: FakeSource) {
    super();
  }
  get buffered(): TimeRanges {
    if (this.owner.readyState === "closed") throw new DOMException("removed", "InvalidStateError");
    return asTimeRanges(this.ranges);
  }
  private busy(what: string) {
    if (this.world.destroyed || this.owner.retired) {
      this.world.activityAfterDestroy += 1;
      this.world.activityLog.push(`${what}${this.owner.retired ? " (source remplacée)" : ""}`);
    }
    if (this.owner.readyState === "closed") throw new DOMException(`${what}: source closed`, "InvalidStateError");
    if (this.updating) throw new DOMException(`${what} while updating`, "InvalidStateError");
  }
  private finish() {
    this.updating = true;
    const delay = this.world.slowUpdates
      ? 150 + Math.floor(this.world.extra() * 650)
      : this.world.random() < 0.3
        ? Math.floor(this.world.random() * 40)
        : 0;
    setTimeout(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    }, delay);
  }
  appendBuffer(data: Uint8Array) {
    this.busy("appendBuffer");
    const span = decode(data);
    if (span) {
      const held = this.ranges.reduce((n, [s, e]) => n + (e - s), 0);
      if (this.world.quotaStrict && held + (span[1] - span[0]) > QUOTA_SECONDS) {
        throw new DOMException("full", "QuotaExceededError");
      }
      this.ranges = union(this.ranges, span);
    }
    this.finish();
  }
  remove(from: number, to: number) {
    this.busy("remove");
    this.ranges = removeRange(this.ranges, from, to);
    this.finish();
  }
  abort() {}
  changeType() {}
}

class FakeSource extends EventTarget {
  static world: World;
  static isTypeSupported() {
    return true;
  }
  readyState: "closed" | "open" | "ended" = "closed";
  duration = NaN;
  streaming = true;
  buffers: FakeBuffer[] = [];
  /** Remplacée par une reconstruction : plus personne ne doit y toucher. */
  retired = false;
  constructor() {
    super();
    setTimeout(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    }, 1);
  }
  addSourceBuffer() {
    const buffer = new FakeBuffer(FakeSource.world, this);
    this.buffers.push(buffer);
    return buffer as unknown as SourceBuffer;
  }
  removeSourceBuffer() {}
  endOfStream() {
    if (this.readyState === "open") this.readyState = "ended";
  }
  /** La plateforme reprend la source — iOS en arrière-plan, un décodage refusé. */
  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("sourceclose"));
  }
  /** ManagedMediaSource : le système ne veut plus de données (arrière-plan, économie d'énergie). */
  stopStreaming() {
    if (!this.streaming) return;
    this.streaming = false;
    this.dispatchEvent(new Event("endstreaming"));
  }
  resumeStreaming() {
    if (this.streaming) return;
    this.streaming = true;
    this.dispatchEvent(new Event("startstreaming"));
  }
  /** La plateforme reprend de la mémoire : Safari évince du média loin de la tête, sans prévenir. */
  evict(from: number, to: number) {
    for (const buffer of this.buffers) if (!buffer.updating) buffer.ranges = removeRange(buffer.ranges, from, to);
  }
  playable(): Ranges {
    if (this.buffers.length === 0) return [];
    return this.buffers.slice(1).reduce((acc, b) => intersect(acc, b.ranges), this.buffers[0].ranges);
  }
}

/** Un élément vidéo qui joue ce qu'il a sous la tête, et résout ses sauts quand le média arrive. */
function fakeVideo(source: () => FakeSource | null) {
  const target = new EventTarget();
  let time = 0;
  const state = { paused: true, seeking: false, ended: false };
  const fire = (name: string) => queueMicrotask(() => target.dispatchEvent(new Event(name)));
  const playable = () => source()?.playable() ?? [];
  const video = Object.assign(target, {
    playbackRate: 1,
    networkState: 2,
    error: null,
    disableRemotePlayback: false,
    src: "",
    srcObject: null,
    removeAttribute: () => {},
    load: () => {},
    requestVideoFrameCallback: () => 0,
    cancelVideoFrameCallback: () => {},
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 }),
    play: () => {
      state.paused = false;
      fire("play");
      return Promise.resolve();
    },
    pause: () => {
      if (state.paused) return;
      state.paused = true;
      fire("pause");
    },
  });
  Object.defineProperties(video, {
    currentTime: {
      get: () => time,
      set: (v: number) => {
        time = Math.max(0, v);
        state.seeking = true;
        state.ended = false;
        fire("seeking");
      },
    },
    paused: { get: () => state.paused },
    seeking: { get: () => state.seeking },
    ended: { get: () => state.ended },
    readyState: { get: () => (covers(playable(), time) ? 4 : 1) },
    buffered: { get: () => asTimeRanges(playable()) },
  });
  /** Un quart de seconde du monde réel. */
  const tick = () => {
    const ranges = playable();
    if (state.seeking && covers(ranges, time)) {
      state.seeking = false;
      fire("seeked");
    }
    if (!state.paused && !state.seeking && covers(ranges, time)) {
      const run = ranges.find(([s, e]) => s <= time + 0.01 && time < e)!;
      time = Math.min(time + STEP_MS / 1000, run[1]);
      fire("timeupdate");
      if (time >= DURATION + DELAY - 0.05) {
        state.ended = true;
        state.paused = true;
        fire("ended");
      }
    }
  };
  return { video: video as unknown as HTMLVideoElement, tick, state };
}

function fakeRemuxer(world: World) {
  let position = 0;
  const remuxer = {
    seekable: true,
    reads: 0,
    /** Celui d'une séance remplacée par une reconstruction. */
    retired: false,
    plan: () => PLAN,
    diagnostics: () => ({ presentationDelaySeconds: DELAY, clampedSamples: 0, segmentStartSeconds: groupStart }),
    keyframeAfter: (s: number) => Math.floor(s / GOP) * GOP + GOP,
    seekTo: (s: number) => {
      if (world.destroyed || remuxer.retired) {
        world.activityAfterDestroy += 1;
        world.activityLog.push(`seekTo(${s})${remuxer.retired ? " (remultiplexeur remplacé)" : ""}`);
      }
      position = Math.max(0, Math.floor(s / GOP) * GOP);
    },
    nextSegment: async () => {
      if (world.destroyed || remuxer.retired) {
        world.activityAfterDestroy += 1;
        world.activityLog.push(`nextSegment${remuxer.retired ? " (remultiplexeur remplacé)" : ""}`);
      }
      remuxer.reads += 1;
      const wait = world.slowReads ? 200 + Math.floor(world.random() * 1500) : Math.floor(world.random() * 120);
      await new Promise((r) => setTimeout(r, wait));
      if (world.networkFailures > 0) {
        world.networkFailures -= 1;
        throw Object.assign(new Error("Load failed"), { network: true });
      }
      if (position >= DURATION) return null;
      groupStart = position;
      const start = position + DELAY;
      position += GOP;
      return { video: [encode(start, start + GOP)], audio: encode(start, start + GOP), subtitles: [], endSeconds: position };
    },
  };
  let groupStart = 0;
  return remuxer;
}

const PLAN: RemuxPlan = {
  videoMimeType: 'video/mp4; codecs="hvc1.2.4.L150.90"',
  audioMimeType: 'audio/mp4; codecs="ec-3"',
  videoInit: new Uint8Array([1]),
  audioInit: new Uint8Array([2]),
  durationSeconds: DURATION,
};

type Violation = { seed: number; rule: string; detail: string; steps: string[]; trace?: string[] };

/** Autant de reconstructions que l'hôte en accorde (`spendRebuild`) avant de passer la main. */
const REBUILDS = 3;

/**
 * Une séquence. `enriched` ajoute les actions du second flux de hasard ; les graines de régression
 * tournent sans, puisqu'elles ont été trouvées avant elles.
 */
async function oneRun(seed: number, enriched = true): Promise<Violation | null> {
  const random = rng(seed);
  const extraRandom = rng((seed ^ 0x9e3779b9) >>> 0);
  const world: World = {
    random,
    quotaStrict: random() < 0.5,
    networkFailures: 0,
    slowReads: false,
    sourceClosed: false,
    destroyed: false,
    activityAfterDestroy: 0,
    activityLog: [],
    extra: extraRandom,
    slowUpdates: false,
  };
  FakeSource.world = world;
  traceReset();
  let current = null as FakeSource | null;
  class Source extends FakeSource {
    constructor() {
      super();
      current = this;
    }
  }
  vi.stubGlobal("ManagedMediaSource", Source);
  vi.stubGlobal("MediaSource", Source);
  (globalThis as unknown as { window: { ManagedMediaSource: unknown } }).window.ManagedMediaSource = Source;
  vi.stubGlobal("URL", { createObjectURL: () => "blob:fuzz", revokeObjectURL: () => {} });

  const steps: string[] = [];
  // La trace du lecteur lui-même : qui a déplacé la tête, qui a relu, qui a repris.
  const violation = (rule: string, detail: string): Violation => ({
    seed,
    rule,
    detail,
    steps: steps.slice(-40),
    trace: traceText().split("\n").slice(-60),
  });
  const { video, tick, state } = fakeVideo(() => current);
  let remuxer = fakeRemuxer(world);
  let errors = 0;
  const errorReasons: string[] = [];
  const start = Math.floor(random() * 1200);
  const startPaused = random() < 0.2;
  steps.push(`ouverture à ${start}${startPaused ? " (en pause)" : ""}, quota ${world.quotaStrict ? "strict" : "large"}`);
  // Une erreur levée par une source perdue n'arrête pas la séance : l'hôte reconstruit
  // (ExperimentalPlayerHost, `remuxRef.current?.lost && spendRebuild()`). Le reste l'arrête.
  let live: MseSource | null = null;
  const handlers = {
    onError: (message: string, kind?: string) => {
      if (enriched && kind !== "network" && live?.lost) {
        steps.push(`erreur de source perdue : ${message.slice(0, 80)}`);
        return;
      }
      errors += 1;
      errorReasons.push(`${kind ?? "?"}: ${message.slice(0, 160)}`);
    },
    onWarning: () => {},
  };

  // L'ouverture a besoin que le temps avance (sourceopen, envois des segments d'initialisation) :
  // attendue sans faire tourner les minuteurs, elle ne finissait jamais.
  const open = async (at: number, paused: boolean): Promise<MseSource | Violation> => {
    let attached: MseSource | null = null;
    let attachError: unknown = null;
    MseSource.attach(video, remuxer as unknown as Remuxer, PLAN, handlers, at, paused).then(
      (m) => (attached = m),
      (e) => (attachError = e)
    );
    for (let i = 0; i < 400 && !attached && !attachError; i++) await vi.advanceTimersByTimeAsync(25);
    if (attachError) return violation("ouverture", attachError instanceof Error ? attachError.message : String(attachError));
    if (!attached) return violation("ouverture", "jamais ouverte en 10 s");
    return attached;
  };
  const opened = await open(start, startPaused);
  if (!(opened instanceof MseSource)) return opened;
  let mse = opened;
  live = mse;
  let internals = mse as unknown as { networkHold?: boolean };
  if (!startPaused) void video.play();

  // La dernière position demandée par le spectateur, et quand : après elle, la tête ne bouge plus
  // que par la lecture. Une tête derrière elle, ou loin devant, est un saut perdu ou inventé.
  let lastTarget = start;
  let lastTargetAt = Date.now();
  const aimed = (to: number) => {
    lastTarget = to;
    lastTargetAt = Date.now();
  };

  /**
   * Ce que fait l'hôte quand la source est perdue, ou quand on change de piste audio : tout
   * détruire et rouvrir à la position — sur le même élément, avec un remultiplexeur neuf.
   * Au-delà de REBUILDS, l'hôte passe au lecteur serveur : la séquence s'arrête là.
   */
  let rebuilds = 0;
  const rebuild = async (why: string): Promise<boolean> => {
    if (rebuilds >= REBUILDS) return false;
    rebuilds += 1;
    const at = mse.position;
    const paused = state.paused;
    steps.push(`reconstruction (${why}) à ${at.toFixed(1)}${paused ? " en pause" : ""}`);
    mse.destroy();
    if (current) current.retired = true;
    remuxer.retired = true;
    (video as unknown as { error: unknown }).error = null;
    remuxer = fakeRemuxer(world);
    const reopened = await open(at, paused);
    if (!(reopened instanceof MseSource)) throw reopened;
    mse = reopened;
    live = mse;
    internals = mse as unknown as { networkHold?: boolean };
    if (!paused) void video.play();
    return true;
  };

  let holdSince: number | null = null;
  const advance = async (ms: number) => {
    for (let t = 0; t < ms; t += STEP_MS) {
      tick();
      // Safari rend la main à la source quand ce qu'elle a d'avance s'épuise.
      if (current && !current.streaming) {
        const run = current.playable().find(([s, e]) => s <= video.currentTime + 0.01 && video.currentTime < e);
        if (!run || run[1] - video.currentTime < 3) current.resumeStreaming();
      }
      await vi.advanceTimersByTimeAsync(STEP_MS);
      if (internals.networkHold) {
        holdSince ??= Date.now();
        if (Date.now() - holdSince > 40_000) throw violation("verrou-réseau", "networkHold vrai depuis plus de 40 s");
      } else holdSince = null;
    }
  };

  /** Les actions du second flux. */
  const extraAction = async () => {
    const r = extraRandom();
    if (r < 0.2) {
      // Changer de piste audio reconstruit tout le lecteur (RemuxPlayback.requestAudioTrack).
      steps.push("changement de piste audio");
      if (!(await rebuild("piste audio"))) steps.push("plus de reconstruction accordée");
      await advance(250);
    } else if (r < 0.45) {
      // L'arrière-plan : le système ne veut plus de données, et iOS reprend souvent la source.
      const ms = 1000 * (2 + Math.floor(extraRandom() * 60));
      const killed = extraRandom() < 0.5;
      steps.push(`arrière-plan ${ms / 1000} s${killed ? ", source reprise" : ""}`);
      current?.stopStreaming();
      await advance(ms);
      if (killed) {
        current?.close();
        world.sourceClosed = true;
      }
      current?.resumeStreaming();
      await advance(250);
    } else if (r < 0.6) {
      // Un décodage refusé : l'élément échoue, et sa source se ferme avec lui.
      steps.push("l'élément échoue (décodage)");
      (video as unknown as { error: unknown }).error = { code: 3, message: "decode" };
      video.dispatchEvent(new Event("error"));
      current?.close();
      await advance(500);
    } else if (r < 0.8) {
      // L'éviction : du média loin de la tête disparaît, derrière ou devant.
      const head = video.currentTime;
      const behind = extraRandom() < 0.5;
      const [from, to] = behind ? [0, Math.max(0, head - 5)] : [head + 10 + extraRandom() * 20, DURATION + 10];
      steps.push(`éviction de ${from.toFixed(0)} à ${to.toFixed(0)}`);
      current?.evict(from, to);
      await advance(250);
    } else {
      world.slowUpdates = !world.slowUpdates;
      steps.push(`tampon ${world.slowUpdates ? "lent" : "normal"}`);
    }
  };

  try {
    const count = 20 + Math.floor(random() * 60);
    for (let i = 0; i < count && errors === 0; i++) {
      if (mse.lost) {
        if (!enriched || !(await rebuild("source perdue"))) break;
        continue;
      }
      if (enriched && extraRandom() < 0.15) {
        await extraAction();
        continue;
      }
      const r = random();
      if (r < 0.3) {
        const ms = 250 * (1 + Math.floor(random() * 20));
        steps.push(`attendre ${ms} ms`);
        await advance(ms);
      } else if (r < 0.5) {
        const to = Math.floor(random() * DURATION);
        steps.push(`saut vers ${to}`);
        (video as unknown as { currentTime: number }).currentTime = to;
        aimed(to);
        await advance(250);
      } else if (r < 0.58) {
        const to = Math.max(0, video.currentTime + (random() < 0.5 ? -10 : 10));
        steps.push(`saut relatif vers ${to.toFixed(1)}`);
        (video as unknown as { currentTime: number }).currentTime = to;
        aimed(to);
        await advance(250);
      } else if (r < 0.66) {
        steps.push(state.paused ? "lecture" : "pause");
        if (state.paused) void video.play();
        else video.pause();
        await advance(250);
      } else if (r < 0.76) {
        // Le plus souvent une ou deux lectures : ce qu'un redéploiement fait. Parfois plus.
        world.networkFailures += random() < 0.8 ? 1 + Math.floor(random() * 2) : 3 + Math.floor(random() * 4);
        steps.push(`coupure réseau (${world.networkFailures} lectures)`);
        await advance(250);
      } else if (r < 0.82) {
        world.slowReads = !world.slowReads;
        steps.push(`réseau ${world.slowReads ? "lent" : "normal"}`);
      } else if (r < 0.86) {
        world.quotaStrict = !world.quotaStrict;
        steps.push(`quota ${world.quotaStrict ? "strict" : "large"}`);
      } else if (r < 0.875) {
        steps.push("la plateforme ferme la source");
        current?.close();
        world.sourceClosed = true;
        await advance(1000);
      } else {
        const burst = 2 + Math.floor(random() * 5);
        const targets: string[] = [];
        for (let b = 0; b < burst; b++) {
          const to = Math.floor(random() * DURATION);
          const gap = Math.floor(random() * 120);
          targets.push(`${to}(+${gap}ms)`);
          (video as unknown as { currentTime: number }).currentTime = to;
          aimed(to);
          await vi.advanceTimersByTimeAsync(gap);
        }
        steps.push(`rafale de ${burst} sauts : ${targets.join(" ")}`);
        await advance(250);
      }
    }

    // Le calme : plus aucune panne, le spectateur regarde. Soit le film joue, soit le lecteur a dit
    // qu'il ne pouvait plus (erreur, source perdue) — jamais un lecteur qui attend pour toujours.
    world.networkFailures = 0;
    world.slowReads = false;
    world.slowUpdates = false;
    current?.resumeStreaming();
    if (enriched && errors === 0 && mse.lost) await rebuild("source perdue");
    if (errors === 0 && !mse.lost && !state.ended) {
      steps.push("calme : lecture sans panne pendant 45 s");
      void video.play();
      const before = video.currentTime;
      await advance(45_000);
      const moved = video.currentTime - before;
      if (errors === 0 && !mse.lost && !state.ended && moved < 5) {
        return violation(
          "lecture-bloquée",
          `45 s sans panne, la tête n'a avancé que de ${moved.toFixed(2)} s (à ${video.currentTime.toFixed(2)} s, ` +
            `seeking ${state.seeking}, média ${JSON.stringify(current?.playable().slice(0, 3))})`
        );
      }
      // Depuis le dernier geste, la tête n'a bougé que par la lecture : ni derrière la cible (au
      // plus une image clé avant elle), ni plus loin que le temps écoulé ne le permet.
      const played = (Date.now() - lastTargetAt) / 1000;
      const head = video.currentTime;
      if (errors === 0 && !mse.lost && !state.ended && (head < lastTarget - GOP - DELAY - 0.5 || head > lastTarget + played + 3)) {
        return violation(
          "saut-perdu",
          `dernière cible ${lastTarget.toFixed(1)} s il y a ${played.toFixed(1)} s, tête à ${head.toFixed(2)} s`
        );
      }
    }

    if (process.env.FUZZ_VERBOSE) {
      console.log(
        `graine ${seed} : ${steps.length} étapes, erreurs ${errors}, perdue ${mse.lost}, fin ${state.ended}, ` +
          `tête ${video.currentTime.toFixed(1)} s, lectures ${remuxer.reads}\n   ${errorReasons.join(" || ")}\n   ${steps.slice(-6).join(" ; ")}`
      );
    }
    // La destruction : plus rien ne doit toucher la source, les tampons ni le remultiplexeur.
    mse.destroy();
    world.destroyed = true;
    const readsAtDestroy = remuxer.reads;
    const lastRemuxer = remuxer;
    await advance(10_000);
    if (world.activityAfterDestroy > 0 || lastRemuxer.reads > readsAtDestroy) {
      return violation("activité-après-destruction", `${world.activityAfterDestroy} opérations (${world.activityLog.slice(0, 4).join(", ")}), ${lastRemuxer.reads - readsAtDestroy} lectures`);
    }
    return null;
  } catch (error) {
    if (error && typeof error === "object" && "rule" in error) return error as Violation;
    return violation("exception", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    try {
      mse.destroy();
    } catch {
      /* déjà détruite */
    }
  }
}

describe.skipIf(!process.env.FUZZ)("fuzz du lecteur", () => {
  it(`joue ${RUNS} séquences à partir de la graine ${BASE_SEED}`, { timeout: 3600_000 }, async () => {
    const unhandled: string[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason instanceof Error ? reason.message : String(reason));
    process.on("unhandledRejection", onUnhandled);
    let failures = 0;
    const seeds = SEEDS ?? Array.from({ length: RUNS }, (_, i) => BASE_SEED + i);
    for (const seed of seeds) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      let found = await oneRun(seed);
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      await new Promise((r) => setTimeout(r, 0));
      if (!found && unhandled.length > 0) {
        found = { seed, rule: "rejet-non-géré", detail: unhandled.join(" | "), steps: [] };
      }
      unhandled.length = 0;
      if (found) {
        failures += 1;
        if (LOG) appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind: "violation", ...found }) + "\n");
        else console.log(JSON.stringify(found));
      }
    }
    process.off("unhandledRejection", onUnhandled);
    if (LOG) appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind: "batch", seed: BASE_SEED, runs: seeds.length, failures }) + "\n");
  });
});

/**
 * Les séquences qui ont trouvé un défaut, rejouées à chaque vérification.
 *
 * Déterministes — une graine, la même séquence — et rapides : une fraction de seconde chacune. Elles
 * ne sont pas sautées : ce sont les seules à reproduire fidèlement les défauts qu'elles ont trouvés,
 * là où un test unitaire écrit à la main passait avec ou sans correctif.
 *  - 30054481 : un saut dans une zone encore chargée pendant qu'un autre était servi était perdu.
 *  - 30063323 : le jeton « déplacement de la source », posé dès le service d'un saut, faisait
 *    ignorer un retour du spectateur à la même position pendant l'attente de la lecture en cours.
 *
 * Celles du second flux (`enriched`) dépendent des actions qu'il connaissait le 24/09/2026 : en
 * ajouter une change leurs séquences. Rejouer alors la graine avec l'ancien correctif retiré, et la
 * remplacer par une nouvelle trouvée par le fuzz si elle ne reproduit plus.
 *  - 900841, 901806 : un geste arrivé pendant le vidage des tampons d'un saut en cours était écrasé
 *    par la cible de ce saut ; une source perdue juste après faisait reconstruire à l'ancienne
 *    position — 930 s en arrière pour la première.
 *  - 900025 : un retrait mis en file par un saut s'exécutait sur le tampon d'une source détruite par
 *    une reconstruction.
 *  - 20124805 : l'ouverture différée posait le jeton « déplacement de la source » sans écrire la
 *    tête ; un spectateur qui sautait puis revenait à la position d'ouverture était ignoré.
 */
const REGRESSION_SEEDS: { seed: number; enriched: boolean }[] = [
  { seed: 30054481, enriched: false },
  { seed: 30063323, enriched: false },
  { seed: 900841, enriched: true },
  { seed: 901806, enriched: true },
  { seed: 900025, enriched: true },
  { seed: 20124805, enriched: true },
];

describe("fuzz du lecteur — graines de régression", () => {
  for (const { seed, enriched } of REGRESSION_SEEDS) {
    it(`graine ${seed}`, { timeout: 60_000 }, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      try {
        const found = await oneRun(seed, enriched);
        expect(found).toBeNull();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    });
  }
});
