import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mutate = vi.fn().mockResolvedValue(undefined);
vi.mock("swr", () => ({ mutate: (...a: unknown[]) => mutate(...a) }));

import { refreshAfterPlayback, RESUME_KEY, NEXT_UP_KEY, progressKey } from "@/lib/swr";
import { setWatchingFullScreen } from "@/lib/playbackBusy";

/**
 * Les clés nommées, le filtre des séries mis à part.
 *
 * `refreshAfterPlayback` demande aussi la relecture par *motif* — la liste d'épisodes d'une série
 * est bâtie sur l'identifiant de la série, que la fermeture ne connaît pas. Ces tests-ci parlent
 * des clés que l'on nomme ; le filtre a le sien.
 */
const namedKeys = (): string[] =>
  mutate.mock.calls.map((c) => c[0]).filter((k): k is string => typeof k === "string");

beforeEach(() => {
  vi.clearAllMocks();
  setWatchingFullScreen(false);
});
afterEach(() => setWatchingFullScreen(false));

describe("refreshAfterPlayback", () => {
  // Le symptôme : quitter un film à trente minutes laissait sa fiche sur « Lecture » et la rangée
  // « Reprendre » inchangée, jusqu'à ce qu'on quitte l'écran et qu'on y revienne.
  it("relit les trois vues que la fermeture rend fausses", async () => {
    await refreshAfterPlayback(Promise.resolve(), "item-42");
    expect(namedKeys().sort()).toEqual([NEXT_UP_KEY, RESUME_KEY, progressKey("item-42")].sort());
  });

  // Le symptôme : l'accueil se mettait à jour, la fiche de la série non — elle proposait encore
  // de reprendre l'épisode qu'on venait de terminer.
  it("relit aussi la liste d'épisodes des séries, sans toucher au catalogue", async () => {
    await refreshAfterPlayback(Promise.resolve(), "item-42");
    const filtre = mutate.mock.calls.map((c) => c[0]).find((k) => typeof k === "function");
    expect(filtre).toBeTypeOf("function");
    expect(filtre("/api/cinema/series/abc/episodes")).toBe(true);
    // La barre oblique finale : le catalogue entier fait 1,4 Mo et n'a rien à faire ici.
    expect(filtre("/api/cinema/series")).toBe(false);
    expect(filtre("/api/cinema/movies")).toBe(false);
  });

  it("se limite aux vues d'ensemble quand aucun titre n'est nommé", async () => {
    await refreshAfterPlayback(Promise.resolve(), null);
    expect(namedKeys().sort()).toEqual([NEXT_UP_KEY, RESUME_KEY].sort());
  });

  // Relire avant que Jellyfin ait enregistré l'arrêt redonne exactement la valeur qu'on voulait
  // remplacer — et avec elle la conviction d'avoir rafraîchi.
  it("attend que le rapport d'arrêt soit parti", async () => {
    let arrive!: () => void;
    const reported = new Promise<void>((r) => (arrive = r));
    const fini = refreshAfterPlayback(reported, "item-42");
    await Promise.resolve();
    expect(mutate).not.toHaveBeenCalled();
    arrive();
    await fini;
    expect(mutate).toHaveBeenCalled();
  });

  // SWR est en pause tant qu'un film occupe l'écran entier, et une requête mise en pause est
  // abandonnée, pas différée : demander la relecture pendant l'animation de fermeture, c'est la
  // jeter. On attend donc que l'écran soit rendu.
  it("attend que l'écran soit libéré avant de demander quoi que ce soit", async () => {
    vi.useFakeTimers();
    try {
      setWatchingFullScreen(true);
      const fini = refreshAfterPlayback(Promise.resolve(), "item-42");
      await vi.advanceTimersByTimeAsync(150);
      expect(mutate).not.toHaveBeenCalled();

      setWatchingFullScreen(false);
      await vi.advanceTimersByTimeAsync(100);
      await fini;
      expect(namedKeys()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // Une attente sans fin sur un lecteur qui ne se ferme pas serait une fuite silencieuse.
  it("abandonne si l'écran ne se libère jamais", async () => {
    vi.useFakeTimers();
    try {
      setWatchingFullScreen(true);
      const fini = refreshAfterPlayback(Promise.resolve(), "item-42");
      await vi.advanceTimersByTimeAsync(5000);
      await fini;
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
