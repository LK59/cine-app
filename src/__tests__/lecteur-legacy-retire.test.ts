import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Le lecteur legacy par compte a disparu le 13/10/2026 (DECISIONS.md §4) : le lecteur natif est
 * toujours le chemin par défaut, et le repli vers le lecteur serveur reste automatique.
 *
 * Lu dans la source, comme `decisions-partagees.test.ts` : la faute à attraper est un retour de la
 * préférence par un chemin qu'aucun test de comportement ne couvre — un écran qui la propose de
 * nouveau, un hôte qui l'attend, une route qui la lit.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Le code seul : les commentaires gardent l'histoire, et ont le droit de la nommer. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

describe("le lecteur legacy par compte", () => {
  it("n'existe plus dans le code", () => {
    const offenders = sources("src").filter((file) =>
      /legacyPlayer|useLegacyPlayer|LegacyPlayerSection|getLegacyPlayer|setLegacyPlayer/.test(withoutComments(readFileSync(file, "utf8")))
    );
    expect(offenders).toEqual([]);
  });

  it("n'a plus de libellés, dans aucune langue", () => {
    for (const locale of ["fr", "en", "es", "de"]) {
      const dict = JSON.parse(readFileSync(`src/locales/${locale}.json`, "utf8")) as { settings: Record<string, unknown> };
      expect(dict.settings.legacyPlayer, locale).toBeUndefined();
    }
  });
});
