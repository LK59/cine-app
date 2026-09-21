import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";

// Le moteur du chemin canevas, sans navigateur : chaque pièce qui n'existe que dans un navigateur
// — WebCodecs, WebGL, l'AudioContext — est remplacée par un modèle qui dit ce qu'on lui a fait.
// Ce qui compte ici, c'est la tuyauterie : ce qui est ouvert, ce qui est fermé, et ce qu'on fait
// quand une pièce lâche.

const h = vi.hoisted(() => {
  const state = {
    sourceOpen: null as null | (() => Promise<unknown>),
    softwareOpen: null as null | (() => Promise<unknown>),
    audioSupport: null as null | (() => Promise<{ supported: boolean }>),
    outputs: [] as unknown[],
    renderers: [] as { destroy: () => void; destroyed: number }[],
  };
  class FakeAudioOutput {
    primed = false;
    needsMore = false;
    state = "running";
    outputState = "—";
    level = "—";
    bufferedAhead = 0;
    onError: ((reason: string) => void) | null = null;
    constructor() {
      state.outputs.push(this);
    }
    setVolume() {}
    enqueue() {}
    enqueuePcm() {}
    flush() {}
    currentMediaTime() {
      return 0;
    }
    async close() {}
    async resume() {}
    async suspend() {}
  }
  return { state, FakeAudioOutput };
});

vi.mock("@/lib/webcodecs/byteSource", () => ({
  HttpByteSource: { open: () => h.state.sourceOpen!() },
}));
vi.mock("@/lib/webcodecs/matroska", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webcodecs/matroska")>()),
  parseMatroska: async () => FILE,
}));
vi.mock("@/lib/webcodecs/renderer", () => ({
  createRenderer: () => {
    const renderer = {
      destroyed: 0,
      draw: () => {},
      destroy() {
        renderer.destroyed += 1;
      },
    };
    h.state.renderers.push(renderer);
    return renderer;
  },
}));
vi.mock("@/lib/webcodecs/audioOutput", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webcodecs/audioOutput")>()),
  AudioOutput: h.FakeAudioOutput,
}));
vi.mock("@/lib/webcodecs/softwareAudio", () => ({
  SoftwareAudioTrack: { open: () => h.state.softwareOpen!() },
}));
vi.mock("@/lib/webcodecs/sampleReader", () => ({
  SampleReader: class {
    async next() {
      return null;
    }
    seekTo() {}
  },
}));

function track(o: Partial<MatroskaTrack> & Pick<MatroskaTrack, "number" | "type" | "codecId">): MatroskaTrack {
  return {
    codecPrivate: null, language: "fra", name: null,
    isDefault: true, isForced: false, isHearingImpaired: false, isEnabled: true, defaultDurationNs: null, ...o,
  };
}

const VIDEO = track({ number: 1, type: "video", codecId: "V_VP9", video: { width: 1920, height: 1080 } });
const FLAC = track({ number: 2, type: "audio", codecId: "A_FLAC", audio: { sampleRate: 48000, channels: 2 } });
const FILE: MatroskaFile = {
  timestampScaleNs: 1_000_000, durationSeconds: 5400, tracks: [VIDEO, FLAC], cues: [],
  segmentDataStart: 0, segmentEnd: 1000, firstClusterOffset: 0,
};

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  static async isConfigSupported() {
    return { supported: true };
  }
  state = "unconfigured";
  decodeQueueSize = 0;
  closed = false;
  constructor() {
    FakeVideoDecoder.instances.push(this);
  }
  configure() {
    this.state = "configured";
  }
  decode() {}
  async flush() {}
  close() {
    this.closed = true;
    this.state = "closed";
  }
}

class FakeAudioDecoder {
  static instances: FakeAudioDecoder[] = [];
  static async isConfigSupported() {
    return h.state.audioSupport ? h.state.audioSupport() : { supported: true };
  }
  state = "unconfigured";
  decodeQueueSize = 0;
  constructor(readonly init: { output: (d: unknown) => void; error: (e: DOMException) => void }) {
    FakeAudioDecoder.instances.push(this);
  }
  configure() {
    if (this.state === "closed") throw new DOMException("closed", "InvalidStateError");
    this.state = "configured";
  }
  decode() {}
  reset() {
    // Ce que fait un vrai décodeur fermé par sa propre erreur.
    if (this.state === "closed") throw new DOMException("Cannot call 'reset' on a closed codec.", "InvalidStateError");
    this.state = "unconfigured";
  }
  async flush() {}
  close() {
    this.state = "closed";
  }
  /** Ce que la plateforme fait quand elle lâche : fermé, puis l'erreur. */
  crash(message: string) {
    this.state = "closed";
    this.init.error(new DOMException(message, "OperationError"));
  }
}

function fakeSource() {
  return { size: 1000, read: async () => new Uint8Array(0), close: vi.fn(), keep: vi.fn() };
}

function fakeSoftware() {
  return {
    format: { sampleRate: 48000, numberOfChannels: 2 },
    samples: async function* () {},
    close: vi.fn(),
  };
}

