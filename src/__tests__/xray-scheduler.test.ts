import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Le planificateur des acteurs à l'écran (DECISIONS.md §138, « Le planificateur de la bibliothèque ») :
 * il ne nourrit le service que lorsque personne ne regarde (sauf palier forcé), deux éléments d'avance au
 * plus, palier par palier ; il saute ce qui est déjà fait, écarte ce qui n'a pas de distribution,
 * rattache un fichier remplacé à durée égale au lieu de le réanalyser, et retient tout à travers un
 * redémarrage. Sa propre `DATA_DIR` : il vide ses tables entre deux tests.
 */

await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-xray-scan-"));
});

const id = (c: string) => c.repeat(32);
const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 10, 9, 12);

type Status = { itemId: string; etag: string; status: string; progress: number; analyzedUntil: number; error: string | null; durationS?: number | null; stats?: unknown };

const svc = vi.hoisted(() => ({
  configured: true,
  pending: 0,
  statuses: new Map<string, Status>(),
  enqueued: [] as Record<string, unknown>[],
  enqueueStatus: "queued" as string,
  rebindError: null as Error | null,
  healthError: null as Error | null,
  /** Ce que le service répond à un rattachement : `done` (rattaché) ou `queued` (il réanalyse, 202). */
  rebindAnswer: "done" as string,
  enqueueError: null as Error | null,
  /** Appelé à chaque lecture d'état — un geste de l'administrateur pendant le tour. */
  onItemStatus: null as ((itemId: string) => void) | null,
  relabeled: [] as { seriesId: string; itemIds: readonly string[] }[],
}));
vi.mock("@/lib/clients/xray", () => ({
  xrayConfigured: () => svc.configured,
  xray: {
    health: async () => {
      if (svc.healthError) throw svc.healthError;
      return { ok: true, queue: { pending: svc.pending, running: null } };
    },
    itemStatus: async (itemId: string) => {
      svc.onItemStatus?.(itemId);
      return svc.statuses.get(itemId) ?? null;
    },
    relabelSeries: async (seriesId: string, itemIds: readonly string[]) => {
      svc.relabeled.push({ seriesId, itemIds });
      return { queued: itemIds.length };
    },
    enqueue: async (job: Record<string, unknown>) => {
      if (job.rebindIfSameDuration && svc.rebindError) throw svc.rebindError;
      if (svc.enqueueError) throw svc.enqueueError;
      svc.enqueued.push(job);
      if (job.rebindIfSameDuration && svc.rebindAnswer === "done") return { itemId: job.itemId, status: "done", position: 0 };
      // Le service range l'ordre : `/items/{id}` le dit en file jusqu'à ce que le test le finisse.
      svc.statuses.set(job.itemId as string, { itemId: job.itemId as string, etag: job.etag as string, status: svc.enqueueStatus, progress: 0, analyzedUntil: 0, error: null });
      return { itemId: job.itemId, status: svc.enqueueStatus, position: svc.enqueued.length };
    },
  },
}));

const lib = vi.hoisted(() => ({
  library: [] as unknown[],
  watching: new Map<string, number>(),
  noCast: new Set<string>(),
  noFile: new Set<string>(),
  etags: new Map<string, string>(),
  durations: new Map<string, number>(),
  paths: new Map<string, string>(),
  titles: new Map<string, unknown>(),
  targetErrors: new Map<string, Error>(),
  castErrors: new Map<string, Error>(),
  libraryError: null as Error | null,
  watchingError: null as Error | null,
  libraryReads: 0,
  watchingReads: 0,
}));
vi.mock("@/lib/xray/scanSources", () => ({
  readLibrary: async () => {
    lib.libraryReads++;
    if (lib.libraryError) throw lib.libraryError;
    return lib.library;
  },
  readWatching: async () => {
    lib.watchingReads++;
    if (lib.watchingError) throw lib.watchingError;
    return lib.watching;
  },
  readPriorityTitle: async (itemId: string) => lib.titles.get(itemId) ?? null,
}));
vi.mock("@/lib/xray/cast", () => ({
  originalLanguageOf: () => "en",
  analysisTarget: async (itemId: string) => {
    const failure = lib.targetErrors.get(itemId);
    if (failure) throw failure;
    return lib.noFile.has(itemId)
      ? null
      : { itemId, type: "Movie", path: lib.paths.get(itemId) ?? `/media/movies/${itemId}.mkv`, etag: lib.etags.get(itemId) ?? "v1", seriesId: null, tmdb: { kind: "movie", id: 1 }, durationS: lib.durations.get(itemId) ?? 3600 };
  },
  castOf: async () => [{ personId: 1, name: "A", character: "B", order: 0, profilePath: null }],
  castWithPhotos: async () => [{ personId: 1, name: "A", character: "B", order: 0, photos: [] }],
}));
vi.mock("@/lib/xray/rebind", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/xray/rebind")>();
  return {
    ...real,
    jobFor: async (target: { itemId: string; etag: string; path: string }, priority: string) => {
      const failure = lib.castErrors.get(target.itemId);
      if (failure) throw failure;
      return lib.noCast.has(target.itemId) ? null : { job: { itemId: target.itemId, path: target.path, etag: target.etag, priority, seriesId: null, cast: [{}] }, cast: 1 };
    },
  };
});
const play = vi.hoisted(() => ({ wait: false }));
vi.mock("@/lib/repliques/playbackActivity", () => ({
  mustWaitForPlayback: async () => ({ wait: play.wait, signal: { playing: play.wait, by: play.wait ? "jellyfin" : null, lastSeenAt: 0 } }),
}));
const mockTaskLog = vi.fn();
vi.mock("@/lib/taskLog", () => ({ taskLog: (...a: unknown[]) => mockTaskLog(...a) }));
const mockLogError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => mockLogError(...a) }));

