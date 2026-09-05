import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetMovieImages = vi.fn();
const mockGetTvImages = vi.fn();
vi.mock("@/lib/clients/tmdb", () => ({
  tmdb: {
    isEnabled: () => true,
    getMovieImages: (...a: unknown[]) => mockGetMovieImages(...a),
    getTvImages: (...a: unknown[]) => mockGetTvImages(...a),
  },
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
}));

// Pas de cache dans ces tests : on veut voir ce que la fonction calcule, pas ce qu'elle a retenu.
vi.mock("@/lib/server-cache", () => ({
  withPersistentCache: (_k: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe("getTitleArt", () => {
  // Le bug visible à l'écran : l'affiche de « Shameless » porte le titre peint dedans, et on
  // posait notre propre logo par-dessus — le nom apparaissait deux fois.
  it("picks the best textless poster, ignoring the ones with a language", async () => {
    mockGetTvImages.mockResolvedValue({
      posters: [
        { file_path: "/en-high.jpg", iso_639_1: "en", vote_average: 9 },
        { file_path: "/none-low.jpg", iso_639_1: null, vote_average: 1 },
        { file_path: "/none-high.jpg", iso_639_1: null, vote_average: 5 },
      ],
      logos: [{ file_path: "/logo.png", iso_639_1: "fr", vote_average: 3 }],
    });

    const { getTitleArt } = await import("@/lib/title-art");
    const art = await getTitleArt(34307, "series");
    expect(art.posterTextlessUrl).toBe("https://image.tmdb.org/t/p/w500/none-high.jpg");
    expect(art.logoUrl).toBe("https://image.tmdb.org/t/p/w500/logo.png");
  });

  // Tous les titres n'ont pas d'affiche sans texte : on retombe alors sur l'ordinaire, côté
  // interface, plutôt que de montrer un visuel muet.
  it("reports no textless poster rather than falling back to a titled one", async () => {
    mockGetMovieImages.mockResolvedValue({
      posters: [{ file_path: "/en.jpg", iso_639_1: "en", vote_average: 9 }],
      logos: [],
    });

    const { getTitleArt } = await import("@/lib/title-art");
    const art = await getTitleArt(603, "movie");
    expect(art.posterTextlessUrl).toBeNull();
    expect(art.logoUrl).toBeNull();
  });

  it("prefers a French logo, then English, then language-neutral", async () => {
    mockGetMovieImages.mockResolvedValue({
      logos: [
        { file_path: "/en.png", iso_639_1: "en", vote_average: 9 },
        { file_path: "/fr.png", iso_639_1: "fr", vote_average: 1 },
      ],
      posters: [],
    });

    const { getTitleArt } = await import("@/lib/title-art");
    expect((await getTitleArt(603, "movie")).logoUrl).toBe("https://image.tmdb.org/t/p/w500/fr.png");
  });

  // La route du catalogue résout toute la bibliothèque d'un coup : sans file d'attente, c'est un
  // millier de requêtes simultanées vers TMDB à la première ouverture, et autant de 429.
  it("never runs more than a dozen TMDB image calls at once", async () => {
    let running = 0;
    let peak = 0;
    mockGetMovieImages.mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return { logos: [], posters: [] };
    });

    const { getTitleArt } = await import("@/lib/title-art");
    await Promise.all(Array.from({ length: 60 }, (_, i) => getTitleArt(1000 + i, "movie")));
    expect(peak).toBeLessThanOrEqual(12);
    expect(mockGetMovieImages).toHaveBeenCalledTimes(60);
  });

  it("answers with nothing rather than throwing when TMDB fails", async () => {
    mockGetMovieImages.mockRejectedValue(new Error("429"));
    const { getTitleArt } = await import("@/lib/title-art");
    expect(await getTitleArt(603, "movie")).toEqual({ logoUrl: null, posterTextlessUrl: null });
  });
});
