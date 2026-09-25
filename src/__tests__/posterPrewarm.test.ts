import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Les affiches préparées d'avance (25/09/2026) : la première demande d'une taille coûtait 60 à
 * 350 ms à qui ouvrait l'écran, et les affiches « se génèrent au fur et à mesure ».
 */
const movies = [
  { id: 1, tmdbId: 11, hasFile: true, images: [{ coverType: "poster", remoteUrl: "https://image.tmdb.org/t/p/original/a.jpg" }] },
  { id: 2, tmdbId: 22, hasFile: false, images: [{ coverType: "poster", remoteUrl: "https://image.tmdb.org/t/p/original/b.jpg" }] },
];
const series = [{ id: 3, tmdbId: 33, images: [{ coverType: "poster", remoteUrl: "https://artworks.thetvdb.com/banners/posters/c.jpg" }] }];
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: async () => movies,
  cachedSeries: async () => series,
}));
vi.mock("@/lib/title-art", () => ({
  getTitleArt: async (tmdbId: number) =>
    tmdbId === 11 ? { posterByLang: { en: "https://image.tmdb.org/t/p/w342/a-en.jpg" } } : { posterByLang: {} },
}));

import {
  DEFAULT_WIDTHS,
  collectPosterUrls,
  isOptimizable,
  prewarmPosters,
  prewarmSettings,
  startPosterPrewarm,
  variantPath,
} from "@/lib/posterPrewarm";

const ok = () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Response;

describe("les réglages", () => {
  it("par défaut : actif, 384 et 750 px, le français et la langue de l'installation", () => {
    expect(prewarmSettings({ APP_LANGUAGE: "en" })).toEqual({ enabled: true, widths: [384, 750], locales: ["fr", "en"] });
  });

  it("se coupe par l'interrupteur, et ignore une largeur ou une langue invalides", () => {
    expect(prewarmSettings({ POSTER_PREWARM: "false" }).enabled).toBe(false);
    const s = prewarmSettings({ POSTER_PREWARM_WIDTHS: "640, abc, -3", POSTER_PREWARM_LOCALES: "de,xx" });
    expect(s.widths).toEqual([640]);
    expect(s.locales).toEqual(["de"]);
  });

  it("retombe sur les valeurs par défaut quand tout est invalide", () => {
    const s = prewarmSettings({ POSTER_PREWARM_WIDTHS: "zéro", POSTER_PREWARM_LOCALES: "xx" });
    expect(s.widths).toEqual(DEFAULT_WIDTHS);
    expect(s.locales).toEqual(["fr"]);
  });
});

describe("les adresses", () => {
  it("ne prépare que ce que l'optimiseur accepte", () => {
    expect(isOptimizable("https://image.tmdb.org/t/p/w342/a.jpg")).toBe(true);
    expect(isOptimizable("https://artworks.thetvdb.com/banners/x.jpg")).toBe(true);
    expect(isOptimizable("https://exemple.com/a.jpg")).toBe(false);
    expect(isOptimizable("/api/jellyfin/image?itemId=1")).toBe(false);
    expect(isOptimizable(null)).toBe(false);
  });

  it("demande exactement la variante que next/image demande", () => {
    expect(variantPath("https://image.tmdb.org/t/p/w342/a.jpg", 384)).toBe(
      "/_next/image?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw342%2Fa.jpg&w=384&q=75"
    );
  });

  it("reprend la règle des routes du cinéma : l'affiche dans la langue, celle de Radarr sinon, pas les films sans fichier", async () => {
    const urls = await collectPosterUrls(["fr", "en"]);
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://image.tmdb.org/t/p/w342/a.jpg",
        "https://image.tmdb.org/t/p/w342/a-en.jpg",
        "https://artworks.thetvdb.com/banners/posters/c.jpg",
      ])
    );
    expect(urls.some((u) => u.includes("/b.jpg"))).toBe(false);
  });
});

describe("le préchauffage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("demande chaque variante une fois, et rien au passage suivant", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok());
    const done = new Set<string>();
    const urls = ["https://image.tmdb.org/t/p/w342/a.jpg", "https://exemple.com/refusée.jpg"];
    const first = await prewarmPosters(urls, { widths: [384, 750], base: "http://127.0.0.1:3000", done, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(first).toMatchObject({ prepared: 2, alreadyDone: 0, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:3000\/_next\/image\?url=/);

    const second = await prewarmPosters(urls, { widths: [384, 750], base: "http://127.0.0.1:3000", done, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(second).toMatchObject({ prepared: 0, alreadyDone: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("n'a jamais plus de deux demandes en vol", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ok();
    });
    const urls = Array.from({ length: 10 }, (_, i) => `https://image.tmdb.org/t/p/w342/${i}.jpg`);
    await prewarmPosters(urls, { widths: [384], base: "http://x", done: new Set(), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(peak).toBe(2);
  });

  it("s'arrête net quand l'optimiseur refuse d'affilée, sans rien marquer comme fait", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response);
    const done = new Set<string>();
    const urls = Array.from({ length: 50 }, (_, i) => `https://image.tmdb.org/t/p/w342/${i}.jpg`);
    const result = await prewarmPosters(urls, { widths: [384], base: "http://x", done, fetchImpl, concurrency: 1 });
    expect(result.stoppedEarly).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeLessThan(10);
    expect(done.size).toBe(0);
  });

  it("ne démarre rien quand l'interrupteur est coupé", () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    expect(startPosterPrewarm({ enabled: false, widths: [384], locales: ["fr"] })).toBe(false);
    expect(timers).not.toHaveBeenCalled();
  });
});
