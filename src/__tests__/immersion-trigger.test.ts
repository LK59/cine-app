import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { IMMERSION_PATH, IMMERSION_POSTER, isImmersionQuery } from "@/lib/immersionTrigger";
import { immersionFilePath } from "@/lib/immersionFiles";

describe("le déclencheur du mode Immersion", () => {
  it("ne reconnaît que le mot exact, espaces et casse ignorés", () => {
    expect(isImmersionQuery("immersion")).toBe(true);
    expect(isImmersionQuery("  Immersion  ")).toBe(true);
    expect(isImmersionQuery("IMMERSION")).toBe(true);
  });

  it("laisse à la recherche tout ce qui n'est pas ce mot", () => {
    for (const typed of ["immersio", "immersions", "immersion*", "l'immersion", "immersion totale", "", "chalet"]) {
      expect(isImmersionQuery(typed), typed).toBe(false);
    }
  });

  it("mène à la page et à l'affiche servies par les routes du mode", () => {
    expect(IMMERSION_PATH).toBe("/immersion");
    expect(fs.existsSync(path.join(process.cwd(), "src/app/immersion/route.ts"))).toBe(true);
    // L'affiche est un fichier du build : son adresse doit être de celles que la route accepte.
    expect(IMMERSION_POSTER.startsWith("/api/immersion/")).toBe(true);
    expect(immersionFilePath(IMMERSION_POSTER.slice("/api/immersion/".length).split("/"))).not.toBeNull();
  });

  // Le cinéma ne sait rien du mode en dehors de cette règle : son code n'entre pas dans le sien.
  it("est le seul lien entre l'application et le projet immersion/", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(full);
        } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
          const source = fs.readFileSync(full, "utf8");
          if (/from\s+["'][^"']*\/immersion\/(src|public)\//.test(source) || /from\s+["']three["']|@react-three\//.test(source)) importers.push(full);
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(importers).toEqual([]);
  });
});
