import { describe, it, expect } from "vitest";
import { qualityBadges, toDynamicRange } from "@/lib/videoQuality";

// Une étiquette décrit ce que le spectateur recevra, pas ce que le fichier contient. La vidéo est
// copiée telle quelle sur les deux chemins de lecture — 4K et Dolby Vision sont donc exacts. L'audio
// est ré-encodé : « Atmos » ou « 7.1 » seraient faux au moment précis où ils compteraient.

describe("qualityBadges", () => {
  it("signale la 4K", () => {
    expect(qualityBadges({ resolution: 2160 })).toEqual(["4K"]);
    expect(qualityBadges({ resolution: 4320 })).toEqual(["4K"]);
  });

  it("ne dit rien du 1080p", () => {
    // La moitié de cette bibliothèque : une étiquette portée par la majorité ne distingue rien et
    // n'ajoute que du bruit sur chaque fiche.
    expect(qualityBadges({ resolution: 1080 })).toEqual([]);
  });

  it("signale ce qui est en dessous", () => {
    // Le savoir avant de lancer vaut mieux que de le découvrir sur l'écran du salon.
    expect(qualityBadges({ resolution: 720 })).toEqual(["720p"]);
    expect(qualityBadges({ resolution: 480 })).toEqual(["SD"]);
  });

  it("préfère Dolby Vision à HDR quand les deux sont là", () => {
    expect(qualityBadges({ resolution: 2160, dynamicRange: "DV" })).toEqual(["4K", "Dolby Vision"]);
    expect(qualityBadges({ resolution: 1080, dynamicRange: "HDR" })).toEqual(["HDR"]);
  });

  it("ne dit jamais rien de l'audio", () => {
    // La garantie que ce module ne se mettra pas à promettre ce que le lecteur ré-encode.
    const toutes = [
      ...qualityBadges({ resolution: 2160, dynamicRange: "DV" }),
      ...qualityBadges({ resolution: 480, dynamicRange: "HDR" }),
    ].join(" ");
    expect(toutes).not.toMatch(/atmos|5\.1|7\.1|dts|truehd/i);
  });

  it("ne fabrique rien à partir de rien", () => {
    expect(qualityBadges(null)).toEqual([]);
    expect(qualityBadges(undefined)).toEqual([]);
    expect(qualityBadges({})).toEqual([]);
    expect(qualityBadges({ resolution: 0 })).toEqual([]);
  });
});

describe("toDynamicRange", () => {
  it("reconnaît ce que Radarr écrit vraiment", () => {
    // Relevé sur l'installation : ce sont les six valeurs présentes dans la bibliothèque.
    expect(toDynamicRange("DV HDR10Plus")).toBe("DV");
    expect(toDynamicRange("DV HDR10")).toBe("DV");
    expect(toDynamicRange("DV")).toBe("DV");
    expect(toDynamicRange("HDR10")).toBe("HDR");
    expect(toDynamicRange("HDR10Plus")).toBe("HDR");
    expect(toDynamicRange("PQ")).toBe("HDR");
  });

  it("ne dit rien quand Radarr ne dit rien", () => {
    expect(toDynamicRange("")).toBeUndefined();
    expect(toDynamicRange(null)).toBeUndefined();
    expect(toDynamicRange("SDR")).toBeUndefined();
  });
});