import { HttpError } from "@/lib/http";
import { MAX_PENDING, prioritizeTitle, readControls, readPriority, scanAction, scanTick, startXrayScheduler, unprioritizeTitle, xrayScanStatus, __testing } from "@/lib/xray/scheduler";
import { getRow, markRow, recordFileVersion, setPriorityRows, upsertPlanSlice, wipeScanStore, writeMeta } from "@/lib/xray/scanStore";

function movie(c: string, daysAgo: number, over: Record<string, unknown> = {}) {
  return { itemId: id(c), kind: "Movie", title: `Film ${c}`, seriesId: null, durationS: 3600, importedAt: NOW - daysAgo * DAY, createdAt: null, animation: false, ...over };
}

const enqueuedIds = () => svc.enqueued.filter((j) => !j.rebindIfSameDuration).map((j) => j.itemId);

beforeEach(() => {
  vi.clearAllMocks();
  __testing.reset();
  wipeScanStore();
  Object.assign(svc, { configured: true, pending: 0, statuses: new Map(), enqueued: [], enqueueStatus: "queued", rebindError: null, healthError: null, rebindAnswer: "done", enqueueError: null, onItemStatus: null, relabeled: [] });
  // Palier 1 : « 1 » ; palier 2 : « 2 » (arrivé hier) ; palier 3 : « 3 », « 4 », « 5 » du plus récent au plus ancien.
  lib.library = [movie("1", 300), movie("2", 1), movie("3", 30), movie("4", 60), movie("5", 90), movie("6", 2, { animation: true })];
  lib.watching = new Map([[id("1"), 1]]);
  lib.noCast = new Set();
  lib.noFile = new Set();
  lib.etags = new Map();
  lib.durations = new Map();
  lib.paths = new Map();
  lib.titles = new Map();
  lib.targetErrors = new Map();
  lib.castErrors = new Map();
  lib.libraryError = null;
  lib.watchingError = null;
  lib.libraryReads = 0;
  lib.watchingReads = 0;
  delete process.env.XRAY_LIBRARY_ROOTS;
  vi.unstubAllEnvs();
  play.wait = false;
});

