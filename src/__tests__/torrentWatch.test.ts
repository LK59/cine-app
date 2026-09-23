import { describe, it, expect, vi } from "vitest";
import {
  diffTorrents,
  createTorrentWatchState,
  torrentTitle,
  summarizeTorrents,
  createTorrentDigest,
  addToDigest,
  takeDueDigest,
  DIGEST_QUIET_MS,
  DIGEST_MAX_WAIT_MS,
} from "@/lib/torrentWatch";

// La surveillance des téléchargements, sortie de /api/sse le 21/09/2026 : elle n'y tournait que
// tant qu'un onglet de la gestion était ouvert.
describe("diffTorrents", () => {
  it("n'annonce rien au premier passage, qui ne fait qu'apprendre ce qui existe", () => {
    const state = createTorrentWatchState();
    expect(diffTorrents(state, [{ hash: "a", name: "A", state: "downloading" }])).toEqual({ started: [], completed: [] });
  });

  it("annonce ce qui démarre, puis ce qui finit", () => {
    const state = createTorrentWatchState();
    diffTorrents(state, []);
    expect(diffTorrents(state, [{ hash: "a", name: "A", state: "downloading" }]).started).toEqual(["A"]);
    expect(diffTorrents(state, [{ hash: "a", name: "A", state: "stalledDL" }]).started).toEqual([]);
    expect(diffTorrents(state, [{ hash: "a", name: "A", state: "uploading" }]).completed).toEqual(["A"]);
    // Et une seule fois.
    expect(diffTorrents(state, [{ hash: "a", name: "A", state: "uploading" }]).completed).toEqual([]);
  });

  it("oublie ce qui a disparu de qBittorrent", () => {
    const state = createTorrentWatchState();
    diffTorrents(state, [{ hash: "a", name: "A", state: "downloading" }]);
    diffTorrents(state, []);
    expect(state.downloading.size).toBe(0);
  });
});

// Le 23/09/2026 : une série demandée en entier est arrivée en quatorze torrents, un par épisode —
// vingt-huit notifications « démarré » et « terminé » en vingt minutes.
describe("torrentTitle", () => {
  it("retrouve le même titre sous des écritures différentes", () => {
    expect(torrentTitle("THE CREEP TAPES S02E04 AVA 1080p AMZN WEB-DL DDP5 1 H 264-RAWR")).toBe("The Creep Tapes");
    expect(torrentTitle("The.Creep.Tapes.S01E05.1080p.HEVC.x265-MeGusta[EZTVx.to].mkv[eztvx.to]")).toBe("The Creep Tapes");
    expect(torrentTitle("Severance - S02 1080p")).toBe("Severance");
  });

  it("coupe un film à son année, sans prendre un titre qui commence par un nombre pour une année", () => {
    expect(torrentTitle("Dune.Part.Two.2024.2160p.WEB-DL")).toBe("Dune Part Two");
    expect(torrentTitle("2001.A.Space.Odyssey.1968.1080p")).toBe("2001 A Space Odyssey");
  });
});

describe("summarizeTorrents", () => {
  it("un seul torrent garde son nom, comme avant", () => {
    expect(summarizeTorrents(["Dune.2021.1080p"], "completed")).toEqual({ title: "Téléchargement terminé ✓", body: "Dune.2021.1080p" });
  });

  it("plusieurs torrents font une notification, regroupée par titre", () => {
    const names = [
      "THE CREEP TAPES S01E01 1080p",
      "The.Creep.Tapes.S01E02.1080p",
      "THE CREEP TAPES S02E01 720p",
      "Dune.2021.1080p",
    ];
    expect(summarizeTorrents(names, "started")).toEqual({
      title: "4 téléchargements démarrés",
      body: "The Creep Tapes (3) · Dune",
    });
  });
});

describe("le lot de notifications", () => {
  it("attend que ça se calme avant de partir", () => {
    const digest = createTorrentDigest();
    addToDigest(digest, { started: ["A"], completed: [] }, 0);
    addToDigest(digest, { started: ["B"], completed: [] }, 60_000);
    expect(takeDueDigest(digest, 60_000 + DIGEST_QUIET_MS - 1)).toBeNull();
    expect(takeDueDigest(digest, 60_000 + DIGEST_QUIET_MS)).toEqual({ started: ["A", "B"], completed: [] });
    // Et se vide.
    expect(takeDueDigest(digest, 10 * DIGEST_MAX_WAIT_MS)).toBeNull();
  });

  it("ne retient pas un flot continu au-delà du délai maximal", () => {
    const digest = createTorrentDigest();
    for (let t = 0; t <= DIGEST_MAX_WAIT_MS; t += 60_000) addToDigest(digest, { started: [], completed: [`T${t}`] }, t);
    expect(takeDueDigest(digest, DIGEST_MAX_WAIT_MS)?.completed.length).toBe(11);
  });

  it("un passage sans rien de neuf ne relance pas l'attente", () => {
    const digest = createTorrentDigest();
    addToDigest(digest, { started: ["A"], completed: [] }, 0);
    addToDigest(digest, { started: [], completed: [] }, DIGEST_QUIET_MS - 1);
    expect(takeDueDigest(digest, DIGEST_QUIET_MS)).not.toBeNull();
  });
});

// Le conteneur est recréé à chaque déploiement : le lot en attente disparaissait, et ce qui avait
// fini pendant le redémarrage n'était jamais annoncé (23/09/2026).
describe("restoreTorrentWatch", () => {
  it("reprend ce qu'il savait, et annonce ce qui a fini pendant le redémarrage", async () => {
    const { restoreTorrentWatch } = await import("@/lib/torrentWatch");
    const { kvCacheDb } = await import("@/lib/db");
    const now = Date.now();
    vi.spyOn(kvCacheDb, "get").mockReturnValue({
      value: { downloading: [["h1", "Film A"]], digest: { first: 1, last: 1, started: ["Film B"], completed: [] } },
      fetchedAt: now - 60_000,
    });
    const state = createTorrentWatchState();
    const digest = createTorrentDigest();
    restoreTorrentWatch(state, digest, now);
    expect(digest.started).toEqual(["Film B"]);
    expect(diffTorrents(state, [{ hash: "h1", name: "Film A", state: "stoppedUP" }]).completed).toEqual(["Film A"]);
  });

  it("repart de zéro, en silence, quand ce qu'il savait est trop vieux", async () => {
    const { restoreTorrentWatch } = await import("@/lib/torrentWatch");
    const { kvCacheDb } = await import("@/lib/db");
    const now = Date.now();
    vi.spyOn(kvCacheDb, "get").mockReturnValue({
      value: { downloading: [["h1", "Film A"]], digest: createTorrentDigest() },
      fetchedAt: now - 2 * 3600_000,
    });
    const state = createTorrentWatchState();
    restoreTorrentWatch(state, createTorrentDigest(), now);
    expect(state.bootstrapped).toBe(false);
  });
});

// qBittorrent 5 : « stoppedUP » là où la v4 disait « pausedUP ».
describe("diffTorrents — qBittorrent 5", () => {
  it("annonce un téléchargement qui finit directement arrêté", () => {
    const state = createTorrentWatchState();
    diffTorrents(state, []);
    diffTorrents(state, [{ hash: "a", name: "A", state: "downloading" }]);
    expect(diffTorrents(state, [{ hash: "a", name: "A", state: "stoppedUP" }]).completed).toEqual(["A"]);
  });
});
