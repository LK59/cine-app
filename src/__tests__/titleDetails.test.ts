import { describe, it, expect } from "vitest";
import { ADVISED_MARGIN, advisedConnectionMbps, bitrateMbps, definitionLabel, dynamicRangeOf, openingAudioIndex, videoCodecLabel } from "@/lib/titleDetails";
import type { TrackPreferences } from "@/lib/trackPreferences";

/** Les mots de la fenêtre « Détails » d'un film (DECISIONS.md §152, 13/11/2026). */
describe("advisedConnectionMbps — la connexion conseillée pour la qualité d'origine", () => {
  it("prend une fois et demie le débit moyen", () => {
    expect(ADVISED_MARGIN).toBe(1.5);
    // 6 Mb/s × 1,5 = 9 : à l'unité jusqu'à 10.
    expect(advisedConnectionMbps(6_000_000)).toBe(9);
  });

  it("arrondit vers le haut à un chiffre qui se lit : l'unité, puis 5, puis 10", () => {
    expect(advisedConnectionMbps(4_200_000)).toBe(7); // 6,3
    expect(advisedConnectionMbps(10_000_000)).toBe(15); // 15 tout juste, pas 20 (virgule flottante)
    expect(advisedConnectionMbps(16_000_000)).toBe(25); // 24
    expect(advisedConnectionMbps(25_000_000)).toBe(40); // 37,5
    expect(advisedConnectionMbps(52_400_000)).toBe(80); // 78,6
    expect(advisedConnectionMbps(80_000_000)).toBe(120);
  });

  it("ne descend jamais sous 1 Mb/s, et ne conseille rien sans débit connu", () => {
    expect(advisedConnectionMbps(300_000)).toBe(1);
    for (const v of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(advisedConnectionMbps(v)).toBeNull();
  });

  it("n'est jamais en dessous du débit moyen", () => {
    for (let bps = 500_000; bps < 120_000_000; bps += 777_777) {
      expect(advisedConnectionMbps(bps)!).toBeGreaterThanOrEqual(bps / 1_000_000);
    }
  });
});

describe("bitrateMbps", () => {
  it("une décimale sous 10 Mb/s, l'unité au-delà", () => {
    expect(bitrateMbps(4_240_000)).toBe(4.2);
    expect(bitrateMbps(52_400_000)).toBe(52);
    expect(bitrateMbps(null)).toBeNull();
  });
});

describe("definitionLabel", () => {
  it("lit la largeur pour les films en scope", () => {
    expect(definitionLabel(3840, 1600)).toBe("4K");
    expect(definitionLabel(1920, 800)).toBe("1080p");
    expect(definitionLabel(1280, 536)).toBe("720p");
  });
  it("et la hauteur pour les formats étroits", () => {
    expect(definitionLabel(1440, 1080)).toBe("1080p");
    expect(definitionLabel(720, 576)).toBe("SD");
    expect(definitionLabel(null, null)).toBeNull();
  });
});

describe("dynamicRangeOf", () => {
  it("nomme chaque dynamique, Dolby Vision d'abord", () => {
    expect(dynamicRangeOf("DOVIWithHDR10")).toBe("Dolby Vision");
    expect(dynamicRangeOf("DOVI")).toBe("Dolby Vision");
    expect(dynamicRangeOf("HDR10Plus")).toBe("HDR10+");
    expect(dynamicRangeOf("HDR10")).toBe("HDR10");
    expect(dynamicRangeOf("HLG")).toBe("HLG");
    expect(dynamicRangeOf("SDR")).toBe("SDR");
  });
  it("retombe sur VideoRange pour une couche invalide ou une valeur inconnue", () => {
    expect(dynamicRangeOf("DOVIInvalid", "HDR")).toBe("HDR");
    expect(dynamicRangeOf("Quelquechose", "SDR")).toBe("SDR");
    expect(dynamicRangeOf(null, null)).toBeNull();
  });
});

describe("videoCodecLabel", () => {
  it("le codec, et la profondeur seulement au-delà de 8 bits", () => {
    const bits = (n: number) => `${n} bits`;
    expect(videoCodecLabel("hevc", 10, bits)).toBe("HEVC 10 bits");
    expect(videoCodecLabel("h264", 8, bits)).toBe("H.264");
    expect(videoCodecLabel(null, 10, bits)).toBeNull();
  });
});

/**
 * « Par défaut » = la piste que le lecteur ouvrira pour ce compte, par sa règle (`chooseAudioTrack`), et non le
 * drapeau du fichier (Louis, 13/11/2026).
 */
describe("openingAudioIndex — la piste qu'ouvrira le lecteur", () => {
  const track = (language: string | null, channels: number, isDefault = false, name: string | null = null) => ({ language, channels, isDefault, name, title: null });
  // Une VO anglaise marquée par défaut, une VF stéréo, une VF 5.1, une audiodescription française.
  const FILE = [track("en", 8, true), track("fr", 2), track("fr", 6, false, "VFF"), track("fr", 2, false, "Français AD")];
  const prefs = (audioLanguage: string | null, playDefaultAudioTrack = false): TrackPreferences => ({
    audioLanguage,
    subtitleLanguage: null,
    subtitleMode: null,
    playDefaultAudioTrack,
  });

  it("la langue du compte présente : sa piste la plus riche, jamais l'audiodescription", () => {
    // « fra » (Jellyfin) contre « fr » (le fichier) : la même langue, par `normaliseLanguage`.
    expect(openingAudioIndex(FILE, prefs("fra"))).toBe(2);
  });

  it("la langue du compte absente : la piste marquée par défaut dans le fichier", () => {
    expect(openingAudioIndex(FILE, prefs("jpn"))).toBe(0);
  });

  it("« jouer la piste par défaut » : le drapeau du fichier, même si la langue du compte est là", () => {
    expect(openingAudioIndex(FILE, prefs("fra", true))).toBe(0);
  });

  it("sans langue, ou sans préférences lues : le drapeau du fichier, sinon la première piste", () => {
    expect(openingAudioIndex(FILE, prefs(null))).toBe(0);
    expect(openingAudioIndex(FILE, null)).toBe(0);
    expect(openingAudioIndex([track("de", 2), track("fr", 2, true)], null)).toBe(1);
    expect(openingAudioIndex([track("de", 2), track("fr", 2)], null)).toBe(0);
  });

  it("un fichier sans son : rien", () => {
    expect(openingAudioIndex([], prefs("fra"))).toBeNull();
  });
});
