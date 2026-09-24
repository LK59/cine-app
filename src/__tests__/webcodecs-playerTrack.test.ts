import { describe, it, expect } from "vitest";
import { fromMatroskaTrack } from "@/lib/webcodecs/playerTrack";
import type { MatroskaTrack } from "@/lib/webcodecs/matroska";

// Une seule conversion. Il y en avait deux, du temps du lecteur canevas : la sienne oubliait les
// canaux, et toutes deux le drapeau « malentendants » — que le lecteur stable, lui, affichait.

const track = (over: Partial<MatroskaTrack>) =>
  ({
    number: 3,
    type: "subtitle",
    codecId: "S_TEXT/UTF8",
    language: "fre",
    name: null,
    isDefault: false,
    isForced: false,
    isHearingImpaired: false,
    isEnabled: true,
    ...over,
  }) as MatroskaTrack;

describe("fromMatroskaTrack", () => {
  it("porte le drapeau « malentendants » du conteneur", () => {
    expect(fromMatroskaTrack(track({ isHearingImpaired: true })).isHearingImpaired).toBe(true);
  });

  it("porte les canaux d'une piste audio, et rien pour un sous-titre", () => {
    const audio = track({ type: "audio", codecId: "A_EAC3", audio: { sampleRate: 48000, channels: 6 } });
    expect(fromMatroskaTrack(audio).channels).toBe(6);
    expect(fromMatroskaTrack(track({})).channels).toBeNull();
  });

  it("garde le reste tel quel", () => {
    expect(fromMatroskaTrack(track({ isForced: true, isDefault: true, name: "Forcés" }))).toMatchObject({
      number: 3,
      codecId: "S_TEXT/UTF8",
      language: "fre",
      name: "Forcés",
      isDefault: true,
      isForced: true,
    });
  });
});
