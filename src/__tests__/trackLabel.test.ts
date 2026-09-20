import { describe, it, expect } from "vitest";
import { languageName, audioCodecName, channelLayout, labelAudioTracks, type AudioTrackFacts } from "@/lib/trackLabel";

/**
 * La forme des étiquettes de pistes : langue — codec — canaux.
 *
 * Trois endroits les fabriquaient chacun à sa façon, dont deux en recopiant le titre qu'un
 * inconnu avait tapé dans son multiplexeur : « fre — FR VFF : AC3 5.1 » d'un côté, « French -
 * Dolby Digital - 5.1 - Par défaut » de l'autre. Ces tests fixent la forme unique.
 */
const piste = (o: Partial<AudioTrackFacts> & { number: number }): AudioTrackFacts => ({
  language: null, name: null, isDefault: false, isForced: false, ...o,
});

const options = {
  locale: "fr",
  canaux: (n: number) => `${n} canaux`,
  piste: (n: number) => `Piste ${n}`,
};

describe("languageName", () => {
  it("traduit dans la langue de qui regarde, sans dictionnaire à tenir", () => {
    expect(languageName("eng", "fr")).toBe("Anglais");
    expect(languageName("fre", "en")).toBe("French");
    expect(languageName("en", "es")).toBe("Inglés");
    expect(languageName("fra", "de")).toBe("Französisch");
  });

  it("ramène toutes les écritures d'une même langue au même nom", () => {
    for (const code of ["fr", "fra", "fre", "FR", "fr-FR", "fr_CA"]) {
      expect(languageName(code, "fr"), code).toBe("Français");
    }
  });

  it("ne prétend rien d'une langue absente ou indéterminée", () => {
    expect(languageName(null, "fr")).toBeNull();
    expect(languageName("und", "fr")).toBeNull();
    expect(languageName("zxx", "fr")).toBeNull();
  });
});

describe("audioCodecName", () => {
  it("donne le nom commercial, celui qu'on lit sur les jaquettes", () => {
    expect(audioCodecName("A_EAC3")).toBe("Dolby Digital+");
    expect(audioCodecName("eac3")).toBe("Dolby Digital+");
    expect(audioCodecName("A_AC3")).toBe("Dolby Digital");
    expect(audioCodecName("A_TRUEHD")).toBe("Dolby TrueHD");
    expect(audioCodecName("A_DTS")).toBe("DTS");
    expect(audioCodecName("A_AAC")).toBe("AAC");
  });

  it("ajoute le profil seulement quand il dit quelque chose de plus", () => {
    // Relevés sur cette bibliothèque : 70 pistes Atmos, 77 DTS-HD MA, 71 HE-AAC, 1 DTS:X.
    // L'Atmos se nomme seul : « Dolby Digital+ Atmos » dit deux fois la même chose à qui choisit.
    expect(audioCodecName("eac3", "Dolby Digital Plus + Dolby Atmos")).toBe("Dolby Atmos");
    expect(audioCodecName("truehd", "Dolby TrueHD + Dolby Atmos")).toBe("Dolby Atmos");
    expect(audioCodecName("dts", "DTS-HD MA")).toBe("DTS-HD MA");
    expect(audioCodecName("dts", "DTS-HD MA + DTS:X")).toBe("DTS:X");
    expect(audioCodecName("aac", "HE-AAC")).toBe("HE-AAC");
    // « LC » ne distingue rien pour qui regarde un film.
    expect(audioCodecName("aac", "LC")).toBe("AAC");
  });

  it("rend un codec inconnu plutôt que rien", () => {
    expect(audioCodecName("A_REAL/COOK")).toBe("REAL COOK");
    expect(audioCodecName(null)).toBeNull();
  });
});

describe("channelLayout", () => {
  it("nomme les quatre dispositions sans ambiguïté", () => {
    expect(channelLayout(1, options.canaux)).toBe("1.0");
    expect(channelLayout(2, options.canaux)).toBe("2.0");
    expect(channelLayout(6, options.canaux)).toBe("5.1");
    expect(channelLayout(8, options.canaux)).toBe("7.1");
  });

  it("n'invente pas une disposition pour les autres", () => {
    // Un compte de canaux ne nomme pas une disposition : cinq canaux, c'est un 5.0 dans un
    // fichier et un 4.1 dans un autre. Cinq pistes de cette bibliothèque sont dans ce cas.
    expect(channelLayout(5, options.canaux)).toBe("5 canaux");
    expect(channelLayout(7, options.canaux)).toBe("7 canaux");
    expect(channelLayout(3, options.canaux)).toBe("3 canaux");
    expect(channelLayout(null, options.canaux)).toBeNull();
  });
});

