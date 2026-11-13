import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { catalogueIsEmpty } from "@/lib/cinemaPayload";

/**
 * Un catalogue n'est pas vide parce que sa sélection l'est (13/11/2026).
 *
 * La sélection (`spotlight`) est faite des dix dernières arrivées, filtrées par les tags bloqués du
 * compte : un compte dont les tags couvrent les dix derniers imports la reçoit vide sur des centaines
 * de titres visibles. Le bureau affichait alors « bibliothèque vide » en plein écran, sans onglet Séries.
 */
describe("catalogueIsEmpty", () => {
  it("une sélection vide sur des titres visibles n'est pas un catalogue vide", () => {
    expect(catalogueIsEmpty({ items: [{ id: 1 }], spotlight: [], rows: {} })).toBe(false);
    // Une charge utile d'avant `items` : les rangées comptent.
    expect(catalogueIsEmpty({ spotlight: [], rows: { Drame: [{ id: 1 }] } })).toBe(false);
  });

  it("vide quand aucun titre n'est là", () => {
    expect(catalogueIsEmpty({ items: [], spotlight: [], rows: {} })).toBe(true);
    expect(catalogueIsEmpty({ spotlight: [], rows: {} })).toBe(true);
  });

  it("ni le bureau ni le téléphone ne jugent le catalogue vide sur sa sélection", () => {
    for (const file of ["src/components/cinema/CinemaClient.tsx", "src/components/cinema/mobile/CinemaMobileClient.tsx"]) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/spotlight\.length === 0/);
      expect(source, file).toMatch(/catalogueIsEmpty\(/);
    }
  });
});