describe("quand personne ne regarde", () => {
  it("commande en low, palier par palier, deux éléments d'avance au plus", async () => {
    await scanTick(NOW);
    expect(MAX_PENDING).toBe(2);
    expect(enqueuedIds()).toEqual([id("1"), id("2")]);
    expect(svc.enqueued.every((j) => j.priority === "low")).toBe(true);
    // Le tour suivant : les deux sont toujours en file, rien de plus.
    await scanTick(NOW + 60_000);
    expect(enqueuedIds()).toHaveLength(2);
    // L'un est fini : une place, le palier 3 commence par le plus récent.
    svc.statuses.set(id("1"), { itemId: id("1"), etag: "v1", status: "done", progress: 1, analyzedUntil: 3600, error: null, stats: { seconds: 360, realtime: 10 } });
    await scanTick(NOW + 120_000);
    expect(enqueuedIds()).toEqual([id("1"), id("2"), id("3")]);
  });

  it("n'ajoute rien quand la file du service est déjà pleine (la commande d'un spectateur reste devant)", async () => {
    svc.pending = 3;
    await scanTick(NOW);
    expect(svc.enqueued).toEqual([]);
  });

  it("l'animation n'est jamais commandée ; sans distribution ni fichier, écarté", async () => {
    lib.noCast.add(id("1"));
    lib.noFile.add(id("2"));
    await scanTick(NOW);
    expect(enqueuedIds()).toEqual([id("3"), id("4")]);
    expect(enqueuedIds()).not.toContain(id("6"));
    expect(getRow(id("1"))).toMatchObject({ status: "excluded", reason: "no-cast" });
    expect(getRow(id("2"))).toMatchObject({ status: "excluded", reason: "no-file" });
    expect(getRow(id("6"))).toMatchObject({ status: "excluded", reason: "animation" });
  });

  it("seulement les dossiers des films et des séries : téléchargements, seeds et livres jamais commandés", async () => {
    lib.paths.set(id("1"), "/media/downloads/complete/Film.1.mkv");
    lib.paths.set(id("2"), "/media/books/Livre.mkv");
    lib.paths.set(id("3"), "/media/movies/../downloads/x.mkv");
    lib.paths.set(id("4"), "/media/movies-seeds/x.mkv");
    lib.paths.set(id("5"), "/media/tv/Série/S01E01.mkv");
    await scanTick(NOW);
    expect(enqueuedIds()).toEqual([id("5")]);
    for (const c of ["1", "2", "3", "4"]) expect(getRow(id(c))).toMatchObject({ status: "excluded", reason: "outside-library" });
  });

  it("ce qui est déjà fait au même ETag est compté fait, sans commande", async () => {
    svc.statuses.set(id("1"), { itemId: id("1"), etag: "v1", status: "done", progress: 1, analyzedUntil: 3600, error: null });
    await scanTick(NOW);
    expect(enqueuedIds()).toEqual([id("2"), id("3")]);
    expect(getRow(id("1"))?.status).toBe("done");
  });
});

describe("pendant une lecture, par défaut", () => {
  it("le scan continue (XRAY_SCAN_DURING_PLAYBACK absent)", async () => {
    play.wait = true;
    await scanTick(NOW);
    expect(enqueuedIds()).toEqual([id("1"), id("2")]);
    expect(xrayScanStatus()).toMatchObject({ phase: "running" });
  });
});

describe("pendant une lecture, XRAY_SCAN_DURING_PLAYBACK=false", () => {
  beforeEach(() => {
    process.env.XRAY_SCAN_DURING_PLAYBACK = "false";
  });
  afterEach(() => {
    delete process.env.XRAY_SCAN_DURING_PLAYBACK;
  });

  it("rien ne part, et l'état le dit", async () => {
    play.wait = true;
    await scanTick(NOW);
    expect(svc.enqueued).toEqual([]);
    expect(xrayScanStatus()).toMatchObject({ phase: "waiting-playback", playbackBy: "jellyfin" });
  });

  it("« Lancer maintenant » force un palier : lui seul est nourri pendant la lecture", async () => {
    play.wait = true;
    await scanTick(NOW); // le plan est lu
    await scanAction("run", 3);
    await scanTick(NOW + 60_000);
    expect(enqueuedIds()).toEqual([id("3"), id("4")]);
    expect(xrayScanStatus().tiers[2]).toMatchObject({ forced: true, paused: false });
  });
});

describe("les gestes de l'administrateur", () => {
  it("un palier en pause est sauté, les autres continuent ; tout en pause, rien ne part", async () => {
    await scanAction("pause", 1);
    await scanTick(NOW);
    expect(enqueuedIds()).toEqual([id("2"), id("3")]);
    await scanAction("pause", null);
    svc.enqueued = [];
    svc.statuses.set(id("2"), { itemId: id("2"), etag: "v1", status: "done", progress: 1, analyzedUntil: 3600, error: null });
    await scanTick(NOW + 60_000);
    expect(svc.enqueued).toEqual([]);
    expect(xrayScanStatus().phase).toBe("paused");
    await scanAction("resume", 1);
    expect(xrayScanStatus().tiers[0].paused).toBe(false);
  });

  it("un tour à la fois", async () => {
    const a = scanTick(NOW);
    const b = scanTick(NOW);
    expect(a).toBe(b);
    await a;
  });
});

