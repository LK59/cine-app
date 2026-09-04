import { describe, it, expect } from "vitest";
import { describeFileTracks, prettyCodec, channelLayout, type RawStream } from "@/lib/fileTracks";

/**
 * Les flux ci-dessous sont recopiés tels quels de la bibliothèque (Jellyfin, « Mourir peut
 * attendre »). C'est le fichier qui a motivé ce travail : Bazarr n'en disait que
 * « English English French French », quatre vignettes rigoureusement identiques.
 */
const realFile: RawStream[] = [
  { Type: "Video", Codec: "hevc" },
  { Type: "Audio", Language: "fra", Codec: "eac3", Channels: 8, IsDefault: true, Title: "FR VFI : DDP 7.1 Atmos" },
  { Type: "Audio", Language: "eng", Codec: "eac3", Channels: 6, IsDefault: true, Title: "ENG VO : DDP 5.1" },
  { Type: "Subtitle", Language: "fra", Codec: "ass", IsForced: true, IsDefault: true, Title: "VFF Forced : ASS" },
  { Type: "Subtitle", Language: "fra", Codec: "ass", Title: "VFF Full : ASS" },
  { Type: "Subtitle", Language: "fra", Codec: "subrip", Title: "VFF Forced : SRT" },
  { Type: "Subtitle", Language: "fra", Codec: "subrip", Title: "VFF Full : SRT" },
  { Type: "Subtitle", Language: "eng", Codec: "subrip", Title: "EN Forced : SRT" },
  { Type: "Subtitle", Language: "eng", Codec: "subrip", Title: "EN Full : SRT" },
];

describe("prettyCodec", () => {
  it("dit HEVC là où Radarr dit x265", () => {
    expect(prettyCodec("x265")).toBe("HEVC");
    expect(prettyCodec("hevc")).toBe("HEVC");
    expect(prettyCodec("h265")).toBe("HEVC");
    expect(prettyCodec("h.265")).toBe("HEVC");
  });

  it("fait de même pour l'autre encodeur pris pour un codec", () => {
    expect(prettyCodec("x264")).toBe("H.264");
    expect(prettyCodec("avc")).toBe("H.264");
  });

  it("nomme les formats de sous-titres comme on les nomme", () => {
    expect(prettyCodec("subrip")).toBe("SRT");
    expect(prettyCodec("pgssub")).toBe("PGS");
  });

  it("recopie en majuscules ce qu'il ne connaît pas, plutôt que de l'effacer", () => {
    expect(prettyCodec("cinepak")).toBe("CINEPAK");
    expect(prettyCodec(null)).toBeNull();
  });
});

describe("channelLayout", () => {
  it("traduit un nombre de canaux en disposition", () => {
    expect(channelLayout(8)).toBe("7.1");
    expect(channelLayout(6)).toBe("5.1");
    expect(channelLayout(2)).toBe("2.0");
    expect(channelLayout(3)).toBe("3 ch");
    expect(channelLayout(null)).toBeNull();
  });
});

describe("describeFileTracks", () => {
  it("relie enfin chaque langue à son format audio", () => {
    const { audio } = describeFileTracks(realFile);
    expect(audio).toHaveLength(2);
    expect(audio[0]).toMatchObject({ language: "fr", codec: "EAC3", channels: 8, atmos: true });
    expect(audio[1]).toMatchObject({ language: "en", codec: "EAC3", channels: 6, atmos: false });
  });

  it("rend distinctes six pistes de sous-titres que Bazarr aplatissait en quatre identiques", () => {
    const { subtitles } = describeFileTracks(realFile);
    const shown = subtitles.map((s) => [s.language, s.forced, s.codec].join("/"));
    expect(shown).toEqual([
      "fr/true/ASS",
      "fr/false/ASS",
      "fr/true/SRT",
      "fr/false/SRT",
      "en/true/SRT",
      "en/false/SRT",
    ]);
    expect(new Set(shown).size).toBe(shown.length);
  });

  /**
   * Quatre de ces pistes portent `IsForced: false` et ne disent « Forced » que dans leur nom.
   * S'en tenir au drapeau les rendrait indistinguables de leur jumelle intégrale.
   */
  it("croit le nom d'une piste quand le drapeau du conteneur est absent", () => {
    const { subtitles } = describeFileTracks(realFile);
    expect(subtitles[2]).toMatchObject({ forced: true, codec: "SRT" });
    expect(subtitles[3]).toMatchObject({ forced: false });
  });

  it("repère les sous-titres pour sourds et malentendants, par drapeau ou par nom", () => {
    const { subtitles } = describeFileTracks([
      { Type: "Subtitle", Language: "eng", Codec: "subrip", IsHearingImpaired: true },
      { Type: "Subtitle", Language: "fre", Codec: "subrip", Title: "Français SDH" },
      { Type: "Subtitle", Language: "fre", Codec: "subrip", Title: "Français" },
    ]);
    expect(subtitles.map((s) => s.hearingImpaired)).toEqual([true, true, false]);
  });

  it("distingue un fichier posé à côté du film d'une piste du conteneur", () => {
    const { subtitles } = describeFileTracks([
      { Type: "Subtitle", Language: "fre", Codec: "subrip", IsExternal: true },
      { Type: "Subtitle", Language: "fre", Codec: "subrip" },
    ]);
    expect(subtitles.map((s) => s.external)).toEqual([true, false]);
  });

  it("réduit fre et fra à la même langue, comme partout ailleurs dans l'app", () => {
    const { audio } = describeFileTracks([
      { Type: "Audio", Language: "fre" },
      { Type: "Audio", Language: "fra" },
    ]);
    expect(audio.map((a) => a.language)).toEqual(["fr", "fr"]);
  });

  it("garde le nom d'une piste tel quel, et n'en retire que le code de langue qui le préfixe", () => {
    // Le nom porte souvent la seule chose qui distingue deux pistes de même langue — ici une
    // audiodescription. On ne le raccourcit donc pas.
    const { audio } = describeFileTracks([{ Type: "Audio", Language: "fre", Title: "French (France) AD" }]);
    expect(audio[0].title).toBe("French (France) AD");

    const { audio: prefixed } = describeFileTracks([{ Type: "Audio", Language: "fre", Title: "fr VFQ" }]);
    expect(prefixed[0].title).toBe("VFQ");
  });

  it("laisse passer une piste sans langue déclarée sans rien inventer", () => {
    const { audio } = describeFileTracks([{ Type: "Audio", Language: "und", Codec: "aac" }]);
    expect(audio[0].language).toBeNull();
    expect(audio[0].codec).toBe("AAC");
  });
});
