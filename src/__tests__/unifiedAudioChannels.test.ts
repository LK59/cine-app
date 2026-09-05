import { describe, it, expect, beforeEach } from "vitest";
import { unifiedAudioChannels, setAudioBufferRebuildable } from "@/lib/webcodecs/remuxer";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";

function audio(number: number, codecId: string, channels: number): MatroskaTrack {
  return { number, type: "audio", codecId, audio: { channels, sampleRate: 48000 } } as unknown as MatroskaTrack;
}
function video(): MatroskaTrack {
  return { number: 1, type: "video", codecId: "V_MPEGH/ISO/HEVC" } as unknown as MatroskaTrack;
}
function file(tracks: MatroskaTrack[]): MatroskaFile {
  return { tracks } as unknown as MatroskaFile;
}

beforeEach(() => setAudioBufferRebuildable(false));

describe("unifiedAudioChannels", () => {
  // Le cas mesuré : « Mourir peut attendre », piste française E-AC3 7.1 et anglaise E-AC3 5.1.
  // Les deux sont ré-encodées dans le même codec, donc l'unification de codec ne se déclenchait
  // pas — et le tampon audio passait pourtant de huit canaux à six en changeant de langue.
  // Firefox 154 sous Linux accepte le nouveau segment, continue l'image, et ne sort plus un son.
  it("folds every track to the smallest layout when they disagree", () => {
    expect(unifiedAudioChannels(file([video(), audio(2, "A_EAC3", 8), audio(3, "A_EAC3", 6)]))).toBe(6);
  });

  it("asks for nothing when every track already agrees", () => {
    expect(unifiedAudioChannels(file([video(), audio(2, "A_EAC3", 6), audio(3, "A_EAC3", 6)]))).toBeNull();
  });

  it("asks for nothing when there is only one track to play", () => {
    expect(unifiedAudioChannels(file([video(), audio(2, "A_EAC3", 8)]))).toBeNull();
  });

  // Là où le tampon peut être remplacé, chaque piste garde sa disposition : c'est justement ce
  // que ce remplacement permet, et un repli y coûterait deux canaux pour rien.
  it("stays out of the way where the buffer can simply be replaced", () => {
    setAudioBufferRebuildable(true);
    expect(unifiedAudioChannels(file([video(), audio(2, "A_EAC3", 8), audio(3, "A_EAC3", 6)]))).toBeNull();
  });

  it("ignores tracks that cannot be carried at all", () => {
    const undeliverable = { number: 4, type: "audio", codecId: "A_TRUEHD", audio: { channels: 8 } } as unknown as MatroskaTrack;
    expect(unifiedAudioChannels(file([video(), audio(2, "A_EAC3", 6), undeliverable]))).toBeNull();
  });
});
