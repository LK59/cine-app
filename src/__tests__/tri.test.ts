import { describe, expect, it } from "vitest";
import { accountScore, burstShare, deviceOf, flagsOf, genreDistance, titleScore } from "@/lib/tri/score";
import { buildPlan, indexFiles, localPath, type DiskFile } from "@/lib/tri/plan";
import { deviceAround, episodeOfTitle } from "@/lib/tri/logs";
import { parseTarget } from "@/lib/tri/target";
import type { QbTorrent } from "@/lib/clients/qbittorrent";

// Le tri de la bibliothèque (DECISIONS.md §198).

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-19T12:00:00Z");

describe("scores", () => {
  it("signale documentaires, animation, téléfilms et mauvaises notes", () => {
    expect(flagsOf("movie", ["Animation", "Family"], 6.8)).toEqual(["animationMovie"]);
    expect(flagsOf("series", ["Animation"], null)).toEqual(["animationSeries"]);
    expect(flagsOf("movie", ["Documentary", "TV Movie"], 4.2)).toEqual(["documentary", "tvMovie", "lowRating"]);
    expect(flagsOf("movie", ["Drama"], 0)).toEqual([]);
  });

  it("mesure l'éloignement des goûts, et se tait sans assez d'historique", () => {
    const watched = new Map([
      ["Drama", 10],
      ["Comedy", 5],
    ]);
    expect(genreDistance(["Drama"], watched)).toBe(0);
    expect(genreDistance(["Comedy", "Horror"], watched)).toBe(0.5);
    expect(genreDistance(["Horror"], watched)).toBe(1);
    expect(genreDistance(["Horror"], new Map([["Drama", 2]]))).toBeNull();
  });

  it("met en tête un titre jamais ouvert, vieux, mal noté et lourd", () => {
    const worst = titleScore({ neverOpened: true, stale: false, since: NOW - 400 * DAY, flags: ["documentary", "lowRating"], rating: 4.5, distance: 1, requesterScore: 20, sizeBytes: 80e9, now: NOW });
    const best = titleScore({ neverOpened: false, stale: false, since: NOW - 10 * DAY, flags: [], rating: 8.2, distance: 0, requesterScore: 90, sizeBytes: 2e9, now: NOW });
    expect(worst.score).toBeGreaterThanOrEqual(95);
    expect(best.score).toBeLessThan(5);
    // Chaque point se justifie.
    expect(worst.reasons.map((r) => r.key)).toEqual(["neverOpened", "age", "category", "rating", "distance", "requester", "size"]);
  });

  it("note un compte sur 100, part par part", () => {
    const good = accountScore({ requests: 10, available: 10, opened: 10, avgRating: 8, neverOpenedBytes: 0, burstShare: 0, profiles: 1, last90Days: 3 });
    expect(good.score).toBe(100);
    const bad = accountScore({ requests: 100, available: 95, opened: 0, avgRating: 5, neverOpenedBytes: 600e9, burstShare: 1, profiles: 5, last90Days: 80 });
    expect(bad.score).toBe(0);
    expect(bad.parts.reduce((a, p) => a + p.max, 0)).toBe(100);
  });

  it("compte les rafales : cinq demandes ou plus le même jour", () => {
    const burst = Array.from({ length: 5 }, () => "2026-11-01T10:00:00Z");
    expect(burstShare([...burst, "2026-11-02T10:00:00Z"])).toBe(0.83);
    expect(burstShare([])).toBe(0);
  });

  it("lit le type d'appareil, sans confondre un iPad et un Mac quand rien ne le dit", () => {
    expect(deviceOf("iPhone · Safari", undefined)).toBe("iPhone");
    expect(deviceOf(undefined, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18 Safari/605.1.15")).toBe("iPad ou Mac");
    expect(deviceOf(undefined, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157")).toBe("Windows");
    expect(deviceOf(undefined, undefined)).toBeNull();
  });
});

describe("journaux", () => {
  it("rattache une demande à l'appareil actif dans la demi-heure", () => {
    const events = [
      { user: "a", at: NOW - 40 * 60_000, device: "Mac" },
      { user: "a", at: NOW - 10 * 60_000, device: "iPhone" },
      { user: "a", at: NOW + 5 * 60_000, device: "iPhone" },
      { user: "b", at: NOW, device: "Android" },
    ];
    expect(deviceAround(events, "a", NOW)).toBe("iPhone");
    expect(deviceAround(events, "c", NOW)).toBeNull();
  });

  it("lit la série et l'épisode dans le titre d'une ligne", () => {
    expect(episodeOfTitle("Peaky Blinders — S04E03 · Blackbird")).toEqual({ series: "Peaky Blinders", episode: "S04E03" });
    expect(episodeOfTitle("Frozen II")).toEqual({ series: null, episode: null });
  });
});

describe("plan de suppression", () => {
  const R = "/mnt/media/video";
  const file = (path: string, inode: string, links: number, size: number): DiskFile => ({ path, inode, links, size });
  const torrent = (hash: string, name: string, content: string, category = "prive_movie", size = 100): QbTorrent =>
    ({ hash, name, category, size, content_path: content, save_path: content.slice(0, content.lastIndexOf("/")) }) as QbTorrent;

  // Le film, son seed, deux cross-seeds (liens du même fichier), un torrent étranger, et un pack de
  // séries dont un fichier sert aussi un autre titre de la bibliothèque.
  const files = [
    file(`${R}/movies/Film (2019)/Film (2019).mkv`, "1:10", 4, 100),
    file(`${R}/movies/Film (2019)/Film (2019).fr.srt`, "1:11", 1, 1),
    file(`${R}/downloads/seeds/movies/Film.2019.mkv`, "1:10", 4, 100),
    file(`${R}/downloads/seeds/cross-seed-links/a/Film.2019.mkv`, "1:10", 4, 100),
    file(`${R}/downloads/seeds/cross-seed-links/b/Film.2019.mkv`, "1:10", 4, 100),
    file(`${R}/downloads/seeds/movies/Autre.mkv`, "1:20", 2, 50),
    file(`${R}/movies/Autre (2020)/Autre.mkv`, "1:20", 2, 50),
    file(`${R}/tv/Serie/S01E01.mkv`, "1:30", 3, 10),
    file(`${R}/tv/Serie/S01E02.mkv`, "1:31", 2, 10),
    file(`${R}/downloads/seeds/tv/Pack/S01E01.mkv`, "1:30", 3, 10),
    file(`${R}/downloads/seeds/tv/Pack/S01E02.mkv`, "1:31", 2, 10),
    file(`${R}/tv/Autre Serie/E01.mkv`, "1:40", 2, 10),
    file(`${R}/downloads/seeds/tv/Pack2/S01E01.mkv`, "1:30", 3, 10),
    file(`${R}/downloads/seeds/tv/Pack2/E01.mkv`, "1:40", 2, 10),
  ];
  const index = { files, byInode: indexFiles(files) };
  const torrents = [
    torrent("a".repeat(40), "Film.2019.mkv", "/media/downloads/seeds/movies/Film.2019.mkv"),
    torrent("b".repeat(40), "Film.2019.mkv", "/media/downloads/seeds/cross-seed-links/a/Film.2019.mkv", "cross-seed-link"),
    torrent("c".repeat(40), "Film.2019.mkv", "/media/downloads/seeds/cross-seed-links/b/Film.2019.mkv", "prive_movie.cross-seed"),
    torrent("d".repeat(40), "Autre.mkv", "/media/downloads/seeds/movies/Autre.mkv"),
    torrent("e".repeat(40), "Pack", "/media/downloads/seeds/tv/Pack", "prive_tv"),
    torrent("f".repeat(40), "Pack2", "/media/downloads/seeds/tv/Pack2", "prive_tv"),
    // Un « contenu » qui est un dossier de catégorie entier (métadonnées pas encore reçues) : jamais retenu.
    torrent("0".repeat(40), "Magnet", "/media/downloads/seeds/movies", "prive_movie"),
  ];
  const base = { torrents, historyHashes: new Set<string>(), index, jellyseerrMediaId: 7, requests: 1 };

  it("emporte le seed et tous les cross-seeds, et rend tout l'espace", () => {
    const plan = buildPlan({ ...base, kind: "movie", id: 1, title: "Film", folder: `${R}/movies/Film (2019)` });
    expect(plan.torrents.map((t) => t.hash[0]).sort()).toEqual(["a", "b", "c"]);
    expect(plan.libraryFiles.map((f) => f.path)).toEqual(["movies/Film (2019)/Film (2019).fr.srt", "movies/Film (2019)/Film (2019).mkv"]);
    expect(plan.freedBytesEstimate).toBe(101);
    expect(plan.skipped).toEqual([]);
  });

  it("garde un torrent dont un fichier sert aussi un autre titre, et ne compte pas son espace", () => {
    const plan = buildPlan({ ...base, kind: "series", id: 2, title: "Serie", folder: `${R}/tv/Serie` });
    expect(plan.torrents.map((t) => t.hash[0])).toEqual(["e"]);
    expect(plan.skipped.map((s) => s.hash[0])).toEqual(["f"]);
    // S01E01 a encore un lien dans Pack2 (gardé) : seul S01E02 est rendu.
    expect(plan.freedBytesEstimate).toBe(10);
  });

  it("retrouve un torrent par l'historique, sans fichier commun", () => {
    const hist = torrent("9".repeat(40), "Film.REPACK", "/media/downloads/seeds/movies/Film.REPACK.mkv");
    const plan = buildPlan({ ...base, torrents: [...torrents, hist], historyHashes: new Set(["9".repeat(40)]), kind: "movie", id: 1, title: "Film", folder: `${R}/movies/Film (2019)` });
    expect(plan.torrents.find((t) => t.hash[0] === "9")?.why).toBe("historique");
  });

  it("change d'empreinte quand un torrent arrive", () => {
    const a = buildPlan({ ...base, kind: "movie", id: 1, title: "Film", folder: `${R}/movies/Film (2019)` });
    const b = buildPlan({ ...base, torrents: torrents.slice(0, 2), kind: "movie", id: 1, title: "Film", folder: `${R}/movies/Film (2019)` });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("traduit les chemins des services vers le disque monté ici", () => {
    expect(localPath("/media/movies/X")).toBe(`${R}/movies/X`);
  });
});

describe("requêtes", () => {
  it("n'accepte qu'un film ou une série et un identifiant entier", () => {
    expect(parseTarget({ kind: "movie", id: 3 })).toEqual({ kind: "movie", id: 3 });
    expect(parseTarget({ kind: "book", id: 3 })).toBeNull();
    expect(parseTarget({ kind: "series", id: "3" })).toBeNull();
    expect(parseTarget({ kind: "series", id: -1 })).toBeNull();
    expect(parseTarget(null)).toBeNull();
  });
});
