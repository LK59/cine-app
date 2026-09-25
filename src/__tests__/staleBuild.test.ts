import { describe, it, expect } from "vitest";
import { isStaleBuild, mayReloadNow } from "@/lib/staleBuild";
import { GET } from "@/app/api/version/route";

describe("un onglet plus vieux que le serveur", () => {
  /**
   * 25/09/2026 : un Mac a regardé toute une soirée sur le code de 08:53, à travers une dizaine de
   * déploiements. La bannière de mise à jour ne pouvait pas le voir : elle revérifiait l'adresse
   * du worker de la page, qui porte le build de la page.
   */
  it("se reconnaît à un build servi différent du sien", () => {
    expect(isStaleBuild("2026-09-24 08:53 UTC", "b2f9f26")).toBe(true);
    expect(isStaleBuild("b2f9f26", "b2f9f26")).toBe(false);
  });

  it("ne conclut rien d'une réponse vide, étrangère ou d'un build de développement", () => {
    expect(isStaleBuild("b2f9f26", undefined)).toBe(false);
    expect(isStaleBuild("b2f9f26", "")).toBe(false);
    expect(isStaleBuild("b2f9f26", 42)).toBe(false);
    expect(isStaleBuild("b2f9f26", "dev")).toBe(false);
    expect(isStaleBuild("dev", "b2f9f26")).toBe(false);
  });
});

describe("le moment de recharger", () => {
  const calme = { filmOpen: false, benchRunning: false, typing: false, unsaved: false };

  it("est un moment où rien n'est en cours", () => {
    expect(mayReloadNow(calme)).toBe(true);
  });

  it.each([
    ["un film ouvert, même réduit ou diffusé", { ...calme, filmOpen: true }],
    ["un banc d'essai qui enchaîne les films", { ...calme, benchRunning: true }],
    ["un texte en cours d'écriture", { ...calme, typing: true }],
    ["un texte tapé et pas encore envoyé, même sans le curseur dedans", { ...calme, unsaved: true }],
  ])("n'est jamais pendant %s", (_nom, moment) => {
    expect(mayReloadNow(moment)).toBe(false);
  });
});

describe("/api/version", () => {
  it("donne le build servi, sans cache", async () => {
    const res = GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ build: expect.any(String) });
  });
});
