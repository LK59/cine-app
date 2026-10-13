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
// Les fichiers d'épisode de Sonarr, pour leur date d'import (prévision de saturation).
const mockEpisodeFiles = vi.fn();
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: { getEpisodeFiles: (id: number) => mockEpisodeFiles(id) } }));
// Le titre d'un film dans chaque langue, tel que le catalogue le tient déjà (cache TMDB).
const mockTitleNames = vi.fn();
vi.mock("@/lib/titleNames", () => ({ getTitleNames: (id: number) => mockTitleNames(id) }));

/** Le 15 du mois, `back` mois avant celui-ci — loin des bords de mois et de fuseau. */
function monthsAgo(back: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - back, 15, 12);
}
function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function touch(rel: string, when: Date) {
  fs.utimesSync(path.join(root, rel), when, when);
}

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
  // Un film importé sous son titre anglais, et une autre release (autre inode) qui ne porte que le
  // titre français — que ni Radarr ni ses titres alternatifs ne connaissent.
  file("movies/Train to Busan (2016)/Train to Busan (2016).mkv", 900);
  file("downloads/seeds/cross-seed-links/C411/Dernier.train.pour.Busan.2016.MULTi.VFI.2160p.BluRay.DV.HDR.EAC3.7.1.AV1-ASKO.mkv", 950);
  // Un seed de la même année qui ne désigne aucun film de la bibliothèque : il reste orphelin.
  file("downloads/seeds/movies/Le.Dernier.Metro.2016.FRENCH.1080p.WEB.x264.mkv", 400);

  // Dates (prévision de saturation). Les fichiers réécrits par FileFlows ont la date du jour ; la
  // date d'import vient de Radarr/Sonarr.
  touch("movies/The Exorcist (1973)/The Exorcist (1973).mkv", new Date()); // réencodé ce mois-ci
  touch("tv/Berlin (2023)/Season 2/Berlin (2023) - S02E01 - The Collection.mkv", new Date());
  touch("tv/Gossip Girl/Gossip Girl - S01E01 - Pilot.mkv", monthsAgo(1)); // inconnu de Sonarr ici
  for (const rel of [
    "tv/Gossip Girl (2021)/Gossip Girl (2021) - S01E01 - Just Another Girl on the MTA.mkv",
    "movies/Heat (1995)/Heat (1995).mkv",
    "movies/Train to Busan (2016)/Train to Busan (2016).mkv",
  ]) touch(rel, monthsAgo(20)); // hors de la fenêtre de douze mois

  process.env.MEDIA_ROOT = root;
  mockCachedMovies.mockResolvedValue([
    {
      id: 1, title: "The Exorcist", year: 1973, tmdbId: 9552, path: "/media/movies/The Exorcist (1973)",
      movieFile: { mediaInfo: { videoCodec: "x265" }, size: 500, relativePath: "The Exorcist (1973).mkv", dateAdded: monthsAgo(4).toISOString() },
    },
    { id: 2, title: "Heat", year: 1995, tmdbId: 949, movieFile: { mediaInfo: { videoCodec: "x265" }, size: 700 } },
    {
      id: 3, title: "Train to Busan", originalTitle: "부산행", year: 2016, tmdbId: 396535,
      alternateTitles: [{ title: "Tren a Busan" }, { title: "Busanhaeng" }],
      movieFile: { mediaInfo: { videoCodec: "x265" }, size: 900 },
    },
  ]);
  mockTitleNames.mockImplementation((id: number) => (id === 396535 ? { fr: "Dernier train pour Busan", en: "Train to Busan" } : {}));
  mockEpisodeFiles.mockImplementation(async (id: number) =>
    id === 7
      ? [{ id: 3341, seriesId: 7, seasonNumber: 2, size: 3000, relativePath: "Season 2/Berlin (2023) - S02E01 - The Collection.mkv", dateAdded: monthsAgo(2).toISOString() }]
      : []);
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
    const exorcist = stats.duplicates.find((d) => d.title.includes("Exorcist"));
    expect(exorcist).toBeDefined();
    // Le seed de 800 octets est l'octet en double ; le fichier lu par la bibliothèque (500) reste.
    expect(exorcist?.wastedBytes).toBe(800);
  });

  it("compte les fichiers de la bibliothèque par inode, pas par chemin", () => {
    // Gossip Girl ×2 + Berlin (un fichier sous deux noms) = 3 fichiers, pas 4.
    expect(stats.seriesFiles.total).toBe(3);
    expect(stats.seriesFiles.totalBytes).toBe(1000 + 2000 + 3000);
    expect(stats.movieFiles).toEqual({ total: 3, hardlinked: 1, totalBytes: 2100 });
  });

  it("ne range ni un seed lié ni un doublon parmi les orphelins", () => {
    // Seul le seed qui ne désigne aucun film reste ; « Dernier train pour Busan » n'en est plus un.
    expect(stats.seedOrphans.map((o) => o.fileName)).toEqual(["Le.Dernier.Metro.2016.FRENCH.1080p.WEB.x264.mkv"]);
  });

  it("rapproche un seed de son film par le titre français, et en fait un doublon", () => {
    const busan = stats.duplicates.find((d) => d.releases.some((r) => r.name.startsWith("Dernier.train")));
    expect(busan?.title).toBe("Train to Busan (2016)");
    expect(busan?.releases.map((r) => r.inLibrary).sort()).toEqual([false, true]);
    // On garde le fichier de la bibliothèque : le seed AV1 est l'octet en trop.
    expect(busan?.wastedBytes).toBe(950);
  });

  it("date la croissance mensuelle par l'import, pas par le réencodage", () => {
    const at = (back: number) => stats.monthlyGrowth.find((m) => m.month === monthOf(monthsAgo(back)))?.bytes;
    // The Exorcist, réécrit ce mois-ci (FileFlows), compte au mois de son import par Radarr ;
    // Berlin S02E01, réécrit aussi, au mois de son import par Sonarr — même lu d'abord sous le
    // dossier « Berlin and the Lady with an Ermine » que Sonarr ne connaît pas.
    expect(at(4)).toBe(500);
    expect(at(2)).toBe(3000);
    // Inconnu de Radarr comme de Sonarr : sa date de modification sert.
    expect(at(1)).toBe(1000);
    // Rien d'autre n'est arrivé ce mois-ci : avant, 500 + 3000 octets réencodés y comptaient.
    expect(at(0)).toBe(0);
    expect(stats.monthlyGrowth).toHaveLength(12);
  });
});
