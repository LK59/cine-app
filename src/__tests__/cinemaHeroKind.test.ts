import { describe, it, expect } from "vitest";
import { heroKindFor } from "@/lib/cinemaHeroKind";

describe("la sorte que montre la bannière", () => {
  it("suit l'onglet tant que rien n'a été survolé", () => {
    expect(heroKindFor(null, "movies")).toBe("movies");
    expect(heroKindFor(null, "series")).toBe("series");
  });

  it("suit la carte survolée, même d'une autre sorte que l'onglet", () => {
    // Le cas qui a introduit ce calcul : une série dans « Reprendre », sur l'onglet Films.
    expect(heroKindFor({ tab: "movies", kind: "series" }, "movies")).toBe("series");
    expect(heroKindFor({ tab: "series", kind: "movies" }, "series")).toBe("movies");
  });

  it("oublie un choix fait dans l'autre onglet", () => {
    // Sans quoi passer sur Séries après avoir survolé une série depuis Films y ramènerait une
    // bannière décidée ailleurs — et l'onglet s'ouvrirait sur autre chose que son propre contenu.
    expect(heroKindFor({ tab: "movies", kind: "series" }, "series")).toBe("series");
    expect(heroKindFor({ tab: "series", kind: "movies" }, "movies")).toBe("movies");
  });
});