describe("labelAudioTracks", () => {
  it("tait les codecs ordinaires : la langue et les canaux suffisent", () => {
    // 949 pistes sur 1 097 sont en AAC, Dolby Digital ou Dolby Digital+ sur cette bibliothèque.
    // Les écrire allongeait l'étiquette jusqu'à la couper à l'écran, sans départager quoi que ce
    // soit — relevé sur des captures du lecteur le 20/09/2026.
    const [a] = labelAudioTracks([piste({ number: 2, language: "fra", codecId: "A_AAC", channels: 6 })], options);
    expect(a.label).toBe("Français — 5.1");
    const [b] = labelAudioTracks([piste({ number: 2, language: "fra", codecId: "A_EAC3", channels: 6 })], options);
    expect(b.label).toBe("Français — 5.1");
  });

  it("dit le codec quand il sort de l'ordinaire", () => {
    const cas: [string, string | null, string][] = [
      ["A_TRUEHD", "Dolby TrueHD + Dolby Atmos", "Anglais — Dolby Atmos — 7.1"],
      ["A_DTS", "DTS-HD MA", "Anglais — DTS-HD MA — 7.1"],
      ["eac3", "Dolby Digital Plus + Dolby Atmos", "Anglais — Dolby Atmos — 7.1"],
      ["A_FLAC", null, "Anglais — FLAC — 7.1"],
    ];
    for (const [codecId, profile, attendu] of cas) {
      const [a] = labelAudioTracks([piste({ number: 3, language: "eng", codecId, profile, channels: 8 })], options);
      expect(a.label, codecId).toBe(attendu);
    }
  });

  it("marque une audiodescription sur la langue, pas sur le format", () => {
    const [a] = labelAudioTracks(
      [piste({ number: 2, language: "fra", name: "Audiodescription", codecId: "eac3", channels: 2 })],
      options
    );
    expect(a.label).toBe("Français AD — 2.0");
  });

  it("marque la VO quand la langue originale est connue", () => {
    const [a] = labelAudioTracks([piste({ number: 3, language: "eng", codecId: "dts", channels: 8 })], {
      ...options,
      originalLanguage: "en",
    });
    expect(a.label).toBe("Anglais (VO) — DTS — 7.1");
  });

  it("ne marque pas la VO quand on ne sait pas", () => {
    const [a] = labelAudioTracks([piste({ number: 3, language: "eng", codecId: "dts", channels: 8 })], options);
    expect(a.label).toBe("Anglais — DTS — 7.1");
  });

  /**
   * Le cas de « 2001 » : deux pistes anglaises 5.1 en E-AC3, qui sont deux masters différents.
   * La forme standard les rend identiques ; seul le titre libre les distingue, et c'est
   * exactement ce que la parenthèse est là pour rattraper.
   */
  it("distingue deux pistes que la forme standard rendrait identiques", () => {
    const etiquettes = labelAudioTracks(
      [
        piste({ number: 4, language: "eng", codecId: "eac3", channels: 6, name: "ENG VO : DDP 5.1 (Mix 6-Tracks Original du LaserDisc)" }),
        piste({ number: 5, language: "eng", codecId: "eac3", channels: 6, name: "ENG VO : DDP 5.1 (Restauré et Remixé)" }),
      ],
      options
    );
    expect(etiquettes[0].label).toBe("Anglais — 5.1 (Mix 6-Tracks Original du LaserDisc)");
    expect(etiquettes[1].label).toBe("Anglais — 5.1 (Restauré et Remixé)");
  });

  it("n'ajoute la parenthèse que là où elle sert", () => {
    const etiquettes = labelAudioTracks(
      [
        piste({ number: 2, language: "fra", codecId: "ac3", channels: 6, name: "FR VFF : AC3 5.1" }),
        piste({ number: 3, language: "eng", codecId: "ac3", channels: 6, name: "ENG VO : AC3 5.1" }),
      ],
      options
    );
    expect(etiquettes.map((e) => e.label)).toEqual(["Français — 5.1", "Anglais — 5.1"]);
  });

  it("retombe sur le numéro quand rien ne distingue ni ne nomme", () => {
    const etiquettes = labelAudioTracks([piste({ number: 7 }), piste({ number: 8 })], options);
    expect(etiquettes.map((e) => e.label)).toEqual(["Piste 7", "Piste 8"]);
  });
});

/**
 * Les variantes régionales appartiennent à la langue, pas à une parenthèse en bout de ligne.
 *
 * Les deux fichiers qui ont fait remonter le problème, le 20/09/2026 : « La Fin d'Oak Street »
 * porte VFF et VFQ, « Disclosure Day » porte French (France) et French (Canadien). Sans cela les
 * deux pistes françaises s'affichent identiques, et le discriminant — qui effaçait justement ces
 * marqueurs — rendait « (Piste 2) » et « (Piste 3) ».
 */
describe("les variantes régionales", () => {
  it("distingue la VFQ de la VFF sans parenthèse de secours", () => {
    const etiquettes = labelAudioTracks(
      [
        piste({ number: 2, language: "fra", codecId: "eac3", channels: 6, name: "VFF" }),
        piste({ number: 3, language: "fra", codecId: "eac3", channels: 6, name: "VFQ" }),
        piste({ number: 4, language: "eng", codecId: "eac3", channels: 6, name: "English" }),
      ],
      options
    );
    expect(etiquettes.map((e) => e.label)).toEqual([
      "Français — 5.1",
      "Français (Canadien) — 5.1",
      "Anglais — 5.1",
    ]);
  });

  it("comprend aussi la forme écrite en toutes lettres", () => {
    const etiquettes = labelAudioTracks(
      [
        piste({ number: 2, language: "fra", codecId: "eac3", channels: 6, name: "French (France)" }),
        piste({ number: 3, language: "fra", codecId: "eac3", channels: 6, name: "French (Canadien)" }),
      ],
      options
    );
    expect(etiquettes.map((e) => e.label)).toEqual(["Français — 5.1", "Français (Canadien) — 5.1"]);
  });

  it("garde un marqueur qu'elle ne sait pas nommer plutôt que de l'effacer", () => {
    const etiquettes = labelAudioTracks(
      [
        piste({ number: 2, language: "fra", codecId: "eac3", channels: 6, name: "VFI" }),
        piste({ number: 3, language: "fra", codecId: "eac3", channels: 6, name: "VFF" }),
      ],
      options
    );
    expect(etiquettes[0].label).toBe("Français — 5.1 (VFI)");
    expect(etiquettes[1].label).toBe("Français — 5.1 (VFF)");
  });
});