const canvas = { addEventListener: () => {}, removeEventListener: () => {} } as unknown as HTMLCanvasElement;
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  FakeVideoDecoder.instances = [];
  FakeAudioDecoder.instances = [];
  h.state.outputs = [];
  h.state.renderers = [];
  h.state.audioSupport = null;
  h.state.sourceOpen = async () => fakeSource();
  h.state.softwareOpen = async () => fakeSoftware();
  vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
  vi.stubGlobal("AudioDecoder", FakeAudioDecoder);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

async function engine() {
  const { PlaybackEngine } = await import("@/lib/webcodecs/engine");
  return new PlaybackEngine(canvas);
}

describe("PlaybackEngine — décodeur audio de la plateforme qui lâche", () => {
  it("passe au décodeur logiciel au lieu d'arrêter le film", async () => {
    // Relevé en production sur iPhone : « Décodage audio interrompu : InternalAudioDecoderCocoa
    // decoding failed », une piste FLAC que libFLAC lit très bien — et le film rendu au serveur.
    const player = await engine();
    const errors: unknown[] = [];
    player.on("error", (message) => errors.push(message));
    await player.load("http://x/film.mkv", { hdr: false });
    const opened = vi.fn(async () => fakeSoftware());
    h.state.softwareOpen = opened;

    FakeAudioDecoder.instances[0].crash("InternalAudioDecoderCocoa decoding failed");
    await settle();

    expect(errors).toEqual([]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(player.diagnostics["Chemin audio"]).toBe("décodeur logiciel");
    player.destroy();
  });

  it("n'arrête le film que si rien d'autre ne sait lire la piste", async () => {
    const player = await engine();
    const errors: unknown[] = [];
    player.on("error", (message) => errors.push(message));
    await player.load("http://x/film.mkv", { hdr: false });
    h.state.softwareOpen = async () => {
      throw new Error("le décodeur logiciel refuse flac");
    };

    FakeAudioDecoder.instances[0].crash("InternalAudioDecoderCocoa decoding failed");
    await settle();

    expect(errors).toEqual(["Décodage audio interrompu : InternalAudioDecoderCocoa decoding failed"]);
    player.destroy();
  });

  it("ne fait pas échouer un saut sur un décodeur que sa propre erreur a fermé", async () => {
    const player = await engine();
    await player.load("http://x/film.mkv", { hdr: false });
    FakeAudioDecoder.instances[0].state = "closed";
    await expect(player.seek(120)).resolves.toBeUndefined();
    player.destroy();
  });
});

describe("PlaybackEngine — détruit pendant le chargement", () => {
  it("ne construit rien après une destruction survenue pendant l'ouverture du flux", async () => {
    let arrive!: (source: ReturnType<typeof fakeSource>) => void;
    h.state.sourceOpen = () => new Promise((resolve) => (arrive = resolve));
    const player = await engine();
    const loading = player.load("http://x/film.mkv", { hdr: false });
    player.destroy();
    const source = fakeSource();
    arrive(source);
    await loading;

    expect(source.close).toHaveBeenCalledTimes(1);
    expect(h.state.renderers).toHaveLength(0);
    expect(FakeVideoDecoder.instances).toHaveLength(0);
    expect(FakeAudioDecoder.instances).toHaveLength(0);
  });

  it("ferme ce qu'il avait déjà construit, et n'ouvre pas le son", async () => {
    // Détruit pendant la question posée au décodeur audio : le rendu WebGL et le VideoDecoder
    // existent déjà, l'AudioContext et l'AudioDecoder pas encore — et ne doivent jamais exister.
    const source = fakeSource();
    h.state.sourceOpen = async () => source;
    let answer!: (value: { supported: boolean }) => void;
    // La piste est imposée : la seule question posée au décodeur audio est celle de sa mise en
    // place, après le rendu et le VideoDecoder.
    h.state.audioSupport = () => new Promise((resolve) => (answer = resolve));
    const player = await engine();
    const loading = player.load("http://x/film.mkv", { hdr: false, audioTrackNumber: 2 });
    await settle();
    expect(h.state.renderers).toHaveLength(1);
    player.destroy();
    answer({ supported: true });
    await loading;

    expect(h.state.outputs).toHaveLength(0);
    expect(FakeAudioDecoder.instances).toHaveLength(0);
    expect(h.state.renderers.every((r) => r.destroyed === 1)).toBe(true);
    expect(FakeVideoDecoder.instances.every((d) => d.closed)).toBe(true);
    expect(source.close).toHaveBeenCalledTimes(1);
  });
});

describe("PlaybackEngine — la zone gardée d'une lecture précédente", () => {
  it("la libère, puisque ce chemin ne la redésigne jamais", async () => {
    // Une reconstruction qui tombe sur le chemin canevas hérite, avec les morceaux du fichier,
    // de la zone que le chemin natif gardait autour de sa tête : jusqu'à 24 Mo réservés pour rien.
    const source = fakeSource();
    h.state.sourceOpen = async () => source;
    const player = await engine();
    await player.load("http://x/film.mkv", { hdr: false });
    expect(source.keep).toHaveBeenCalledWith(0, 0);
    player.destroy();
  });
});
