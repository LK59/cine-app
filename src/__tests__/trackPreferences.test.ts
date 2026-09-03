import { describe, it, expect } from "vitest";
import {
  normaliseLanguage,
  trackLanguage,
  isAudioDescription,
  chooseAudioTrack,
  chooseSubtitleTrack,
  type TrackPreferences,
} from "@/lib/trackPreferences";

// Every case here is a track that exists in this library, or a preference this server actually
// serves. The whole point is that the two do not use the same words for the same thing.

const track = (over: Partial<Parameters<typeof trackLanguage>[0]> = {}) => ({
  language: null,
  name: null,
  isDefault: false,
  isForced: false,
  ...over,
});

const prefs = (over: Partial<TrackPreferences> = {}): TrackPreferences => ({
  audioLanguage: "fra",
  subtitleLanguage: "fra",
  subtitleMode: "Default",
  playDefaultAudioTrack: false,
  ...over,
});

describe("normaliseLanguage", () => {
  it("réconcilie les deux façons dont ISO 639-2 écrit le français", () => {
    // The whole feature turns on this line. The container says `fre`, Jellyfin's preference says
    // `fra`, and compared as strings they never match — so the preference matched nothing.
    expect(normaliseLanguage("fre")).toBe("fr");
    expect(normaliseLanguage("fra")).toBe("fr");
    expect(normaliseLanguage("fr-FR")).toBe("fr");
    expect(normaliseLanguage("FR")).toBe("fr");
    // Twenty languages have that split; German and Chinese are two more.
    expect(normaliseLanguage("ger")).toBe(normaliseLanguage("deu"));
    expect(normaliseLanguage("chi")).toBe(normaliseLanguage("zho"));
  });

  it("traite « aucune langue » comme une absence, pas comme une langue", () => {
    for (const nothing of [null, "", "und", "zxx", "mis", "mul"]) {
      expect(normaliseLanguage(nothing)).toBeNull();
    }
  });

  it("rend une langue inconnue telle quelle, pour que deux fichiers d'accord se retrouvent", () => {
    expect(normaliseLanguage("bre")).toBe("bre");
  });
});

describe("trackLanguage", () => {
  it("croit le code avant le nom, et ne laisse pas le nom le contredire", () => {
    // A name is free text; a code is not. "VO" in a title is a habit, not a declaration.
    expect(trackLanguage(track({ language: "fre", name: "ENG VO : AC3 5.1" }))).toBe("fr");
  });

  it("lit le nom seulement quand il n'y a pas de code — trois pistes le sont ici", () => {
    expect(trackLanguage(track({ name: "FR VFF : AC3 5.1" }))).toBe("fr");
    expect(trackLanguage(track({ language: "und", name: "VFQ" }))).toBe("fr");
    expect(trackLanguage(track({ name: "Espagnol [VO]" }))).toBe("es");
    expect(trackLanguage(track({ name: "Dolby Digital - 5.1 - Par défaut" }))).toBeNull();
  });
});

describe("chooseAudioTrack", () => {
  const french = track({ language: "fre", name: "FR VFF : DDP 5.1" });
  const english = track({ language: "eng", name: "ENG VO : AC3 5.1", isDefault: true });

  it("prend la piste demandée même si le fichier en préfère une autre", () => {
    expect(chooseAudioTrack([english, french], prefs())).toBe(french);
  });

  it("ne prend rien plutôt qu'une langue que personne n'a demandée", () => {
    // Handing over the only other track gives someone a film in a language they did not ask for
    // and says nothing about it. Leaving the file's own choice alone at least tells the truth.
    expect(chooseAudioTrack([english], prefs())).toBeNull();
  });

  it("laisse le fichier décider quand le compte le demande", () => {
    expect(chooseAudioTrack([english, french], prefs({ playDefaultAudioTrack: true }))).toBeNull();
  });

  it("n'attrape jamais une audiodescription au passage", () => {
    // A real track in this library: "French (France) AD". It is French, and it is the last thing
    // somebody asking for French wants.
    const described = track({ language: "fre", name: "French (France) AD", isDefault: true });
    const plain = track({ language: "fre", name: "French (France)" });
    expect(isAudioDescription(described)).toBe(true);
    expect(chooseAudioTrack([described, plain], prefs())).toBe(plain);
    // And when it is the only French track, nothing is chosen at all.
    expect(chooseAudioTrack([described, english], prefs())).toBeNull();
  });

  it("écarte de même un commentaire de réalisateur", () => {
    const commentary = track({ language: "fre", name: "Commentaire audio du réalisateur" });
    const plain = track({ language: "fre", name: "VFF" });
    expect(chooseAudioTrack([commentary, plain], prefs())).toBe(plain);
  });
});

describe("chooseSubtitleTrack", () => {
  const forced = track({ language: "fre", name: "Forcés", isForced: true });
  const full = track({ language: "fre", name: "Complets" });
  const english = track({ language: "eng", name: "English" });

  it("respecte « forcés seulement », qui est le réglage de ce compte", () => {
    const mode = prefs({ subtitleMode: "OnlyForced" });
    expect(chooseSubtitleTrack([full, forced], mode, "fre")).toBe(forced);
    // And shows nothing at all rather than a full track the viewer did not ask for.
    expect(chooseSubtitleTrack([full, english], mode, "fre")).toBeNull();
  });

  it("ne traduit pas une langue déjà entendue, sauf pour les répliques forcées", () => {
    // The film is being heard in French and the subtitles would have been in French too.
    expect(chooseSubtitleTrack([full], prefs({ subtitleMode: "Smart" }), "fre")).toBeNull();
    expect(chooseSubtitleTrack([full, forced], prefs({ subtitleMode: "Smart" }), "fre")).toBe(forced);
  });

  it("affiche des sous-titres complets quand l'audio est dans une autre langue", () => {
    // Heard in English, read in French: the forced track carries only the handful of lines the
    // film itself treats as foreign, which is not what somebody who cannot follow needs.
    expect(chooseSubtitleTrack([forced, full], prefs(), "eng")).toBe(full);
  });

  it("n'affiche rien quand le compte dit rien", () => {
    expect(chooseSubtitleTrack([full, forced], prefs({ subtitleMode: "None" }), "eng")).toBeNull();
  });

  it("n'affiche rien plutôt qu'une langue non demandée", () => {
    expect(chooseSubtitleTrack([english], prefs(), "jpn")).toBeNull();
  });
});
