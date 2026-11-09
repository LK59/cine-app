import { describe, it, expect, vi, beforeEach } from "vitest";

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
}));
vi.mock("@/lib/clients/xray", () => ({
  xrayConfigured: () => svc.configured,
  xray: {
    health: async () => {
      if (svc.healthError) throw svc.healthError;
      return { ok: true, queue: { pending: svc.pending, running: null } };
    },
    itemStatus: async (itemId: string) => svc.statuses.get(itemId) ?? null,
    enqueue: async (job: Record<string, unknown>) => {
      if (job.rebindIfSameDuration && svc.rebindError) throw svc.rebindError;
      svc.enqueued.push(job);
      if (job.rebindIfSameDuration) return { itemId: job.itemId, status: "done", position: 0 };
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
}));
vi.mock("@/lib/xray/scanSources", () => ({
  readLibrary: async () => lib.library,
  readWatching: async () => lib.watching,
}));
vi.mock("@/lib/xray/cast", () => ({
  analysisTarget: async (itemId: string) =>
    lib.noFile.has(itemId)
      ? null
      : { itemId, type: "Movie", path: lib.paths.get(itemId) ?? `/media/movies/${itemId}.mkv`, etag: lib.etags.get(itemId) ?? "v1", seriesId: null, tmdb: { kind: "movie", id: 1 }, durationS: lib.durations.get(itemId) ?? 3600 },
  castOf: async () => [{ personId: 1, name: "A", character: "B", order: 0, profilePath: null }],
  castWithPhotos: async () => [{ personId: 1, name: "A", character: "B", order: 0, photos: [] }],
}));
vi.mock("@/lib/xray/rebind", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/xray/rebind")>();
  return {
    ...real,
    jobFor: async (target: { itemId: string; etag: string; path: string }, priority: string) =>
      lib.noCast.has(target.itemId) ? null : { job: { itemId: target.itemId, path: target.path, etag: target.etag, priority, seriesId: null, cast: [{}] }, cast: 1 },
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
import { MAX_PENDING, scanAction, scanTick, xrayScanStatus, __testing } from "@/lib/xray/scheduler";
import { getRow, recordFileVersion, wipeScanStore } from "@/lib/xray/scanStore";

function movie(c: string, daysAgo: number, over: Record<string, unknown> = {}) {
  return { itemId: id(c), kind: "Movie", title: `Film ${c}`, seriesId: null, durationS: 3600, importedAt: NOW - daysAgo * DAY, createdAt: null, animation: false, ...over };
}

const enqueuedIds = () => svc.enqueued.filter((j) => !j.rebindIfSameDuration).map((j) => j.itemId);

beforeEach(() => {
  vi.clearAllMocks();
  __testing.reset();
  wipeScanStore();
  Object.assign(svc, { configured: true, pending: 0, statuses: new Map(), enqueued: [], enqueueStatus: "queued", rebindError: null, healthError: null });
  // Palier 1 : « 1 » ; palier 2 : « 2 » (arrivé hier) ; palier 3 : « 3 », « 4 », « 5 » du plus récent au plus ancien.
  lib.library = [movie("1", 300), movie("2", 1), movie("3", 30), movie("4", 60), movie("5", 90), movie("6", 2, { animation: true })];
  lib.watching = new Map([[id("1"), 1]]);
  lib.noCast = new Set();
  lib.noFile = new Set();
  lib.etags = new Map();
  lib.durations = new Map();
  lib.paths = new Map();
  delete process.env.XRAY_LIBRARY_ROOTS;
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

describe("pendant une lecture", () => {
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
