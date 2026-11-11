import { describe, it, expect, vi, beforeEach } from "vitest";

// « Précédemment » (DECISIONS.md §137) — le passage de fond, chasse aux défauts du 11/11/2026 : une série qui
// échoue ne bloque plus les suivantes ni les autres comptes, elle est mise de côté un temps ; une limite de débit et
// le plafond mensuel arrêtent toujours le passage. Jellyfin et le modèle sont des doubles — aucun appel réseau.

// Sa propre base : la suite partage un DATA_DIR (CLAUDE.md).
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-recap-pass-"));
});

vi.mock("@/lib/config", () => ({
  config: {
    recap: { enabled: true },
    subtitleGen: { enabled: true, provider: "anthropic", apiKey: "sk-test", model: "", budgetUsd: "5", priceInput: "", priceOutput: "" },
    jellyfin: { url: "http://jf", apiKey: "k" },
    app: { language: "fr" },
  },
}));

const ANNA = "a".repeat(32);
const BRUNO = "b".repeat(32);
const BAD = "1".repeat(32);
const GOOD = "2".repeat(32);
const OTHER = "3".repeat(32);

const { fetchMock, logError } = vi.hoisted(() => ({ fetchMock: vi.fn(), logError: vi.fn() }));
vi.mock("@/lib/jellyfinBreaker", () => ({ jellyfinFetch: fetchMock }));
vi.mock("@/lib/jellyfinAuth", () => ({ jellyfinAuthHeaders: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => logError(...a) }));
vi.mock("@/lib/taskLog", () => ({ taskLog: vi.fn() }));
vi.mock("@/lib/eventLogs", () => ({ logRecap: vi.fn() }));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: { getUsers: async () => [{ Id: ANNA, Name: "anna" }, { Id: BRUNO, Name: "bruno" }] },
}));
vi.mock("@/lib/db", async (orig) => {
  const real = await orig<typeof import("@/lib/db")>();
  return { ...real, sessionDb: { ...real.sessionDb, activeUsers: () => new Set([ANNA, BRUNO]) } };
});

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** Six épisodes d'une série, quatre finis il y a cinq heures ; le cinquième est en cours à `positionS`. */
function episodesOf(seriesId: string) {
  return Array.from({ length: 6 }, (_, i) => ({
    Id: `${seriesId.slice(0, 30)}${String(i + 1).padStart(2, "0")}`,
    SeriesId: seriesId,
    SeriesName: `Série ${seriesId[0]}`,
    Name: `Épisode ${i + 1}`,
    ParentIndexNumber: 1,
    IndexNumber: i + 1,
    Overview: `Ted Lasso arrive à Richmond, épisode ${i + 1}.`,
    UserData: { Played: i < 4, LastPlayedDate: i < 4 ? ago(5 * HOUR) : undefined, PlaybackPositionTicks: i === 4 ? 1300 * 10_000_000 : 0 },
    MediaSources: [{ Id: "f".repeat(32) }],
    MediaStreams: [{ Index: 3, Type: "Subtitle", Language: "fre", IsTextSubtitleStream: true }],
  }));
}
/** « À suivre » par compte : Anna regarde BAD puis GOOD, Bruno OTHER. */
const nextUp: Record<string, string[]> = { [ANNA]: [BAD, GOOD], [BRUNO]: [OTHER] };

vi.mock("@/lib/http", async (orig) => ({
  ...(await orig<typeof import("@/lib/http")>()),
  fetchJson: async (url: string) => {
    if (url.includes("/Sessions")) return [];
    const user = /UserId=([0-9a-f]+)/.exec(url)?.[1] ?? "";
    return { Items: (nextUp[user] ?? []).map((s) => episodesOf(s)[4]) };
  },
}));

import { resetRecapMemoryForTests, runRecapPass, setRecapModelForTests } from "@/lib/recap/service";
import { getDb } from "@/lib/db";
import { spendDb } from "@/lib/subtitleGen/store";

/** Les épisodes lus par série — compté pour voir quelles séries le passage a regardées. */
const episodeReads = () => fetchMock.mock.calls.map(([url]) => /\/Shows\/([0-9a-f]+)\/Episodes/.exec(String(url))?.[1]).filter(Boolean);

