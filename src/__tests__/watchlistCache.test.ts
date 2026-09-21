import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";

/**
 * La rangée « Ma liste » de l'accueil, mise à jour à chaud.
 *
 * Ce qui était demandé le 20/09/2026, mot pour mot : voir les ajouts et les retraits dans la
 * rangée de l'accueil sans recharger, **et même si la rangée n'existe pas encore**. Ce dernier
 * cas est le premier titre qu'on range : une rangée vide ne se dessine pas, donc il n'y a rien à
 * mettre à jour — il faut la faire naître.
 *
 * Le cache SWR est simulé : ce qu'on vérifie, c'est la transformation que `noteWatchlistChange`
 * demande, pas la mécanique de SWR.
 */
const appels: { key: unknown; updater: unknown; options: unknown }[] = [];
vi.mock("swr", () => ({
  mutate: (key: unknown, updater?: unknown, options?: unknown) => {
    appels.push({ key, updater, options });
    return Promise.resolve();
  },
}));

const { noteWatchlistChange } = await import("@/lib/watchlistCache");
const { TO_WATCH_KEY } = await import("@/lib/swr");

type Rangee = { items: { tmdbId: number; mediaType: string }[] } | undefined;
const appliquer = (avant: Rangee) => {
  const appel = appels.find((a) => a.key === TO_WATCH_KEY);
  return (appel!.updater as (c: Rangee) => { items: { tmdbId: number; mediaType: string }[] })(avant);
};

describe("noteWatchlistChange", () => {
  beforeEach(() => { appels.length = 0; });

  it("fait naître la rangée au tout premier ajout", () => {
    noteWatchlistChange({ tmdbId: 42, mediaType: "movie", title: "Alien" }, "to_watch");
    // Rien en cache : c'est exactement l'accueil d'un foyer qui n'a encore rien rangé.
    expect(appliquer(undefined).items.map((i) => i.tmdbId)).toEqual([42]);
  });

  it("met le dernier ajouté en tête, sans doublon", () => {
    noteWatchlistChange({ tmdbId: 42, mediaType: "movie" }, "to_watch");
    const avant = { items: [{ tmdbId: 7, mediaType: "movie" }, { tmdbId: 42, mediaType: "movie" }] };
    expect(appliquer(avant).items.map((i) => i.tmdbId)).toEqual([42, 7]);
  });

  it("retire le titre quand on le sort de la liste", () => {
    noteWatchlistChange({ tmdbId: 42, mediaType: "movie" }, null);
    const avant = { items: [{ tmdbId: 42, mediaType: "movie" }, { tmdbId: 7, mediaType: "movie" }] };
    expect(appliquer(avant).items.map((i) => i.tmdbId)).toEqual([7]);
  });

  it("ne confond pas un film et une série de même identifiant", () => {
    noteWatchlistChange({ tmdbId: 42, mediaType: "series" }, null);
    const avant = { items: [{ tmdbId: 42, mediaType: "movie" }, { tmdbId: 42, mediaType: "series" }] };
    expect(appliquer(avant).items.map((i) => i.mediaType)).toEqual(["movie"]);
  });

  it("n'attend pas le serveur pour la rangée, et relit tout le reste derrière", () => {
    noteWatchlistChange({ tmdbId: 42, mediaType: "movie" }, "to_watch");
    const rangee = appels.find((a) => a.key === TO_WATCH_KEY);
    expect(rangee?.options).toEqual({ revalidate: false });
    // Le second appel est un filtre de clés : toutes les vues de listes, quelle que soit la leur.
    const filtre = appels.find((a) => typeof a.key === "function")?.key as (k: unknown) => boolean;
    expect(filtre("/api/watchlist")).toBe(true);
    expect(filtre("/api/player/lists")).toBe(true);
    expect(filtre("/api/player/title/12")).toBe(true);
    expect(filtre("/api/cinema/movies")).toBe(false);
  });
});

/**
 * Le geste est posé à deux endroits — les fiches du mode cinéma et le lecteur — et ils avaient
 * divergé : depuis le lecteur les vues se relisaient, depuis une fiche cinéma rien ne bougeait.
 * C'est la dérive nommée dans `CLAUDE.md`, et elle se rattrape par la fonction partagée.
 */
describe("un seul geste pour ranger un titre", () => {
  it("les deux crochets passent par la même fonction", () => {
    for (const f of ["src/lib/useAddToWatchlist.ts", "src/lib/usePlayerTitleActions.ts"]) {
      expect(readFileSync(f, "utf8")).toMatch(/noteWatchlistChange\(/);
    }
  });

  it("aucun des deux ne réécrit son propre filtre de clés", () => {
    expect(readFileSync("src/lib/usePlayerTitleActions.ts", "utf8")).not.toMatch(/key\.startsWith\("\/api\/watchlist"\)/);
  });

  it("la clé de la rangée n'est plus recopiée à la main", () => {
    for (const f of ["src/lib/useCinemaMyList.ts", "src/app/(dashboard)/DashboardClient.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/"\/api\/watchlist\?status=to_watch"/);
    }
  });
});