describe("à travers un redémarrage", () => {
  it("le plan, l'état de chaque élément, les pauses et le suivi de ce qui est en file restent", async () => {
    await scanTick(NOW);
    await scanAction("pause", 2);
    // Le conteneur est recréé : l'état en mémoire est perdu, la base reste.
    __testing.reset();
    svc.statuses.set(id("1"), { itemId: id("1"), etag: "v1", status: "done", progress: 1, analyzedUntil: 3600, error: null, stats: { seconds: 360, realtime: 10 } });
    svc.statuses.set(id("2"), { itemId: id("2"), etag: "v1", status: "running", progress: 0.4, analyzedUntil: 0, error: null });
    await scanTick(NOW + 60_000);
    expect(getRow(id("1"))?.status).toBe("done");
    expect(xrayScanStatus().tiers[1].paused).toBe(true);
    // Le plan n'a pas été relu (six heures), et l'élément 1 n'est pas recommandé.
    expect(enqueuedIds().filter((x) => x === id("1"))).toHaveLength(1);
    expect(xrayScanStatus().current).toMatchObject({ itemId: id("2"), title: "Film 2", progress: 0.4 });
  });
});

describe("la progression", () => {
  it("compte, heures, vitesse mesurée et temps restant par palier et pour toute la bibliothèque", async () => {
    await scanTick(NOW);
    svc.statuses.set(id("1"), { itemId: id("1"), etag: "v1", status: "done", progress: 1, analyzedUntil: 3600, error: null, stats: { seconds: 360, realtime: 10 } });
    svc.statuses.set(id("2"), { itemId: id("2"), etag: "v1", status: "failed", progress: 0, analyzedUntil: 0, error: "décodage impossible" });
    await scanTick(NOW + 60_000);
    const s = xrayScanStatus();
    expect(s.speed).toBe(10);
    expect(s.tiers[0]).toMatchObject({ total: 1, done: 1, hoursDone: 1, etaS: 0 });
    expect(s.tiers[1]).toMatchObject({ total: 1, failed: 1, done: 0 });
    // Palier 3 : 3 éléments d'une heure, dont deux commandés : 3 h de vidéo à 10× = 18 min.
    expect(s.tiers[2]).toMatchObject({ total: 3, excluded: 0, hoursTotal: 3, etaS: 1080 });
    expect(s.tiers[1].excluded).toBe(1); // l'animation, arrivée il y a deux jours
    expect(s.etaAllS).toBe(1080);
    expect(s.errors[0]).toMatchObject({ itemId: id("2"), error: "décodage impossible" });
  });
});

describe("un fichier remplacé à durée égale", () => {
  it("n'est pas réanalysé : le service rattache son résultat au nouvel ETag", async () => {
    lib.etags.set(id("1"), "v2");
    lib.durations.set(id("1"), 2551.4);
    svc.statuses.set(id("1"), { itemId: id("1"), etag: "v1", status: "done", progress: 1, analyzedUntil: 2551, error: null, durationS: 2551.0 });
    await scanTick(NOW);
    const rebind = svc.enqueued.find((j) => j.rebindIfSameDuration);
    expect(rebind).toMatchObject({ itemId: id("1"), etag: "v2", durationS: 2551.4, priority: "low" });
    expect(enqueuedIds()).not.toContain(id("1"));
    expect(getRow(id("1"))).toMatchObject({ status: "done", reason: "rebound", etag: "v2" });
  });

  it("un service qui refuse le champ (400) : rien n'est commandé, l'ancien résultat reste", async () => {
    lib.etags.set(id("1"), "v2");
    lib.durations.set(id("1"), 2551.4);
    // La durée retenue à la commande précédente, sans `durationS` du service.
    recordFileVersion(id("1"), "v1", 2551.2);
    svc.statuses.set(id("1"), { itemId: id("1"), etag: "v1", status: "done", progress: 1, analyzedUntil: 0, error: null });
    svc.rebindError = new HttpError("laterna-xray jobs : 400 champ inconnu", 400);
    await scanTick(NOW);
    expect(enqueuedIds()).not.toContain(id("1"));
    expect(getRow(id("1"))).toMatchObject({ status: "done", reason: "same-duration" });
  });

  it("une durée différente : réanalysé", async () => {
    lib.etags.set(id("1"), "v2");
    lib.durations.set(id("1"), 2700);
    svc.statuses.set(id("1"), { itemId: id("1"), etag: "v1", status: "done", progress: 1, analyzedUntil: 2551, error: null, durationS: 2551 });
    await scanTick(NOW);
    expect(enqueuedIds()[0]).toBe(id("1"));
  });
});