const good = async () => ({ raw: { noms: ["Ted Lasso"], phrases: [{ texte: "Ted Lasso arrive à Richmond.", episodes: [] }] }, inTokens: 1, outTokens: 1 });

beforeEach(() => {
  resetRecapMemoryForTests();
  logError.mockReset();
  getDb().prepare("DELETE FROM series_recaps").run();
  getDb().prepare("DELETE FROM recap_progress").run();
  getDb().prepare("DELETE FROM subtitle_gen_spend").run();
  fetchMock.mockReset();
  // BAD : Jellyfin refuse ses épisodes, toujours.
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/Subtitles/")) return new Response("1\n00:20:00,000 --> 00:20:02,000\nTed Lasso arrive.\n");
    const series = /\/Shows\/([0-9a-f]+)\/Episodes/.exec(url)?.[1];
    if (series === BAD) return new Response("", { status: 500 });
    return new Response(JSON.stringify({ Items: episodesOf(series ?? "") }), { headers: { "content-type": "application/json" } });
  });
});

describe("le passage de « Précédemment » (11/11/2026)", () => {
  it("une série en échec ne bloque ni la suivante ni les autres comptes, et elle est mise de côté un temps", async () => {
    setRecapModelForTests(good);
    // Le passage s'arrêtait à BAD, première série d'Anna : ni GOOD ni Bruno n'avaient jamais leur texte.
    expect(await runRecapPass(NOW)).toEqual({ prepared: 2, rejected: 0 });
    expect(episodeReads()).toEqual([BAD, GOOD, OTHER]);
    expect(logError).toHaveBeenCalledWith("recap", expect.any(Error), { series: BAD });
    // Cinq minutes plus tard : BAD est de côté, rien ne la relit.
    fetchMock.mockClear();
    await runRecapPass(NOW + 5 * 60_000);
    expect(episodeReads()).not.toContain(BAD);
    // Passé le recul (15 min) : réessayée, et de nouveau de côté — plus longtemps (1 h).
    fetchMock.mockClear();
    await runRecapPass(NOW + 16 * 60_000);
    expect(episodeReads()).toContain(BAD);
    fetchMock.mockClear();
    await runRecapPass(NOW + 40 * 60_000);
    expect(episodeReads()).not.toContain(BAD);
  });

  it("une panne du modèle (délai) ne coupe pas le passage : les autres séries sont préparées, celle-ci attend", async () => {
    let calls = 0;
    setRecapModelForTests(async (_system, message) => {
      calls++;
      if (message.includes("Série 2")) throw Object.assign(new Error("délai"), { name: "APIConnectionTimeoutError" });
      return good();
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/Subtitles/")) return new Response("1\n00:20:00,000 --> 00:20:02,000\nTed Lasso arrive.\n");
      const series = /\/Shows\/([0-9a-f]+)\/Episodes/.exec(url)?.[1] ?? "";
      return new Response(JSON.stringify({ Items: episodesOf(series) }), { headers: { "content-type": "application/json" } });
    });
    expect(await runRecapPass(NOW)).toEqual({ prepared: 2, rejected: 0 });
    expect(calls).toBe(3);
    // La série en panne n'est pas redemandée au passage suivant : un délai se paie à chaque fois.
    await runRecapPass(NOW + 5 * 60_000);
    expect(calls).toBe(3);
  });

  it("une limite de débit arrête le passage au premier refus", async () => {
    const model = vi.fn(async () => {
      throw Object.assign(new Error("rate"), { status: 429 });
    });
    setRecapModelForTests(model);
    expect(await runRecapPass(NOW)).toEqual({ prepared: 0, rejected: 0 });
    // BAD échoue chez Jellyfin (de côté), GOOD reçoit le 429 : Bruno n'est pas tenté.
    expect(model).toHaveBeenCalledTimes(1);
    expect(episodeReads()).toEqual([BAD, GOOD]);
  });

  it("le plafond mensuel franchi en cours de passage l'arrête", async () => {
    const model = vi.fn(async () => {
      // Ce texte fait franchir le plafond (5 $) : le passage s'arrête avant la série suivante.
      spendDb.add(6, { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 }, Date.now(), "recap");
      return good();
    });
    setRecapModelForTests(model);
    expect(await runRecapPass(NOW)).toEqual({ prepared: 1, rejected: 0 });
    expect(model).toHaveBeenCalledTimes(1);
  });
});
