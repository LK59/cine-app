import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { OfflineEngine } from "@/lib/offline/offlineEngine";

/**
 * Le moteur du lecteur hors ligne face aux sauts rapides (relecture du 19/10/2026) : deux appuis sur
 * +10 s faisaient vider le tampon pendant qu'un ajout courait — le navigateur lève alors
 * `InvalidStateError`, et la lecture s'arrêtait sur « Lecture impossible ». Le faux tampon ci-dessous
 * refuse exactement ce que refuse un vrai : toute opération pendant qu'une autre est en cours.
 */

const file = new Uint8Array(fs.readFileSync(path.join(process.cwd(), "src/__tests__/fixtures/offline/jellyfin-like.mp4")));

class FakeSourceBuffer extends EventTarget {
  updating = false;
  ops: string[] = [];
  private run(name: string) {
    if (this.updating) throw new DOMException(`${name} pendant une opération`, "InvalidStateError");
    this.updating = true;
    this.ops.push(name);
    setTimeout(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    }, 3);
  }
  appendBuffer() {
    this.run("append");
  }
  remove() {
    this.run("remove");
  }
}

let buffer: FakeSourceBuffer;
class FakeMediaSource extends EventTarget {
  readyState = "open";
  duration = NaN;
  static isTypeSupported = () => true;
  constructor() {
    super();
    setTimeout(() => this.dispatchEvent(new Event("sourceopen")), 0);
  }
  addSourceBuffer() {
    buffer = new FakeSourceBuffer();
    return buffer;
  }
  endOfStream() {
    this.readyState = "ended";
  }
}

function fakeVideo() {
  const video = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(video, {
    currentTime: 0,
    seeking: false,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    srcObject: null,
    disableRemotePlayback: false,
    removeAttribute: () => {},
    load: () => {},
  });
  return video as unknown as HTMLVideoElement;
}

afterEach(() => vi.unstubAllGlobals());

describe("OfflineEngine", () => {
  it("des sauts rapides passent un par un : jamais d'ajout ni de vidage pendant une opération", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    const errors: string[] = [];
    const video = fakeVideo();
    const engine = new OfflineEngine(
      video,
      { read: async (o, l) => file.slice(o, Math.min(file.length, o + l)), available: () => file.length, complete: () => true },
      null,
      { onError: (m) => errors.push(m) }
    );
    await engine.open(0);
    for (const t of [3, 1, 4, 2, 5]) {
      (video as unknown as { currentTime: number }).currentTime = t;
      video.dispatchEvent(new Event("seeking"));
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(errors).toEqual([]);
    expect(buffer.ops.filter((o) => o === "remove").length).toBeGreaterThan(0);
    expect(buffer.ops.filter((o) => o === "append").length).toBeGreaterThan(1);
    engine.close();
  });
});