describe("le journal du conteneur", () => {
  it("une ligne par lot commandé, aucune pour un tour sans rien", async () => {
    await scanTick(NOW);
    const batches = () => mockTaskLog.mock.calls.filter((c) => c[0] === "xray" && String(c[1]).includes("lot commandé"));
    expect(batches()).toHaveLength(1);
    expect(batches()[0][2]).toMatchObject({ palier: 1, éléments: 2 });
    await scanTick(NOW + 60_000);
    expect(batches()).toHaveLength(1);
  });

  it("option coupée : rien n'est lu ni commandé", async () => {
    svc.configured = false;
    await scanTick(NOW);
    expect(svc.enqueued).toEqual([]);
    expect(xrayScanStatus().phase).toBe("off");
  });
});

describe("la liste de priorité de l'administrateur", () => {
  const SERIES = id("s");
  const ep = (c: string, season: number, episode: number) => ({ itemId: id(c), kind: "Episode", title: `Série S${season}E${episode}`, seriesId: SERIES, durationS: 2400, season, episode });
  // Les épisodes tels que `readPriorityTitle` les rend : déjà dans l'ordre de `seriesOrder`.
  const series = { kind: "Series", title: "Série", animation: false, rows: [ep("a", 1, 1), ep("b", 1, 2), ep("c", 2, 1)] };

  it("passe avant le palier 1, en normal, saison par saison", async () => {
    lib.titles.set(SERIES, series);
    await scanTick(NOW); // le plan est lu, rien de prioritaire encore
    svc.enqueued = [];
    svc.statuses = new Map();
    await prioritizeTitle(SERIES, NOW);
    // Les deux commandes « low » du fond sont revues ; les places vont à la série, dans l'ordre.
    await scanTick(NOW + 60_000);
    const normal = svc.enqueued.filter((j) => j.priority === "normal").map((j) => j.itemId);
    expect(normal.slice(0, 2)).toEqual([id("a"), id("b")]);
    expect(getRow(id("a"))).toMatchObject({ tier: 0 });
    expect(xrayScanStatus().priority.items[0]).toMatchObject({ id: SERIES, kind: "Series", title: "Série", total: 3 });
  });

  it("tourne même pendant une lecture, et seulement elle ; deux d'avance au plus", async () => {
    lib.titles.set(SERIES, series);
    play.wait = true;
    await prioritizeTitle(SERIES, NOW);
    await scanTick(NOW + 60_000);
    expect(enqueuedIds()).toEqual([id("a"), id("b")]);
    expect(svc.enqueued.every((j) => j.priority === "normal")).toBe(true);
  });

  it("l'animation est refusée, avec sa raison", async () => {
    lib.titles.set(SERIES, { ...series, animation: true });
    expect(await prioritizeTitle(SERIES, NOW)).toBe("animation");
    expect(readPriority()).toEqual([]);
    expect(await prioritizeTitle(id("z"), NOW)).toBe("not-found");
  });

  it("survit à un redémarrage et à une relecture du plan ; retiré, l'élément retrouve son palier", async () => {
    lib.titles.set(id("4"), { kind: "Movie", title: "Film 4", animation: false, rows: [{ itemId: id("4"), kind: "Movie", title: "Film 4", seriesId: null, durationS: 3600 }] });
    await scanTick(NOW);
    await prioritizeTitle(id("4"), NOW);
    __testing.reset();
    // Sept heures plus tard : le plan complet est relu — le palier 0 reste.
    await scanTick(NOW + 7 * 3600_000);
    expect(readPriority().map((e) => e.id)).toEqual([id("4")]);
    expect(getRow(id("4"))?.tier).toBe(0);
    expect(unprioritizeTitle(id("4"), NOW + 7 * 3600_000)).toBe(true);
    expect(getRow(id("4"))?.tier).toBe(3);
    expect(xrayScanStatus().priority.items).toEqual([]);
  });
});

// ─── La revue du 09/11/2026 ──────────────────────────────────────────────────

const finish = (c: string, status = "done", error: string | null = null) =>
  svc.statuses.set(id(c), { itemId: id(c), etag: "v1", status, progress: 1, analyzedUntil: 3600, error, stats: { seconds: 360, realtime: 10 } });
