import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fr from "@/locales/fr.json";

/**
 * L'application vouvoie, partout (15/10/2026, décision de Louis — BUREAU-20, LECTEUR-14).
 *
 * Le cinéma vouvoyait (« Touchez Lecture pour reprendre », « Vérifiez la connexion et réessayez »),
 * mais ses messages d'erreur tutoyaient : « Ta session Jellyfin a expiré », « Le chargement prend trop
 * de temps. Réessaie. » au-dessus d'un bouton « Réessayer ». Les textes écrits à des époques
 * différentes avaient divergé ; ce test empêche qu'ils divergent de nouveau. Le français seulement :
 * l'anglais n'a pas la distinction, l'espagnol et l'allemand ont leurs propres conventions.
 */
const TU = /(?<![\p{L}'’])(tu|ta|ton|tes|toi|te|t['’])(?![\p{L}])/iu;
const IMPERATIVE = /(?<![\p{L}'’])(Réessaie|réessaie|Vérifie ta|Appuie sur|Choisis|Sélectionne au|Garde cette|Active ou|Ajoute des|Envoie une)(?![\p{L}])/u;

function strings(o: unknown, path = ""): [string, string][] {
  if (typeof o === "string") return [[path, o]];
  if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

describe("vouvoiement", () => {
  it("aucune chaîne française ne tutoie", () => {
    const offenders = strings(fr).filter(([, v]) => TU.test(v) || IMPERATIVE.test(v));
    expect(offenders).toEqual([]);
  });

  it("les notifications envoyées par le serveur non plus", () => {
    for (const file of ["src/lib/notificationJobs.ts", "src/lib/notifications.ts"]) {
      const code = readFileSync(join(process.cwd(), file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      const literals = code.match(/(["`])(?:(?!\1).)*\1/g) ?? [];
      expect(literals.filter((s) => TU.test(s)), file).toEqual([]);
    }
  });
});
