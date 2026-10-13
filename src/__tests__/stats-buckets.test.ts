import { describe, it, expect } from "vitest";
import { langCategory, codecCategory, qualityBucket } from "@/lib/statsBuckets";

/**
 * Les catégories de la page Statistiques, confrontées aux valeurs que Radarr renvoie réellement
 * pour cette bibliothèque (relevé du 13/10/2026 : 800 films avec fichier). Chaque cas est une
 * valeur qui y figure et que l'ancien calcul rangeait ailleurs.
 */
describe("langCategory", () => {
  it("reconnaît le français sous ses deux codes ISO 639-2, fre et fra", () => {
    expect(langCategory("fra")).toBe("vf"); // 3 films, rangés en « Autre »
    expect(langCategory("fra/spa")).toBe("vf"); // rangé en « Autre »
    expect(langCategory("eng/fra")).toBe("vfvo"); // rangé en « VO uniquement »
    expect(langCategory("fre/eng")).toBe("vfvo");
    expect(langCategory("fre / eng")).toBe("vfvo");
  });

  it("garde les autres cas tels quels", () => {
    expect(langCategory("fre/kor")).toBe("vf");
    expect(langCategory("eng/eng")).toBe("vo");
    expect(langCategory("und")).toBe("other");
    expect(langCategory("")).toBe("other");
  });
});

describe("codecCategory", () => {
  it("range AVC (nom MediaInfo du H.264) avec le H.264", () => {
    expect(codecCategory("AVC")).toBe("h264");
  });

  it("garde les noms que Radarr écrit pour HEVC et H.264", () => {
    for (const c of ["h265", "x265", "HEVC"]) expect(codecCategory(c)).toBe("hevc");
    for (const c of ["x264", "h264"]) expect(codecCategory(c)).toBe("h264");
    expect(codecCategory("AV1")).toBe("other");
  });
});

describe("qualityBucket", () => {
  it("range un remux selon sa résolution, pas d'office en 4K", () => {
    expect(qualityBucket("Remux-1080p")).toBe("1080p");
    expect(qualityBucket("Remux-2160p")).toBe("4K / UHD");
  });

  it("range le DVD en SD", () => {
    expect(qualityBucket("DVD")).toBe("SD");
    expect(qualityBucket("Bluray-480p")).toBe("SD");
  });

  it("garde les qualités courantes", () => {
    expect(qualityBucket("Bluray-2160p")).toBe("4K / UHD");
    expect(qualityBucket("WEBDL-1080p")).toBe("1080p");
    expect(qualityBucket("HDTV-1080p")).toBe("1080p");
    expect(qualityBucket("WEBDL-720p")).toBe("720p");
    expect(qualityBucket("Unknown")).toBe("Unknown");
  });
});