const HOUR = 3600_000;

describe("un élément en erreur ne bloque pas la file", () => {
  it("une erreur de Jellyfin ou de TMDB propre à un élément : échec, et les suivants partent", async () => {
    lib.targetErrors.set(id("1"), new HttpError("Jellyfin : 500", 500));
    lib.castErrors.set(id("2"), new HttpError("TMDB : 404", 404));
    await scanTick(NOW);
    expect(enqueuedIds()).toEqual([id("3"), id("4")]);
    expect(getRow(id("1"))).toMatchObject({ status: "failed", error: "Jellyfin : 500" });
    expect(getRow(id("2"))).toMatchObject({ status: "failed", error: "TMDB : 404" });
    expect(xrayScanStatus().phase).toBe("running");
    // Pas rejoué chaque minute : un échec attend une semaine.
    finish("3");
    await scanTick(NOW + 60_000);
    expect(enqueuedIds()).toEqual([id("3"), id("4"), id("5")]);
    expect(mockLogError.mock.calls.filter((c) => c[0] === "xray/scan-item")).toHaveLength(2);
  });

  it("une erreur de réseau : l'élément est retenté dans l'heure, et le tour s'arrête là", async () => {
    lib.targetErrors.set(id("1"), new TypeError("fetch failed"));
    await scanTick(NOW);
    expect(enqueuedIds()).toEqual([]);
    expect(getRow(id("1"))?.status).toBe("failed");
    // La minute suivante, la file continue derrière lui.
    await scanTick(NOW + 60_000);
    expect(enqueuedIds()).toEqual([id("2"), id("3")]);
    lib.targetErrors.clear();
    finish("2");
    finish("3");
    await scanTick(NOW + HOUR + 2 * 60_000);
    expect(enqueuedIds()).toContain(id("1"));
  });

  it("le service lui-même en panne arrête le tour, sans rien marquer", async () => {
    svc.enqueueError = new HttpError("laterna-xray jobs : 503", 503);
    await scanTick(NOW);
    expect(getRow(id("1"))?.status).toBe("pending");
    expect(xrayScanStatus()).toMatchObject({ phase: "unavailable", lastError: "laterna-xray jobs : 503" });
  });
});

describe("les écartés et les échecs revus", () => {
  it("sans distribution, sans fichier : revus après une semaine ; l'animation reste écartée", async () => {
    lib.noCast.add(id("1"));
    lib.noFile.add(id("2"));
    await scanTick(NOW);
    expect(getRow(id("1"))).toMatchObject({ status: "excluded", reason: "no-cast" });
    lib.noCast.clear();
    lib.noFile.clear();
    finish("3");
    finish("4");
    await scanTick(NOW + 60_000);
    expect(getRow(id("1"))?.status).toBe("excluded");
    finish("5");
    await scanTick(NOW + 8 * 24 * HOUR);
    expect(enqueuedIds()).toEqual(expect.arrayContaining([id("1"), id("2")]));
    expect(getRow(id("6"))).toMatchObject({ status: "excluded", reason: "animation" });
  });

  it("les dossiers permis changés : ce qui était hors des dossiers est revu aussitôt", async () => {
    lib.paths.set(id("1"), "/media/films/Film.mkv");
    await scanTick(NOW);
    expect(getRow(id("1"))).toMatchObject({ status: "excluded", reason: "outside-library" });
    process.env.XRAY_LIBRARY_ROOTS = "/media/films,/media/movies";
    finish("2");
    finish("3");
    await scanTick(NOW + 60_000);
    expect(enqueuedIds()).toContain(id("1"));
  });

  it("un échec du service est relancé la semaine suivante, même avec du travail devant", async () => {
    await scanTick(NOW);
    finish("1", "failed", "décodage impossible");
    await scanTick(NOW + 60_000);
    expect(getRow(id("1"))?.status).toBe("failed");
    finish("2");
    finish("3");
    await scanTick(NOW + 8 * 24 * HOUR);
    expect(enqueuedIds().filter((x) => x === id("1"))).toHaveLength(2);
  });
});

