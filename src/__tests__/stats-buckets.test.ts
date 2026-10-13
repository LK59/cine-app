import { describe, it, expect } from "vitest";
import { langCategory, codecCategory, qualityBucket } from "@/lib/statsBuckets";

/**
 * Les catégories de la page Statistiques, confrontées aux valeurs que Radarr renvoie réellement
 * pour cette bibliothèque (relevé du 13/10/2026 : 800 films avec fichier). Chaque cas est une
 * valeur qui y figure et que l'ancien calcul rangeait ailleurs.
 */
describe("langCategory", () => {
  it("reconnaît le français sous ses deux codes ISO 639-2, fre et fra", () => {
    expect(langCategory("fra", "English")).toBe("vf"); // rangé en « Autre » avant le 13/10
    expect(langCategory("eng/fra", "English")).toBe("vfvo"); // rangé en « VO uniquement »
    expect(langCategory("fre/eng", "English")).toBe("vfvo");
    expect(langCategory("fre / eng", "English")).toBe("vfvo");
  });

  it("range un film français dans sa VO, pas en VF (89 films comptés « VF uniquement »)", () => {
    expect(langCategory("fre", "French")).toBe("vofr");
    expect(langCategory("fra", "French")).toBe("vofr");
    expect(langCategory("eng/fre", "French")).toBe("vofr"); // VO + doublage anglais
    expect(langCategory("fre/per", "French")).toBe("vofr");
    // Un film français sans piste française n'est pas « sa VO ».
    expect(langCategory("und", "French")).toBe("other");
    expect(langCategory("", "French")).toBe("other");
  });

  it("cherche la VO dans la langue de tournage, pas dans l'anglais", () => {
    expect(langCategory("fre/kor", "Korean")).toBe("vfvo"); // était « VF uniquement »
    expect(langCategory("fra/spa", "Spanish")).toBe("vfvo"); // était « VF uniquement »
    expect(langCategory("jpn/fre/fre", "Japanese")).toBe("vfvo");
    // Doublages français et anglais d'un film espagnol, sans l'espagnol : pas de VO.
    expect(langCategory("fre/eng", "Spanish")).toBe("vf"); // était « VF + VO »
    expect(langCategory("ita", "Italian")).toBe("vo"); // était « Autre »
    expect(langCategory("eng/eng", "English")).toBe("vo");
    // Ni VF ni VO : un doublage tiers seul.
    expect(langCategory("eng", "Spanish")).toBe("other");
  });

  it("garde une règle sûre quand la langue de tournage est inconnue", () => {
    // Nom absent de `originalLanguageCode` ou champ manquant : toute piste non française passe
    // pour l'originale.
    expect(langCategory("fre/kor")).toBe("vfvo");
    expect(langCategory("fre", "Klingon")).toBe("vf");
    expect(langCategory("eng")).toBe("vo");
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
