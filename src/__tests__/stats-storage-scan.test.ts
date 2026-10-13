import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * L'analyse du stockage de la page Statistiques, sur une vraie arborescence avec de vrais liens
 * physiques — c'est l'inode qui dit si deux chemins sont un seul fichier, et aucun double de `fs`
 * ne le dirait honnêtement. Chaque cas reprend un chiffre faux relevé le 13/10/2026 en comparant
 * la page à `/mnt/media/video` et à Sonarr/Radarr.
 */

const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...a: unknown[]) => mockCachedMovies(...a),
  cachedSeries: (...a: unknown[]) => mockCachedSeries(...a),
}));
vi.mock("@/lib/clients/qbittorrent", () => ({ qbittorrent: { getTorrents: async () => [] } }));

let root: string;

function file(rel: string, size: number): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size));
  return full;
}
function link(fromRel: string, toRel: string) {
  const to = path.join(root, toRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.linkSync(path.join(root, fromRel), to);
}

type Stats = import("@/lib/storage-scan").StorageStats;
let stats: Stats;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cine-storage-scan-"));
  // Deux séries distinctes que Sonarr distingue par l'année de son titre.
  file("tv/Gossip Girl/Gossip Girl - S01E01 - Pilot.mkv", 1000);
  file("tv/Gossip Girl (2021)/Gossip Girl (2021) - S01E01 - Just Another Girl on the MTA.mkv", 2000);
  // Un seed du remake, autre fichier : c'est un vrai doublon, et du remake seulement.
  file("downloads/seeds/tv/Gossip Girl (2021) S01E01 MULTi 1080p WEB x264.mkv", 1500);
  // Un même épisode rangé par Sonarr dans deux séries : un seul fichier, deux noms.
  file("tv/Berlin (2023)/Season 2/Berlin (2023) - S02E01 - The Collection.mkv", 3000);
  link("tv/Berlin (2023)/Season 2/Berlin (2023) - S02E01 - The Collection.mkv",
    "tv/Berlin and the Lady with an Ermine/Season 1/Berlin and the Lady with an Ermine - S01E01 - The Collection.mkv");
  // Un film dont le seed (non importé) pèse plus que le fichier de la bibliothèque.
  file("movies/The Exorcist (1973)/The Exorcist (1973).mkv", 500);
  file("downloads/seeds/movies/The Exorcist (1973) v2 Theatrical MULTi 2160p BluRay x265.mkv", 800);
  // Un film correctement lié à son seed : ni doublon, ni orphelin.
  file("movies/Heat (1995)/Heat (1995).mkv", 700);
  link("movies/Heat (1995)/Heat (1995).mkv", "downloads/seeds/movies/Heat 1995 MULTi 1080p BluRay x265.mkv");

  process.env.MEDIA_ROOT = root;
  mockCachedMovies.mockResolvedValue([
    { id: 1, title: "The Exorcist", year: 1973, movieFile: { mediaInfo: { videoCodec: "x265" }, size: 500 } },
    { id: 2, title: "Heat", year: 1995, movieFile: { mediaInfo: { videoCodec: "x265" }, size: 700 } },
  ]);
  mockCachedSeries.mockResolvedValue([
    { id: 179, title: "Gossip Girl", year: 2007, path: "/media/tv/Gossip Girl" },
    { id: 180, title: "Gossip Girl (2021)", year: 2021, path: "/media/tv/Gossip Girl (2021)" },
    { id: 7, title: "Berlin (2023)", year: 2023, path: "/media/tv/Berlin (2023)" },
    { id: 8, title: "Berlin and the Lady with an Ermine", year: 2025, path: "/media/tv/Berlin and the Lady with an Ermine" },
  ]);

  vi.resetModules();
  const { getStorageStats } = await import("@/lib/storage-scan");
  // Le module lance son calcul au chargement, sans l'attendre : on repasse jusqu'à ce qu'il ait fini.
  for (let i = 0; i < 200; i++) {
    const s = getStorageStats();
    if (!s.computing && s.computedAt > 0) { stats = s; break; }
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!stats) throw new Error("l'analyse du stockage n'a pas abouti");
});

afterAll(() => {
  delete process.env.MEDIA_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("analyse du stockage (page Statistiques)", () => {
  it("ne prend pas deux séries homonymes d'années différentes pour des doublons", () => {
    const gossip = stats.duplicates.filter((d) => d.type === "series");
    // Un seul groupe : le remake et son seed. Avant, les épisodes de 2007 et de 2021 formaient un
    // doublon à eux seuls (22 groupes, ~50 Go dans la vraie bibliothèque).
    expect(gossip).toHaveLength(1);
    const paths = gossip[0].releases.map((r) => r.relativePath).sort();
    expect(paths).toEqual([
      "downloads/seeds/tv/Gossip Girl (2021) S01E01 MULTi 1080p WEB x264.mkv",
      "tv/Gossip Girl (2021)/Gossip Girl (2021) - S01E01 - Just Another Girl on the MTA.mkv",
    ]);
  });

  it("compte « en trop » la copie hors bibliothèque, même quand elle est la plus grosse", () => {
    const exorcist = stats.duplicates.find((d) => d.type === "movie");
    expect(exorcist?.title).toContain("Exorcist");
    // Le seed de 800 octets est l'octet en double ; le fichier lu par la bibliothèque (500) reste.
    expect(exorcist?.wastedBytes).toBe(800);
  });

  it("compte les fichiers de la bibliothèque par inode, pas par chemin", () => {
    // Gossip Girl ×2 + Berlin (un fichier sous deux noms) = 3 fichiers, pas 4.
    expect(stats.seriesFiles.total).toBe(3);
    expect(stats.seriesFiles.totalBytes).toBe(1000 + 2000 + 3000);
    expect(stats.movieFiles).toEqual({ total: 2, hardlinked: 1, totalBytes: 1200 });
  });

  it("ne range ni un seed lié ni un doublon parmi les orphelins", () => {
    expect(stats.seedOrphans).toEqual([]);
  });
});