describe("la relecture du plan", () => {
  it("en échec, elle attend 15 min, puis 1 h, au lieu de relire la bibliothèque chaque minute", async () => {
    lib.libraryError = new HttpError("Jellyfin : 502", 502);
    await scanTick(NOW);
    expect(lib.libraryReads).toBe(1);
    await scanTick(NOW + 60_000);
    await scanTick(NOW + 2 * 60_000);
    expect(lib.libraryReads).toBe(1);
    expect(xrayScanStatus().lastError).toBe("Jellyfin : 502");
    await scanTick(NOW + 16 * 60_000);
    expect(lib.libraryReads).toBe(2);
    await scanTick(NOW + 30 * 60_000);
    expect(lib.libraryReads).toBe(2);
    await scanTick(NOW + 16 * 60_000 + HOUR + 60_000);
    expect(lib.libraryReads).toBe(3);
    lib.libraryError = null;
    await scanTick(NOW + 16 * 60_000 + 7 * HOUR + 2 * 60_000);
    expect(lib.libraryReads).toBe(4);
    expect(xrayScanStatus().lastError).toBeNull();
  });

  it("la liste des comptes lue est appliquée même quand la bibliothèque échoue, et l'inverse", async () => {
    await scanTick(NOW);
    lib.libraryError = new HttpError("Jellyfin : 502", 502);
    lib.watching = new Map([[id("4"), 1]]);
    await scanTick(NOW + 7 * HOUR);
    expect(getRow(id("4"))?.tier).toBe(1);
    // La bibliothèque revenue, les comptes illisibles : le palier 1 retenu est gardé.
    lib.libraryError = null;
    lib.watchingError = new Error("comptes illisibles");
    await scanTick(NOW + 21 * HOUR);
    expect(getRow(id("4"))?.tier).toBe(1);
  });
});

describe("aucune lecture inutile", () => {
  it("tout en pause : ni la bibliothèque, ni les comptes, ni le service ne sont lus", async () => {
    writeMeta("controls", { paused: [0, 1, 2, 3], forced: [] });
    await scanTick(NOW);
    expect(lib.libraryReads + lib.watchingReads).toBe(0);
    expect(xrayScanStatus().phase).toBe("paused");
  });

  it("pendant une lecture sans palier forcé (XRAY_SCAN_DURING_PLAYBACK=false) : les comptes ne sont pas relus", async () => {
    vi.stubEnv("XRAY_SCAN_DURING_PLAYBACK", "false");
    await scanTick(NOW);
    const reads = lib.watchingReads;
    play.wait = true;
    await scanTick(NOW + 11 * 60_000);
    await scanTick(NOW + 7 * HOUR);
    expect(lib.watchingReads).toBe(reads);
    expect(lib.libraryReads).toBe(1);
  });
});

describe("le palier 0", () => {
  const SERIES = id("s");
  const series = {
    kind: "Series",
    title: "Série",
    animation: false,
    rows: [{ itemId: id("a"), kind: "Episode", title: "Série S1E1", seriesId: SERIES, durationS: 2400 }, { itemId: id("b"), kind: "Episode", title: "Série S1E2", seriesId: SERIES, durationS: 2400 }],
  };

  it("un fichier remplacé que le service réanalyse reste en normal", async () => {
    lib.titles.set(SERIES, series);
    lib.etags.set(id("a"), "v2");
    lib.durations.set(id("a"), 2400);
    svc.statuses.set(id("a"), { itemId: id("a"), etag: "v1", status: "done", progress: 1, analyzedUntil: 2400, error: null, durationS: 2400 });
    svc.rebindAnswer = "queued";
    await prioritizeTitle(SERIES, NOW);
    const rebind = svc.enqueued.find((j) => j.rebindIfSameDuration);
    expect(rebind).toMatchObject({ itemId: id("a"), priority: "normal" });
  });

  it("ne passe jamais devant une commande de spectateur en attente au service", async () => {
    lib.titles.set(SERIES, series);
    svc.pending = 1; // l'épisode suivant d'un spectateur, en `normal`
    await prioritizeTitle(SERIES, NOW);
    await scanTick(NOW + 60_000);
    expect(svc.enqueued).toEqual([]);
    svc.pending = 0;
    await scanTick(NOW + 2 * 60_000);
    expect(enqueuedIds()).toEqual([id("a"), id("b")]);
    expect(svc.enqueued.every((j) => j.priority === "normal")).toBe(true);
  });
});

