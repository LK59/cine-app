import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Le pare-feu devant le proxy bannit pour des heures une adresse qui demande plus de 40 adresses
 * distinctes non statiques en rafale (CrowdSec, `http-crawl-non_statics` : seau de 40, vidé de deux
 * par seconde, groupé par adresse et par hôte). Le 11/11/2026, la page Statistiques l'a déclenché :
 * ses ~60 liens `/person/<id>` étaient préchargés par Next dès qu'ils paraissaient à l'écran
 * (`/person/9874?_rsc=…`), et l'ordinateur de l'administrateur a été coupé de tout le serveur.
 */

const preloaded: string[] = [];
vi.mock("swr", () => ({ preload: (key: string) => { preloaded.push(key); return Promise.resolve(undefined); } }));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("aucune rafale d'adresses que le pare-feu prendrait pour un robot", () => {
  it("aucun lien Next ne se précharge à l'affichage : chaque <Link> porte prefetch={false}", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      if (!/from ["']next\/link["']/.test(source)) continue;
      for (const match of source.matchAll(/<Link(?=\s)[^>]*>/g)) {
        if (!match[0].includes("prefetch={false}")) offenders.push(`${file}: ${match[0].slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  beforeEach(async () => {
    preloaded.length = 0;
    (await import("@/lib/prefetch")).resetTitleSheetPrefetch();
  });

  it("un balayage de la souris sur une grille n'avance qu'une fiche par 600 ms", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const { prefetchMovieDetail, prefetchSeriesDetail } = await import("@/lib/prefetch");
      // Trente affiches survolées en trois secondes : sans garde, soixante adresses distinctes.
      for (let i = 0; i < 30; i++) {
        if (i % 2) prefetchMovieDetail(i);
        else prefetchSeriesDetail(i);
        vi.advanceTimersByTime(100);
      }
      const distinct = new Set(preloaded);
      expect(distinct.size).toBeLessThanOrEqual(15);
      // Un survol qui s'attarde avance toujours sa fiche.
      vi.advanceTimersByTime(600);
      prefetchMovieDetail(999);
      expect(preloaded).toContain("/api/radarr/movies/999");
    } finally {
      vi.useRealTimers();
    }
  });
});
