// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let account: string | null = "louis";
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => account }));
import { reportPlayback } from "@/lib/reportPlayback";
import { flushUnsentLines, keepUnsentLine, unsentLines, MAX_LINES, MAX_BYTES } from "@/lib/unsentLines";

/**
 * Les lignes du journal du lecteur qui n'ont pas pu partir.
 *
 * 01/10/2026 : le conteneur redémarre à 19:47:06 pendant un film, et le point de réserve dû vers
 * 19:46:53 manque à la séance — envoyé pendant que le serveur ne répondait pas, jamais renvoyé.
 */

type Call = [string, RequestInit];
const bodies = (mock: ReturnType<typeof vi.fn>) =>
  (mock.mock.calls as unknown as Call[]).map(([, init]) => JSON.parse(init.body as string) as { kind: string; fields: Record<string, unknown> });
/** Laisse passer les promesses de `fetch` et ce qu'elles déclenchent. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  account = "louis";
  Object.defineProperty(navigator, "sendBeacon", { value: undefined, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("une ligne qui n'a pas pu partir", () => {
  it("est gardée quand le serveur ne répond pas, avec le build qui l'a écrite", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Load failed"))));
    reportPlayback("reserve", { event: "point", session: "08ec5ca3" });
    await settle();
    const [line] = unsentLines();
    expect(line).toMatchObject({ kind: "reserve", account: "louis", fields: { event: "point", session: "08ec5ca3", build: expect.any(String) } });
    // L'identifiant n'est pas un champ de la ligne : il ne voyage qu'à l'envoi.
    expect(line.fields).not.toHaveProperty("lineId");
  });

  it("est gardée sur le 502/503 du relais pendant un redémarrage, pas sur un refus de l'application", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    reportPlayback("seek", { n: 1 });
    await settle();
    expect(unsentLines()).toHaveLength(1);

    // 400 : refusée, et le serait encore. 429 : renvoyer aggraverait. 403 : plus de session.
    for (const status of [400, 403, 429]) {
      fetchMock.mockResolvedValueOnce({ ok: false, status });
      reportPlayback("seek", { n: status });
    }
    await settle();
    expect(unsentLines()).toHaveLength(1);
  });

  it("repart après le prochain envoi réussi, marquée et datée de son premier envoi", async () => {
    const t0 = Date.parse("2026-10-01T19:46:53Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    const fetchMock = vi.fn(async () => Promise.reject(new TypeError("Load failed")));
    vi.stubGlobal("fetch", fetchMock);
    reportPlayback("reserve", { event: "point" });
    await settle();
    const first = bodies(fetchMock)[0];

    // Le serveur revient quarante secondes plus tard.
    now.mockReturnValue(t0 + 40_000);
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200 }) as unknown as never);
    reportPlayback("reserve", { event: "point", n: 2 });
    await settle();
    await settle();

    const sent = bodies(fetchMock);
    expect(sent).toHaveLength(3);
    const resent = sent[2];
    expect(resent.kind).toBe("reserve");
    expect(resent.fields).toMatchObject({ event: "point", resent: true, lateByMs: 40_000 });
    // Le même identifiant qu'au premier envoi : la route reconnaît un renvoi déjà reçu.
    expect(resent.fields.lineId).toBe(first.fields.lineId);
    expect(sent[1].fields).not.toHaveProperty("resent");
    expect(unsentLines()).toEqual([]);
  });

  it("n'est renvoyée qu'une fois retirée sur une réponse acceptée, et la passe s'arrête au premier échec", async () => {
    keepUnsentLine("aaaaaaaaaaaa", "seek", { n: 1 }, 1000);
    keepUnsentLine("bbbbbbbbbbbb", "seek", { n: 2 }, 1000);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    await flushUnsentLines(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unsentLines()).toHaveLength(2);

    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await flushUnsentLines(3000);
    expect(unsentLines()).toEqual([]);
    expect(bodies(fetchMock).slice(1).map((b) => b.fields.n)).toEqual([1, 2]);
  });

  it("n'est envoyée qu'au nom du compte qui l'a écrite", async () => {
    keepUnsentLine("aaaaaaaaaaaa", "seek", { n: 1 }, 1000);
    account = "timeo";
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await flushUnsentLines(2000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unsentLines()).toHaveLength(1);
  });

  it("ne part pas par balise : le navigateur ne dit pas ce qu'elle est devenue", async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    const fetchMock = vi.fn(async () => Promise.reject(new TypeError("Load failed")));
    vi.stubGlobal("fetch", fetchMock);
    reportPlayback("stop", { why: "close" });
    await settle();
    expect(beacon).toHaveBeenCalled();
    expect(unsentLines()).toEqual([]);
  });
});

describe("la file", () => {
  it("est bornée en lignes, les plus anciennes chassées d'abord", () => {
    for (let i = 0; i < MAX_LINES + 10; i++) keepUnsentLine(`id${String(i).padStart(8, "0")}`, "seek", { n: i }, 1000 + i);
    const kept = unsentLines();
    expect(kept).toHaveLength(MAX_LINES);
    expect(kept[0].fields.n).toBe(10);
    expect(kept.at(-1)?.fields.n).toBe(MAX_LINES + 9);
  });

  it("est bornée en octets", () => {
    const steps = "x".repeat(4000);
    for (let i = 0; i < 200; i++) keepUnsentLine(`id${String(i).padStart(8, "0")}`, "stall", { steps, n: i }, 1000 + i);
    expect((localStorage.getItem("cine:unsent-lines") ?? "").length).toBeLessThanOrEqual(MAX_BYTES);
    expect(unsentLines().at(-1)?.fields.n).toBe(199);
  });

  it("ne garde pas deux fois la même ligne", () => {
    keepUnsentLine("aaaaaaaaaaaa", "seek", { n: 1 }, 1000);
    keepUnsentLine("aaaaaaaaaaaa", "seek", { n: 1 }, 5000);
    expect(unsentLines()).toEqual([expect.objectContaining({ at: 1000 })]);
  });

  it("oublie ce qui est illisible", () => {
    localStorage.setItem("cine:unsent-lines", "{pas du json");
    expect(unsentLines()).toEqual([]);
    keepUnsentLine("aaaaaaaaaaaa", "seek", {}, 1000);
    expect(unsentLines()).toHaveLength(1);
  });
});

describe("sans stockage", () => {
  it("le lecteur continue, la ligne se passe de filet", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Load failed"))));
    expect(() => reportPlayback("seek", {})).not.toThrow();
    await settle();
    expect(() => keepUnsentLine("aaaaaaaaaaaa", "seek", {}, 1)).not.toThrow();
    await expect(flushUnsentLines(2)).resolves.toBeUndefined();
    expect(unsentLines()).toEqual([]);
  });
});
