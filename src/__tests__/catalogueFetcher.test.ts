import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Le catalogue ne se récupère que par `cinemaFetcher`.
 *
 * Il voyage dédouble — les titres une fois, des identifiants ailleurs — et c'est `cinemaFetcher`
 * qui lui rend sa forme complète. Un seul appel qui l'oublie et l'écran reçoit des nombres là où
 * il attend des titres : la grille tombe sur « radarrId in e », trois secondes après le
 * lancement, le temps qu'un préchargement différé se déclenche. C'est arrivé.
 *
 * Le piège n'est pas le composant qui lit — c'est le **préchargement**, qui remplit le même cache
 * SWR sans que rien à l'écran ne le montre. D'où ce test au niveau des sources plutôt qu'au
 * niveau d'un composant : il regarde tous les appelants d'un coup, y compris ceux qu'on ne pense
 * pas à ouvrir.
 */
describe("l'accès au catalogue", () => {
  /** Parcouru en JavaScript : le `grep` d'Alpine ne connaît pas `--include`, et ce test tourne là. */
  function sources(dir: string, out: string[] = []): string[] {
    for (const entree of readdirSync(dir, { withFileTypes: true })) {
      const chemin = join(dir, entree.name);
      if (entree.isDirectory()) {
        if (entree.name !== "__tests__") sources(chemin, out);
      } else if (/\.tsx?$/.test(entree.name) && entree.name !== "swr.ts") {
        out.push(chemin);
      }
    }
    return out;
  }

  const fichiers = sources("src").filter((f) => readFileSync(f, "utf8").includes("CATALOGUE_KEY"));

  it("passe toujours par cinemaFetcher, jamais par le récupérateur nu", () => {
    const fautifs: string[] = [];
    for (const fichier of fichiers) {
      const lignes = readFileSync(fichier, "utf8").split("\n");
      lignes.forEach((ligne, i) => {
        if (!/CATALOGUE_KEY/.test(ligne) || /^\s*import\b/.test(ligne)) return;
        // Le récupérateur est sur la même ligne, ou sur l'une des deux suivantes.
        const fenetre = lignes.slice(i, i + 3).join("\n");
        if (/\bcinemaFetcher\b/.test(fenetre)) return;
        if (/(?<!cinema)\bfetcher\b/.test(fenetre)) fautifs.push(`${fichier}:${i + 1}`);
      });
    }
    expect(fautifs).toEqual([]);
  });

  it("trouve bien les fichiers qu'il est censé surveiller", () => {
    // Un test de convention qui ne regarde rien passe toujours.
    expect(fichiers.length).toBeGreaterThan(4);
  });
});
