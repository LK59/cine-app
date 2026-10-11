// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";

// Le décodeur AAC de FFmpeg en WebAssembly (aac/aacWasmAudio.ts) : par où passe un AAC à PCE
// décodé, et comment ses canaux sont rangés. « Elle s'appelle Ruby » sur l'iPhone de Louis
// (11/10/2026) : copie refusée par MediaSource, AudioDecoder de Safari en échec — le décodeur
// WebAssembly est la dernière marche avant le lecteur serveur, hors Chromium (DECISIONS.md §62).

const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";
const SILK = "Mozilla/5.0 (Linux; Android 11; AFTT) AppleWebKit/537.36 (KHTML, like Gecko) Silk/152.4.7 like Chrome/152.0.7977.140 Safari/537.36";
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

const wasmOpen = vi.fn();
vi.mock("@/lib/webcodecs/aac/aacWasmAudio", () => ({ openWasmAacTrack: (...args: unknown[]) => wasmOpen(...args) }));

function ua(agent: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
}

beforeEach(() => {
  wasmOpen.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("quel décodeur pour un AAC à PCE", () => {
  it("FFmpeg en WebAssembly hors Chromium, le navigateur sur Chromium", async () => {
    const { aacDecoderRouteHere } = await import("@/lib/webcodecs/aacConfig");
    const at = (agent: string) => {
      ua(agent);
      const route = aacDecoderRouteHere();
      vi.restoreAllMocks();
      return route;
    };
    expect(at(SAFARI_IOS)).toBe("wasm");
    expect(at(SAFARI_MAC)).toBe("wasm");
    expect(at(FIREFOX)).toBe("wasm");
    expect(at(SILK)).toBe("browser");
    expect(at(CHROME_MAC)).toBe("browser");
  });

  it("l'ordre de sortie est partout celui de FFmpeg, mesuré — plus jamais AudioToolbox", async () => {
    const { decodedOrderMeasuredHere } = await import("@/lib/webcodecs/aacConfig");
    for (const agent of [SAFARI_IOS, SAFARI_MAC, SILK, CHROME_MAC, FIREFOX]) {
      ua(agent);
      expect(decodedOrderMeasuredHere()).toBe(true);
      vi.restoreAllMocks();
    }
  });
});

describe("rangement du décodé par le décodeur WebAssembly", () => {
  it("Ruby sur Safari : 5.1 entier, dans l'ordre mesuré — pas L R C", async () => {
    ua(SAFARI_IOS);
    const { PROBE_ASC } = await import("@/lib/webcodecs/aacPceProbe");
    const { aacShaping } = await import("@/lib/webcodecs/softwareAudio");
    const file = { tracks: [{ number: 2, codecPrivate: PROBE_ASC }] } as never;
    expect(aacShaping(file, 2, 6, true)).toEqual({ channels: 6, rows: null });
  });

  it("la copie gardée en vigueur ne change rien au rangement d'un décodé WebAssembly", async () => {
    // Le rangement d'un décodé WebAssembly ne lit pas la réponse de copie : décodé, il l'est.
    ua(SAFARI_IOS);
    const { PROBE_ASC } = await import("@/lib/webcodecs/aacPceProbe");
    const { aacShaping } = await import("@/lib/webcodecs/softwareAudio");
    const file = { tracks: [{ number: 2, codecPrivate: PROBE_ASC }] } as never;
    // Sans le drapeau (le décodeur du navigateur) et sans refus gardé, Safari copie : rien à ranger.
    expect(aacShaping(file, 2, 6)).toBeNull();
    expect(aacShaping(file, 2, 6, true)).toEqual({ channels: 6, rows: null });
  });
});

describe("SoftwareAudioTrack.open — la route d'un AAC", () => {
  const fakeTrack = (channels: number) => ({
    format: { sampleRate: 48000, numberOfChannels: channels },
    samples: async function* () {
      yield { planes: Array.from({ length: channels }, (_, c) => Float32Array.from([c])), sampleRate: 48000, timestampSeconds: 0 };
    },
    close: vi.fn(),
  });

  it("hors Chromium : le décodeur WebAssembly, sans toucher au navigateur", async () => {
    ua(SAFARI_IOS);
    wasmOpen.mockResolvedValue(fakeTrack(6));
    const { PROBE_ASC } = await import("@/lib/webcodecs/aacPceProbe");
    const { SoftwareAudioTrack, takeAacDecodeRoute } = await import("@/lib/webcodecs/softwareAudio");
    const file = { tracks: [{ number: 2, type: "audio", codecId: "A_AAC", codecPrivate: PROBE_ASC }] } as never;
    const track = await SoftwareAudioTrack.open({ size: 0, read: async () => new Uint8Array() } as never, 2, "A_AAC", file);
    expect(wasmOpen).toHaveBeenCalledOnce();
    expect(track.format).toEqual({ sampleRate: 48000, numberOfChannels: 6 });
    const first = await track.samples(0).next();
    expect(first.value?.planes.map((p: Float32Array) => p[0])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(takeAacDecodeRoute()).toBe("wasm-decode");
  });

  it("un décodeur WebAssembly qui ne se charge pas : erreur nommée, pour que l'hôte passe au serveur", async () => {
    ua(SAFARI_IOS);
    wasmOpen.mockRejectedValue(new Error("instanciation impossible"));
    const { PROBE_ASC } = await import("@/lib/webcodecs/aacPceProbe");
    const { SoftwareAudioTrack } = await import("@/lib/webcodecs/softwareAudio");
    const file = { tracks: [{ number: 2, type: "audio", codecId: "A_AAC", codecPrivate: PROBE_ASC }] } as never;
    await expect(SoftwareAudioTrack.open({ size: 0, read: async () => new Uint8Array() } as never, 2, "A_AAC", file)).rejects.toThrow(
      /décodeur AAC non chargé \(instanciation impossible\)/
    );
  });
});
