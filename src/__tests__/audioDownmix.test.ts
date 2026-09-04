import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * Un navigateur qui encode l'AAC en 2 et 6 canaux, mais pas en 8 — c'est-à-dire un Chrome
 * Windows, mesuré. La piste française de « Mourir peut attendre » est en E-AC3 7.1 Atmos.
 */
function browserThatStopsAt(maxChannels: number) {
  return {
    isConfigSupported: vi.fn(async (config: { numberOfChannels: number; codec: string }) => ({
      supported: config.codec.startsWith("mp4a") && config.numberOfChannels <= maxChannels,
      config,
    })),
  };
}

// Le conteneur accepte l'AAC : ce qui est éprouvé ici est l'encodeur, pas la lecture.
vi.mock("@/lib/webcodecs/mseSource", () => ({
  containerAccepts: (mime: string) => mime.includes("mp4a"),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("AudioEncoder", browserThatStopsAt(6));
});
afterEach(() => vi.unstubAllGlobals());

describe("le plan de ré-encodage audio", () => {
  it("garde le nombre de canaux de la source quand le navigateur sait l'encoder", async () => {
    const { chooseTranscodePlan } = await import("@/lib/webcodecs/audioTranscode");
    expect(await chooseTranscodePlan(48000, 6)).toMatchObject({ channels: 6 });
    expect(await chooseTranscodePlan(48000, 2)).toMatchObject({ channels: 2 });
  });

  /**
   * Le cas signalé : sans cette descente, le remultiplexage était refusé et la lecture tombait
   * sur le chemin canevas — décodage logiciel d'un 4K HDR, et pour une source Dolby Vision une
   * image que ce navigateur ne sait pas convertir.
   */
  it("descend un 7.1 au 5.1 plutôt que d'abandonner", async () => {
    const { chooseTranscodePlan } = await import("@/lib/webcodecs/audioTranscode");
    expect(await chooseTranscodePlan(48000, 8)).toMatchObject({ channels: 6 });
  });

  it("descend jusqu'au stéréo quand rien d'autre ne passe", async () => {
    vi.stubGlobal("AudioEncoder", browserThatStopsAt(2));
    const { chooseTranscodePlan } = await import("@/lib/webcodecs/audioTranscode");
    expect(await chooseTranscodePlan(48000, 8)).toMatchObject({ channels: 2 });
  });

  it("ne rend un plan que si le navigateur sait vraiment encoder quelque chose", async () => {
    vi.stubGlobal("AudioEncoder", browserThatStopsAt(0));
    const { chooseTranscodePlan } = await import("@/lib/webcodecs/audioTranscode");
    expect(await chooseTranscodePlan(48000, 8)).toBeNull();
  });

  it("ne monte jamais au-dessus de la source", async () => {
    const { chooseTranscodePlan } = await import("@/lib/webcodecs/audioTranscode");
    expect(await chooseTranscodePlan(48000, 1)).toMatchObject({ channels: 1 });
  });
});

