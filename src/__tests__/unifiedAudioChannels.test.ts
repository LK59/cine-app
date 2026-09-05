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
  //
  // Vers le haut : la piste la plus riche garde ses huit canaux, la 5.1 reçoit deux arrières
  // silencieux — un mixage 5.1 n'a rien à y mettre. Personne n'y perd.
  it("lifts every track to the richest layout when they disagree", () => {
    expect(unifiedAudioChannels(file([video(), audio(2, "A_EAC3", 8), audio(3, "A_EAC3", 6)]))).toBe(8);
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

// `fold` n'est pas exporté : on l'exerce par le chemin public, en vérifiant que la disposition
// demandée est bien celle qui ressort quel que soit le sens.
describe("la disposition demandée à l'encodeur", () => {
  it("is the file's richest layout, whichever track is playing", () => {
    const mixed = file([video(), audio(2, "A_EAC3", 6), audio(3, "A_EAC3", 8), audio(4, "A_EAC3", 2)]);
    expect(unifiedAudioChannels(mixed)).toBe(8);
  });
});
