import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

// What the player's first « Lire » would otherwise download while the viewer waits. The modules
// themselves are replaced by markers: importing one is the whole of what warming it means.
const imported: string[] = [];
vi.mock("mediabunny", () => (imported.push("mediabunny"), {}));
vi.mock("@mediabunny/ac3", () => (imported.push("ac3"), {}));
vi.mock("@mediabunny/dts", () => (imported.push("dts"), {}));
vi.mock("@/lib/webcodecs/flacDecoder", () => (imported.push("flacDecoder"), {}));
vi.mock("@wasm-audio-decoders/flac", () => (imported.push("libflac"), {}));
vi.mock("@/lib/webcodecs/truehd/truehdDecoder", () => ({ warmTrueHd: async () => void imported.push("truehd") }));

beforeEach(() => {
  imported.length = 0;
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("window", {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("scheduleDecoderWarmup", () => {
  it("fetches every decoder the player may need, FLAC included — after the delay and not before", async () => {
    vi.stubGlobal("navigator", {});
    const { scheduleDecoderWarmup } = await import("@/lib/webcodecs/decoderWarmup");
    scheduleDecoderWarmup(8000);
    await vi.advanceTimersByTimeAsync(7999);
    await settle();
    expect(imported).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    // FLAC since 21/09/2026: shipped by a deploy that the onboarding screen — the only caller
    // until then — would have warmed for almost nobody.
    expect(new Set(imported)).toEqual(new Set(["mediabunny", "ac3", "dts", "flacDecoder", "libflac", "truehd"]));
  });

  it("stays quiet on a device asking to save data", async () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const { scheduleDecoderWarmup } = await import("@/lib/webcodecs/decoderWarmup");
    scheduleDecoderWarmup(0);
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(imported).toEqual([]);
  });

  it("can be cancelled, so a screen that leaves early leaves nothing behind", async () => {
    vi.stubGlobal("navigator", {});
    const { scheduleDecoderWarmup } = await import("@/lib/webcodecs/decoderWarmup");
    scheduleDecoderWarmup(8000)();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(imported).toEqual([]);
  });

  it("runs at every start of the app, not only on the onboarding screen", () => {
    // The onboarding screen is a first launch; most accounts never see it, and a deploy changing
    // a decoder reaches every device without passing through it.
    expect(readFileSync("src/components/player/PlayerOnboarding.tsx", "utf8")).toMatch(/scheduleDecoderWarmup\(/);
    expect(readFileSync("src/components/player/PlayerShell.tsx", "utf8")).toMatch(/<DecoderWarmup /);
  });

  it("never enters the server's module graph", () => {
    // 21/09/2026: imported from cinemaWarmup.ts, which PlayerShell — rendered on the server too —
    // pulls in, libFLAC's Node worker broke the production build while typecheck, lint and every
    // test passed. The warm-up is reached only through `ssr: false`.
    const shell = readFileSync("src/components/player/PlayerShell.tsx", "utf8");
    expect(shell).toMatch(/dynamic\(\(\) => import\("\.\/DecoderWarmup"\)[^\n]*\{ ssr: false \}\)/);
    expect(shell).not.toMatch(/decoderWarmup"/);
    expect(readFileSync("src/lib/cinemaWarmup.ts", "utf8")).not.toMatch(/mediabunny|wasm-audio-decoders|flacDecoder/);
  });
});
