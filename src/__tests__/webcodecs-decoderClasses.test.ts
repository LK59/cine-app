import { describe, it, expect } from "vitest";
import { registerCapturing, decoderClassFor } from "@/lib/webcodecs/decoderClasses";
import { codecNamesFor } from "@/lib/webcodecs/ownAudio";

// L'essai demux-son (19/11/2026) passe NOS paquets aux décodeurs de @mediabunny/ac3 et /dts, dont
// les classes ne sont pas exportées : decoderClasses.ts les note au moment où mediabunny les
// enregistre. Une montée de mediabunny qui changerait sa vérification (`instanceof`) rendrait ce
// relais muet — et l'essai retomberait en silence sur le chemin de mediabunny. Ce test le dit.
describe("decoderClasses — les décodeurs de mediabunny, notés à leur enregistrement", () => {
  it("note la classe AC-3/E-AC3 et la classe DTS, et mediabunny les enregistre quand même", async () => {
    const core = await import("mediabunny");
    const { registerAc3Decoder } = await import("@mediabunny/ac3");
    const { registerDtsDecoder } = await import("@mediabunny/dts");
    registerCapturing(core, registerAc3Decoder);
    registerCapturing(core, registerDtsDecoder);
    const config = { codec: "ac-3", sampleRate: 48000, numberOfChannels: 6 };
    expect(decoderClassFor("ac3", config)).not.toBeNull();
    expect(decoderClassFor("eac3", config)).not.toBeNull();
    expect(decoderClassFor("dts", { ...config, codec: "dtsc" })).not.toBeNull();
    expect(decoderClassFor("opus", config)).toBeNull();
    // Le relais est retiré : `instanceof` redevient celui du langage.
    expect(Object.getOwnPropertyDescriptor(core.CustomAudioDecoder, Symbol.hasInstance)).toBeUndefined();
    expect(await core.canDecodeAudio("ac3")).toBe(true);
  });

  it("nomme les codecs comme mediabunny les attend", () => {
    expect(codecNamesFor("A_EAC3", null)).toEqual({ name: "eac3", webCodecs: "ec-3" });
    expect(codecNamesFor("A_DTS/EXPRESS", null)?.name).toBe("dts");
    // AAC-LC (objet 2) et HE-AAC (objet 5) se lisent dans l'AudioSpecificConfig.
    expect(codecNamesFor("A_AAC", new Uint8Array([0x11, 0x90]))?.webCodecs).toBe("mp4a.40.2");
    expect(codecNamesFor("A_AAC", new Uint8Array([0x2b, 0x92]))?.webCodecs).toBe("mp4a.40.5");
    expect(codecNamesFor("A_TRUEHD", null)).toBeNull();
  });
});
