import { describe, it, expect } from "vitest";
import { passwordAttempts, hasLeadingSpace } from "@/lib/passwordAttempts";

// Un mot de passe collé arrive régulièrement lesté d'une espace finale. Il a l'air juste, il ne
// marche pas, et l'écran ne répond que « identifiants invalides ».

describe("passwordAttempts", () => {
  it("n'essaie qu'une seule forme dans le cas courant", () => {
    // Aucun appel supplémentaire vers Jellyfin pour les connexions qui vont bien.
    expect(passwordAttempts("motdepasse")).toEqual(["motdepasse"]);
  });

  it("essaie la forme donnée AVANT la forme rognée", () => {
    // Ce qui distingue ceci d'un rognage : le mot de passe vit dans Jellyfin, pas ici. Un compte
    // dont le mot de passe finit vraiment par une espace doit continuer de s'ouvrir.
    expect(passwordAttempts("secret ")).toEqual(["secret ", "secret"]);
  });

  it("retire toutes les espaces finales, quelles qu'elles soient", () => {
    expect(passwordAttempts("secret  \t\n")).toEqual(["secret  \t\n", "secret"]);
  });

  it("ne touche jamais au début", () => {
    // Demandé ainsi, et plus sûr : une espace de tête se voit dès que le champ est révélé, et
    // l'écran la nomme désormais.
    expect(passwordAttempts(" secret")).toEqual([" secret"]);
    expect(passwordAttempts(" secret ")).toEqual([" secret ", " secret"]);
  });

  it("ne touche pas aux espaces du milieu", () => {
    expect(passwordAttempts("deux mots")).toEqual(["deux mots"]);
  });

  it("laisse un mot de passe entièrement blanc échouer comme il se doit", () => {
    // La seconde forme est vide : elle ne peut valider aucun compte, et c'est très bien.
    expect(passwordAttempts("   ")).toEqual(["   ", ""]);
  });
});

describe("hasLeadingSpace", () => {
  it("ne parle que de ce que la personne a tapé", () => {
    expect(hasLeadingSpace(" secret")).toBe(true);
    expect(hasLeadingSpace("\tsecret")).toBe(true);
    expect(hasLeadingSpace("secret ")).toBe(false);
    expect(hasLeadingSpace("secret")).toBe(false);
    expect(hasLeadingSpace("")).toBe(false);
  });
});
