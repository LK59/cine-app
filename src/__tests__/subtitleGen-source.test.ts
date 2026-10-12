import { describe, it, expect } from "vitest";
import { isFullTrack, orderCandidates, presentLanguages, sourceHash } from "@/lib/subtitleGen/source";
import type { JellyfinMediaStream } from "@/lib/clients/jellyfin";

/**
 * Le choix de la piste source (DECISIONS.md §69) : texte seulement, jamais une piste forcée — mais
 * le drapeau ment dans les deux sens, c'est le nombre de répliques qui tranche.
 */
const sub = (Index: number, over: Partial<JellyfinMediaStream> = {}): JellyfinMediaStream => ({ Type: "Subtitle", Index, Codec: "subrip", ...over });

describe("orderCandidates", () => {
  it("écarte les sous-titres image et la langue cible", () => {
    const order = orderCandidates(
      [sub(2, { Codec: "PGSSUB", Language: "eng" }), sub(3, { Language: "fre" }), sub(4, { Language: "eng" }), sub(5, { Codec: "dvd_subtitle", Language: "spa" })],
      "fr",
      "en"
    );
    expect(order.map((c) => c.index)).toEqual([4]);
  });

  it("préfère la langue d'origine, puis l'anglais complet, puis les SDH, puis les autres", () => {
    const order = orderCandidates(
      [
        sub(2, { Language: "spa" }),
        sub(3, { Language: "eng", IsHearingImpaired: true }),
        sub(4, { Language: "eng" }),
        sub(5, { Language: "ita" }),
        sub(6, { Language: "ita", Title: "SDH" }),
      ],
      "fr",
      "it"
    );
    expect(order.map((c) => c.index)).toEqual([5, 4, 6, 3, 2]);
  });

  it("essaie en dernier une piste marquée forcée (Soy Luna : un SDH complet marqué forcé)", () => {
    const order = orderCandidates([sub(2, { Language: "spa", IsForced: true, IsHearingImpaired: true }), sub(3, { Language: "spa", Title: "Forced" }), sub(4)], "fr", "es");
    // La piste sans langue (Wonka : trente-six pistes sans étiquette) passe avant les « forcées ».
    expect(order.map((c) => c.index)).toEqual([4, 3, 2]);
    expect(order[0].language).toBeNull();
    expect(order[1].forcedFlag).toBe(true);
  });
});

describe("isFullTrack — le nombre de répliques tranche, pas le drapeau", () => {
  it("accepte un sous-titre complet, même marqué forcé", () => {
    expect(isFullTrack(1200, 6000, 5900)).toBe(true);
  });
  it("refuse un vrai forcé, même non marqué", () => {
    expect(isFullTrack(40, 6000, 5900)).toBe(false);
    // Cent cinquante lignes sur deux heures : un film très parlé dans une autre langue.
    expect(isFullTrack(150, 7200, 7000)).toBe(false);
  });
  it("prend l'étendue des répliques quand la durée manque", () => {
    expect(isFullTrack(300, null, 1800)).toBe(true);
  });
});

describe("presentLanguages", () => {
  it("compte les pistes texte complètes, ni les forcées ni les images", () => {
    expect(presentLanguages([sub(2, { Language: "fre", IsForced: true }), sub(3, { Language: "ger", Codec: "PGSSUB" }), sub(4, { Language: "eng", IsExternal: true })])).toEqual(["en"]);
  });
});

describe("sourceHash", () => {
  it("change avec le texte ou les minutages", () => {
    const a = sourceHash([{ start: 1, end: 2, text: "Bonjour" }]);
    expect(sourceHash([{ start: 1, end: 2, text: "Bonjour" }])).toBe(a);
    expect(sourceHash([{ start: 1, end: 2, text: "Bonsoir" }])).not.toBe(a);
    expect(sourceHash([{ start: 1.5, end: 2, text: "Bonjour" }])).not.toBe(a);
  });
});
