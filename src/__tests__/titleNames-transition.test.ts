import { describe, it, expect, vi } from "vitest";

/**
 * Le passage des titres en `v3` (09/10/2026, DECISIONS.md §58) : tant que la nouvelle entrée n'est
 * pas calculée, l'ancienne sert d'intérim — un titre déjà connu ne retombe jamais sur celui de
 * Radarr ou Sonarr le jour du déploiement.
 */
const { disk, translations } = vi.hoisted(() => ({
  disk: new Map<string, { value: unknown; fetchedAt: number }>([
    ["tmdb:titles:v2:movie:680", { value: { fr: "Pulp Fiction (ancien)" }, fetchedAt: Date.now() }],
  ]),
  translations: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/lib/db", () => ({ kvCacheDb: { get: (k: string) => disk.get(k) ?? null, set: () => {} } }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/clients/tmdb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clients/tmdb")>();
  return { ...actual, tmdb: { ...actual.tmdb, isEnabled: () => true, getMovieTranslations: translations, getTvTranslations: translations } };
});

import { getTitleNames } from "@/lib/titleNames";

describe("le passage des titres en v3", () => {
  it("sert l'ancienne entrée et lance le recalcul en arrière-plan", () => {
    expect(getTitleNames(680, "movie").fr).toBe("Pulp Fiction (ancien)");
    expect(translations).toHaveBeenCalledTimes(1);
  });
});
