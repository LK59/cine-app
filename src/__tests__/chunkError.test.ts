import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isChunkLoadError, recoverFromChunkError, forgetChunkReload } from "@/lib/chunkError";

/**
 * Le morceau de code disparu du serveur.
 *
 * Deux clients cinéma — le mobile et le bureau — sont chargés à la demande, donc redimensionner
 * la fenêtre au-delà du point de bascule déclenche un import à l'exécution. Un déploiement renomme
 * ces fichiers d'après le hachage de leur contenu : un onglet resté ouvert pendant une mise en
 * production demande un nom qui n'existe plus. Rien n'est cassé dans l'application ; la page est
 * simplement plus vieille que le serveur.
 */
describe("isChunkLoadError", () => {
  it("reconnaît le message exact que le navigateur produit", () => {
    const seen = new Error("Failed to load chunk /_next/static/chunks/33w2cjkwc465y.js from module 239");
    expect(isChunkLoadError(seen)).toBe(true);
  });

  it("reconnaît les autres formulations et le nom d'erreur dédié", () => {
    const named = Object.assign(new Error("boom"), { name: "ChunkLoadError" });
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error("Loading chunk 42 failed"))).toBe(true);
    expect(isChunkLoadError(new Error("error loading dynamically imported module"))).toBe(true);
  });

  // Recharger sur une vraie erreur applicative masquerait le défaut au lieu de le montrer.
  it("laisse passer une erreur ordinaire", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("recoverFromChunkError", () => {
  const reload = vi.fn();
  beforeEach(() => {
    reload.mockClear();
    vi.stubGlobal("sessionStorage", (() => {
      const map = new Map<string, string>();
      return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      };
    })());
    vi.stubGlobal("window", { location: { reload } });
  });
  afterEach(() => vi.unstubAllGlobals());

  // Le bouton « Réessayer » ne pouvait rien : webpack garde en mémoire la promesse rejetée du
  // morceau absent, donc refaire le rendu redemande le même nom disparu.
  it("recharge la page la première fois", () => {
    expect(recoverFromChunkError()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Un déploiement à moitié publié servirait un index neuf et des fichiers anciens : recharger en
  // boucle donnerait un écran clignotant dont personne ne peut sortir.
  it("ne recharge pas une seconde fois, et rend la main au viseur", () => {
    recoverFromChunkError();
    reload.mockClear();
    expect(recoverFromChunkError()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("rend sa tentative au prochain onglet une fois l'application montée", () => {
    recoverFromChunkError();
    forgetChunkReload();
    reload.mockClear();
    expect(recoverFromChunkError()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Une garde qui lève sur le chemin d'erreur de quelqu'un d'autre devient l'erreur.
  it("recharge quand même si le stockage refuse de répondre", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("refusé"); },
      setItem: () => { throw new Error("refusé"); },
      removeItem: () => { throw new Error("refusé"); },
    });
    expect(() => forgetChunkReload()).not.toThrow();
    expect(recoverFromChunkError()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