describe("les gestes et l'état", () => {
  it("un geste de l'administrateur pendant le tour n'est pas écrasé à la fin", async () => {
    await scanTick(NOW);
    finish("1");
    finish("2");
    writeMeta("controls", { paused: [], forced: [2] });
    // Pendant le tour — l'élément 3 en cours de vérification —, l'administrateur met le palier 3 en pause.
    svc.onItemStatus = (itemId) => {
      if (itemId !== id("3")) return;
      svc.onItemStatus = null;
      writeMeta("controls", { paused: [3], forced: [2] });
    };
    await scanTick(NOW + 60_000);
    // Le palier 2 forcé s'est vidé : son forçage tombe, la pause reste.
    expect(readControls()).toEqual({ paused: [3], forced: [] });
  });

  it("« À jour » seulement si aucun palier en pause n'a encore de travail", async () => {
    writeMeta("controls", { paused: [3], forced: [] });
    await scanTick(NOW);
    finish("1");
    finish("2");
    await scanTick(NOW + 60_000);
    expect(xrayScanStatus().phase).toBe("paused");
  });
});

describe("un élément fait reste fait à la relecture du plan", () => {
  const item = (importedAt: number, durationS = 3600) => ({ itemId: id("9"), tier: 3 as const, kind: "Movie" as const, title: "Film 9", seriesId: null, durationS, importedAt, rank: 1, excluded: null });

  it("sa date bouge (DateCreated de Jellyfin) : rien ne change ; sa durée aussi : à revérifier", () => {
    upsertPlanSlice([item(NOW - DAY)], 1);
    markRow(id("9"), { status: "done" });
    upsertPlanSlice([item(NOW - 2 * DAY)], 2);
    expect(getRow(id("9"))?.status).toBe("done");
    upsertPlanSlice([item(NOW - 3 * DAY, 2400)], 3);
    expect(getRow(id("9"))?.status).toBe("pending");
  });

  it("un élément de la liste de priorité (date inconnue) fini avant que le plan le lise", () => {
    setPriorityRows(id("s"), [{ itemId: id("9"), kind: "Movie", title: "Film 9", seriesId: null, durationS: 3600 }], 100_000);
    markRow(id("9"), { status: "done" });
    upsertPlanSlice([item(NOW - DAY)], 1);
    expect(getRow(id("9"))).toMatchObject({ status: "done", tier: 0 });
  });
});

describe("sous next dev", () => {
  it("rien ne tourne : la pile de développement partage cine.db", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await scanTick(NOW);
    startXrayScheduler();
    expect(svc.enqueued).toEqual([]);
    expect(lib.libraryReads).toBe(0);
    expect(__testing.live.timers).toHaveLength(0);
  });
});

describe("une série dans l'ordre de ses épisodes, puis renommée une fois (10.30)", () => {
  const ep = (c: string, n: number, daysAgo: number) => ({
    itemId: id(c),
    kind: "Episode",
    title: `Show S01E${String(n).padStart(2, "0")}`,
    seriesId: id("s"),
    durationS: 1800,
    importedAt: NOW - daysAgo * DAY,
    createdAt: null,
    animation: false,
    season: 1,
    episode: n,
  });
  const done = (c: string) => svc.statuses.set(id(c), { itemId: id(c), etag: "v1", status: "done", progress: 1, analyzedUntil: 1800, error: null });

  it("les épisodes partent dans l'ordre de la série, à la place que la série tenait dans son palier", async () => {
    // Importés à l'envers : l'épisode 3 est le plus récent.
    lib.library = [ep("a", 3, 30), ep("b", 1, 40), ep("c", 2, 50), movie("5", 35)];
    lib.watching = new Map();
    await scanTick(NOW);
    expect(enqueuedIds()).toEqual([id("b"), id("5")]);
    done("b");
    done("5");
    await scanTick(NOW + 60_000);
    expect(enqueuedIds()).toEqual([id("b"), id("5"), id("c"), id("a")]);
  });

  it("tous ses épisodes du plan finis : la série est renommée une fois, dans l'ordre de ses épisodes", async () => {
    lib.library = [ep("a", 3, 30), ep("b", 1, 40), ep("c", 2, 50)];
    lib.watching = new Map();
    await scanTick(NOW);
    done("b");
    done("c");
    await scanTick(NOW + 60_000);
    expect(svc.relabeled).toEqual([]); // l'épisode 3 n'est pas fini
    done("a");
    await scanTick(NOW + 120_000);
    await scanTick(NOW + 180_000);
    expect(svc.relabeled).toEqual([{ seriesId: id("s"), itemIds: [id("b"), id("c"), id("a")] }]);
    expect(mockTaskLog).toHaveBeenCalledWith("xray", "série renommée", { série: "Show", épisodes: 3 });
  });
});
