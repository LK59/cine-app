import { describe, it, expect } from "vitest";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";

/**
 * Le garde-fou de `vitest.config.ts` : aucun test n'écrit dans les données de production.
 *
 * La suite tourne dans un conteneur qui monte le dépôt, `data/` compris — la base, les journaux,
 * les sauvegardes de l'instance qui sert la maison. Si le dossier jetable disparaît de la
 * configuration, c'est ici que ça se voit, et pas dans `server.log` une semaine plus tard.
 */
describe("dossier de données des tests", () => {
  it("n'est pas le dossier data/ du dépôt", () => {
    expect(path.resolve(DATA_DIR)).not.toBe(path.resolve(process.cwd(), "data"));
    expect(path.resolve(DATA_DIR).startsWith(path.resolve(process.cwd()) + path.sep)).toBe(false);
  });
});
