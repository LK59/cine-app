import { describe, it, expect } from "vitest";
import { diffTorrents, createTorrentWatchState } from "@/lib/torrentWatch";

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
