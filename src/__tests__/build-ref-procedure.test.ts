// La procédure de build affichée par la doc doit nommer le build par son commit.
//
// Symptôme d'origine (28/09) : la prod était construite par un simple `docker compose build`.
// Sans `BUILD_REF`, `next.config.js` se rabat sur un horodatage, et le champ `build` de chaque
// ligne de `player.log` est devenu « 2026-09-28 14:03 UTC » — treize builds ce jour-là, aucun ne
// désignant un commit, et un arbre de travail sale indiscernable d'un commit propre. La référence
// vient de `tools/build-ref.sh` (hash court, suffixé `-dirty` si l'arbre suivi a des changements),
// et chaque commande de build locale montrée par la doc doit la passer : c'est celle qu'on copie.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RACINE = join(__dirname, "..", "..");
const DOCS = ["CLAUDE.md", "README.md", "DEPLOYMENT.md"];
const REF = "BUILD_REF=$(tools/build-ref.sh)";

/** Les lignes des blocs de code clôturés — la prose peut nommer la commande sans la prescrire. */
function lignesDeCode(texte: string): string[] {
  const lignes: string[] = [];
  let dedans = false;
  for (const ligne of texte.split("\n")) {
    if (/^\s*```/.test(ligne)) {
      dedans = !dedans;
      continue;
    }
    if (dedans) lignes.push(ligne);
  }
  return lignes;
}

/** Une commande qui construit l'image localement : `compose build` ou `compose up --build`. */
function construitLocalement(ligne: string): boolean {
  if (!/docker compose\b/.test(ligne)) return false;
  // Tirer l'image publiée ne construit rien : GHCR porte déjà son commit.
  if (/\bpull\b|ghcr\.io/i.test(ligne)) return false;
  return /docker compose(\s+-\S+(\s+\S+)?)*\s+build\b/.test(ligne) || /\s--build\b/.test(ligne);
}

describe("procédure de build : BUILD_REF", () => {
  for (const doc of DOCS) {
    it(`${doc} : chaque build local passe ${REF}`, () => {
      const fautives = lignesDeCode(readFileSync(join(RACINE, doc), "utf8"))
        .filter(construitLocalement)
        .filter((l) => {
          const i = l.indexOf(REF);
          return i < 0 || i > l.indexOf("docker compose");
        });
      expect(fautives).toEqual([]);
    });
  }

  it("la doc montre au moins une commande de build (sinon le test ne prouve rien)", () => {
    const toutes = DOCS.flatMap((d) => lignesDeCode(readFileSync(join(RACINE, d), "utf8")));
    expect(toutes.filter(construitLocalement).length).toBeGreaterThanOrEqual(2);
  });
});
