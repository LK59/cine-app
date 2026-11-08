import { describe, it, expect, vi, beforeEach } from "vitest";

// « Précédemment » (DECISIONS.md §137) : quand la tâche de fond prépare, ce qu'elle garde, et ce que
// la fiche lit. Jellyfin et le modèle sont des doubles — aucun appel réseau ne part.

const { fetchMock, nextUpMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), nextUpMock: vi.fn() }));
vi.mock("@/lib/jellyfinBreaker", () => ({ jellyfinFetch: fetchMock }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getNextUpGlobal: nextUpMock } }));

import { prepareRecap, readyRecapsFor, setRecapModelForTests } from "@/lib/recap/service";
import { recapDb } from "@/lib/db";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

const HOUR = 60 * 60 * 1000;
const LUCAS = "d".repeat(32);
const NOW = Date.parse("2026-11-08T20:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let serial = 0;
function episodes(lastPlayedAgo: number, played = 4) {
  const id = (++serial).toString(16).padStart(32, "a");
  const items = Array.from({ length: 6 }, (_, i) => ({
    Id: (serial * 16 + i + 1).toString(16).padStart(32, "b"),
    Name: `Épisode ${i + 1}`,
    ParentIndexNumber: 1,
    IndexNumber: i + 1,
    Overview: `Ted Lasso arrive à Richmond, épisode ${i + 1}.`,
    UserData: { Played: i < played, PlayCount: i < played ? 1 : 0, LastPlayedDate: i < played ? ago(lastPlayedAgo) : undefined, PlaybackPositionTicks: 0 },
    MediaSources: [{ Id: (serial * 16 + i + 1).toString(16).padStart(32, "c") }],
    MediaStreams: [{ Index: 3, Type: "Subtitle", Language: "fre", IsTextSubtitleStream: true }],
  }));
  return { id, items };
}

function serve(items: unknown[], srt = "1\n00:20:00,000 --> 00:20:02,000\n- Rebecca vend le club.\n") {
  fetchMock.mockImplementation(async (url: string) =>
    url.includes("/Subtitles/") ? new Response(srt) : new Response(JSON.stringify({ Items: items }), { headers: { "content-type": "application/json" } })
  );
}

const account = { jfId: LUCAS, user: "lucas", locale: "fr" as const };
const stateOf = (series: { id: string; items: { Id: string }[] }, positionS: number) => ({
  seriesId: series.id,
  series: "Ted Lasso",
  episode: { ...series.items[4], UserData: { Played: false, PlayCount: 0, PlaybackPositionTicks: positionS * 10_000_000 } } as JellyfinItem,
  positionS,
});

beforeEach(() => {
  fetchMock.mockReset();
  nextUpMock.mockReset();
});

describe("la préparation", () => {
  it("rien tant que la série a été regardée il y a moins de trois heures, ni sous trois épisodes finis", async () => {
    const model = vi.fn();
    setRecapModelForTests(model);
    const recent = episodes(2 * HOUR);
    serve(recent.items);
    expect(await prepareRecap(account, stateOf(recent, 1300), NOW)).toBe("pas encore");
    const few = episodes(5 * HOUR, 2);
    serve(few.items);
    expect(await prepareRecap(account, stateOf(few, 1300), NOW)).toBe("trop peu");
    expect(model).not.toHaveBeenCalled();
  });

  it("prépare une fois, garde le texte sous la clé, et la fiche le lit pour cette série", async () => {
    const model = vi.fn(async (_system: string, _message: string) => ({ raw: { noms: ["Ted Lasso", "Rebecca"], phrases: [{ texte: "Ted Lasso arrive à Richmond.", episodes: ["S01E04"] }, { texte: "Rebecca vend le club.", episodes: ["S01E05"] }] }, inTokens: 900, outTokens: 60 }));
    setRecapModelForTests(model);
    const s = episodes(5 * HOUR);
    serve(s.items);
    expect(await prepareRecap(account, stateOf(s, 1300), NOW)).toBe("préparé");
    // Les dialogues envoyés s'arrêtent à la position : la réplique de 20:00 est dans la fenêtre.
    expect(model.mock.calls[0][1]).toContain("Rebecca vend le club.");
    expect(model.mock.calls[0][1]).not.toContain("épisode 5."); // jamais le résumé de l'épisode en cours
    expect(await prepareRecap(account, stateOf(s, 1300), NOW)).toBe("déjà");
    expect(model).toHaveBeenCalledTimes(1);

    nextUpMock.mockResolvedValue([{ ...stateOf(s, 1300).episode, SeriesId: s.id, SeriesName: "Ted Lasso" }]);
    expect(await readyRecapsFor(LUCAS, "fr")).toEqual({ [s.id]: { text: "Ted Lasso arrive à Richmond. Rebecca vend le club.", episode: "S01E05" } });
    // Une autre langue, une autre clé : rien de prêt.
    expect(await readyRecapsFor(LUCAS, "en")).toEqual({});
  });

  it("un nom inventé est rejeté, gardé comme tel, et n'apparaît pas sur la fiche", async () => {
    setRecapModelForTests(async () => ({ raw: { noms: ["Keeley Jones"], phrases: [{ texte: "Keeley Jones quitte Richmond.", episodes: [] }] }, inTokens: 1, outTokens: 1 }));
    const s = episodes(5 * HOUR);
    serve(s.items);
    expect(await prepareRecap(account, stateOf(s, 1300), NOW)).toBe("rejeté");
    nextUpMock.mockResolvedValue([{ ...stateOf(s, 1300).episode, SeriesId: s.id }]);
    expect(await readyRecapsFor(LUCAS, "fr")).toEqual({});
    expect(recapDb.get(`${s.items[4].Id}:21:fr`)?.status).toBe("rejeté");
  });

  it("un refus de débit arrête le passage et ne garde rien", async () => {
    setRecapModelForTests(async () => {
      throw Object.assign(new Error("rate"), { status: 429 });
    });
    const s = episodes(5 * HOUR);
    serve(s.items);
    await expect(prepareRecap(account, stateOf(s, 1300), NOW)).rejects.toThrow();
    expect(recapDb.get(`${s.items[4].Id}:21:fr`)).toBeNull();
  });
});
