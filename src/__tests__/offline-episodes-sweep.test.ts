import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OfflineDownload, OfflineEpisodeFacts } from "@/lib/offline/downloads";

/**
 * Le ménage du téléchargement automatique (§109) : un épisode vu jusqu'au bout s'efface dès qu'un
 * épisode plus loin de la même série — et de la même chaîne : les spéciaux à part — est sur
 * l'appareil, que la suite soit déjà là au moment où on le finit ou qu'elle arrive après.
 */

const metas = new Map<string, OfflineDownload>();
const removed: string[] = [];

vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => "acc" }));
vi.mock("@/lib/reportClientError", () => ({ reportClientError: vi.fn() }));
vi.mock("@/lib/unsentPosition", () => ({ saveUnsentPosition: vi.fn(), flushUnsentPositions: vi.fn(async () => {}) }));
vi.mock("@/lib/offline/deviceStore", () => ({
  deviceStoreSupported: () => true,
  resetDeviceStore: vi.fn(),
  deviceStore: {
    list: async () => [...metas.keys()],
    readMeta: async (_account: string, id: string) => metas.get(id) ?? null,
    videoSize: async (_account: string, id: string) => metas.get(id)?.bytes ?? 0,
    writeMeta: async (_account: string, id: string, meta: OfflineDownload) => void metas.set(id, meta),
    remove: async (_account: string, id: string) => {
      removed.push(id);
      metas.delete(id);
    },
    truncateVideo: async () => {},
    writeVideo: async () => {},
    writePoster: async () => {},
  },
}));

const facts = (seasonNumber: number, episodeNumber: number): OfflineEpisodeFacts => ({
  sonarrId: 7,
  seriesTitle: "Une série",
  seasonNumber,
  episodeNumber,
  episodeTitle: `Épisode ${episodeNumber}`,
  autoNext: true,
});

const episode = (id: string, episodeFacts: OfflineEpisodeFacts, change: Partial<OfflineDownload> = {}): OfflineDownload =>
  ({
    id,
    itemId: `item-${id}`,
    episode: episodeFacts,
    radarrId: null,
    title: id,
    year: null,
    runtimeSeconds: 2700,
    quality: "standard",
    codec: "h264",
    audioIndex: 1,
    audioLabel: "Français",
    audioTracks: [],
    generation: 1,
    expectedBytes: 0,
    serverBytes: 0,
    serverDone: true,
    bytes: 0,
    state: "done",
    error: null,
    createdAt: 1,
    positionSeconds: 1200,
    hasPoster: false,
    ...change,
  }) as OfflineDownload;

/**
 * Le serveur : chaque préparation est finie, à zéro octet (la boucle la passe « done » au premier
 * pas). Celle de `e2` ne répond qu'à l'ouverture de la barrière : la suite « arrive » quand on veut.
 */
let gate: Promise<void> = Promise.resolve();
function serveJobs() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const id = url.split("/").pop();
      if (id === "e2") await gate;
      return new Response(JSON.stringify({ job: { id, status: "done", bytes: 0, expectedBytes: 0, generation: 1, error: null } }), { status: 200 });
    })
  );
}

async function load() {
  vi.resetModules();
  const mod = await import("@/lib/offline/downloads");
  await mod.initOfflineDownloads();
  return mod;
}

beforeEach(() => {
  gate = Promise.resolve();
  metas.clear();
  removed.length = 0;
  serveJobs();
});
afterEach(() => vi.unstubAllGlobals());

describe("un épisode vu jusqu'au bout, avec le téléchargement automatique", () => {
  it("s'efface tout de suite si la suite est déjà sur l'appareil", async () => {
    metas.set("e1", episode("e1", facts(1, 1)));
    metas.set("e2", episode("e2", facts(1, 2)));
    const mod = await load();
    await mod.markOfflineWatched("e1");
    await vi.waitFor(() => expect(removed).toEqual(["e1"]));
    expect(mod.offlineDownloadById("e1")).toBeNull();
    expect(mod.offlineDownloadById("e2")).not.toBeNull();
  });

  it("reste tant que la suite n'est pas arrivée, puis s'efface quand elle arrive", async () => {
    let release = () => {};
    gate = new Promise<void>((resolve) => (release = resolve));
    metas.set("e1", episode("e1", facts(1, 1)));
    metas.set("e2", episode("e2", facts(1, 2), { state: "downloading", createdAt: 2 }));
    const mod = await load();
    await mod.markOfflineWatched("e1");
    expect(removed).toEqual([]);
    expect(mod.offlineDownloadById("e1")?.watchedToEnd).toBe(true);
    // Sa position repart de zéro : c'est un épisode fini.
    expect(mod.offlineDownloadById("e1")?.positionSeconds).toBe(0);

    // La suite arrive : la boucle de l'appareil la termine, et le ménage passe.
    release();
    await vi.waitFor(() => expect(removed).toEqual(["e1"]));
    expect(mod.offlineDownloadById("e2")?.state).toBe("done");
  });

  it("ne s'efface pas sans le téléchargement automatique, ni pour un épisode d'une autre chaîne", async () => {
    metas.set("manual", episode("manual", { ...facts(1, 1), autoNext: false }));
    metas.set("special", episode("special", facts(0, 1)));
    metas.set("e5", episode("e5", facts(1, 5)));
    const mod = await load();
    await mod.markOfflineWatched("manual");
    await mod.markOfflineWatched("special");
    await new Promise((r) => setTimeout(r, 20));
    // Un spécial vu n'est pas effacé par la présence d'un épisode ordinaire : ce n'est pas sa suite.
    expect(removed).toEqual([]);
    expect(mod.offlineDownloadById("manual")?.watchedToEnd).toBe(true);
  });
});
