import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { backgroundJobsEnabled } from "@/lib/backgroundJobs";

/**
 * L'interrupteur des tâches de fond (DECISIONS.md §145) : une copie de l'application lancée à côté de la
 * vraie — le banc, une instance d'essai — ne doit rien faire d'elle-même aux vrais services.
 */
describe("CINE_BACKGROUND_JOBS", () => {
  it("par défaut les tâches tournent : la production ne règle rien", () => {
    expect(backgroundJobsEnabled({})).toBe(true);
    expect(backgroundJobsEnabled({ CINE_BACKGROUND_JOBS: "" })).toBe(true);
    expect(backgroundJobsEnabled({ CINE_BACKGROUND_JOBS: "on" })).toBe(true);
    // Une valeur inconnue ne coupe rien : une faute de frappe ne doit pas arrêter les sauvegardes.
    expect(backgroundJobsEnabled({ CINE_BACKGROUND_JOBS: "peut-être" })).toBe(true);
  });

  it("off, false, 0, no — quelle que soit la casse — les coupent", () => {
    for (const value of ["off", "OFF", " Off ", "false", "0", "no"]) expect(backgroundJobsEnabled({ CINE_BACKGROUND_JOBS: value })).toBe(false);
  });
});

/**
 * Ce test lit `instrumentation.ts` : toute tâche lancée au démarrage doit l'être derrière `if (jobs)`.
 * C'est lui qui évite la liste « toujours en retard d'une tâche » : en ajouter une sans la garde échoue
 * ici, et oblige à décider si une copie de test a le droit de la faire tourner.
 */
describe("src/instrumentation.ts", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/instrumentation.ts"), "utf8");
  /** Les seuls lancements permis sans l'interrupteur : des lectures qui préparent le catalogue. */
  const READ_ONLY = new Set(["startCatalogueWarm"]);

  it("ne lance une tâche de fond que derrière l'interrupteur", () => {
    const launches = [...source.matchAll(/^(.*?)\b(start[A-Z]\w*)\(\);/gm)].map((m) => ({ before: m[1], name: m[2] }));
    // Seize tâches au 11/11/2026 : si ce nombre tombe, c'est la lecture du fichier qui ne trouve plus rien.
    expect(launches.length).toBeGreaterThanOrEqual(16);
    // L'index des livres est gardé par un bloc autour du sien (un autre test fige la forme de son bloc).
    const WRAPPED = new Set(["startBooksPrewarm"]);
    const unguarded = launches.filter((l) => !READ_ONLY.has(l.name) && !WRAPPED.has(l.name) && !/if \(jobs\)\s*$/.test(l.before)).map((l) => l.name);
    expect(unguarded).toEqual([]);
    expect(source).toMatch(/if \(jobs\) \{\s*if \(config\.books\?\.enabled === true\) \{[\s\S]{0,160}?startBooksPrewarm\(\);\s*\}\s*\}/);
    expect(source).toContain("const jobs = backgroundJobsEnabled();");
  });

  it("le banc du lecteur le coupe pour ses instances", () => {
    const regress = fs.readFileSync(path.join(process.cwd(), "tools/regress-lecteur/regress.sh"), "utf8");
    expect(regress).toContain("-e CINE_BACKGROUND_JOBS=off");
  });
});
