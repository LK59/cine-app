import { describe, it, expect } from "vitest";
import { ALL_RIGHTS, allows, rightsKey } from "@/lib/books/rights";

/**
 * Les tags autorisés de Jellyfin (`AllowedTags`, 29/10/2026) : un compte qui n'en a pas voit tout ce que
 * ses bibliothèques montrent ; un compte qui en a ne voit que les livres qui en portent un — comme Jellyfin,
 * qui répondait déjà 404 sur la fiche et le fichier des autres.
 */
describe("les tags autorisés", () => {
  const book = (tags: string[]) => ({ library: "l", tags, rated: false });
  it("aucun : rien ne change", () => {
    expect(allows(ALL_RIGHTS, book([]))).toBe(true);
  });
  it("une liste : seulement les livres qui en portent un", () => {
    const r = { ...ALL_RIGHTS, allowed: ["jeunesse"] };
    expect(allows(r, book(["Jeunesse"]))).toBe(true);
    expect(allows(r, book(["policier"]))).toBe(false);
    expect(allows(r, book([]))).toBe(false);
  });
  it("deux comptes aux tags autorisés différents n'ont pas la même vue", () => {
    expect(rightsKey({ ...ALL_RIGHTS, allowed: ["a"] })).not.toBe(rightsKey(ALL_RIGHTS));
  });
});
