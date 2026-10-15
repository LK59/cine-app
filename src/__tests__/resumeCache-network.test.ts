import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Le passage d'arrière-plan selon le réseau (DECISIONS.md §104, ROBUSTESSE-12).
 *
 * Passe de nuit du 15/10/2026 : 70 à 77 Mo partis en dix secondes au premier lancement, données
 * mobiles comprises. Le passage réel (`runResumeCache`), le stockage, le budget et l'enregistrement
 * remplacés : on compte les titres qui partent au réseau, et quand.
 */

const recordTitle = vi.fn(async () => 8);
vi.mock("@/lib/resumeCache/recordTitle", () => ({
  recordTitle: (...a: unknown[]) => (recordTitle as (...x: unknown[]) => Promise<number>)(...a),
  mustStop: (signal: AbortSignal) => signal.aborted,
}));
vi.mock("@/lib/resumeCache/store", () => ({
  readResumeIndex: async () => ({}),
  removeResumeEntry: async () => {},
  sweepResumeStore: async () => {},
}));
vi.mock("@/lib/resumeCache/budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resumeCache/budget")>()),
  deviceBudget: async () => ({ mode: "normal", totalChunks: 1024 }),
  deviceUsage: async () => null,
}));
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => "compte" }));
vi.mock("@/lib/uiQuiet", () => ({ whenUiQuiet: async () => {}, watchUiActivity: () => {} }));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ session: null }) }));

const targets = Array.from({ length: 5 }, (_, i) => ({ itemId: `t${i}`, startSeconds: 600, started: true }));

function setConnection(connection: Record<string, unknown> | undefined) {
  vi.stubGlobal("navigator", { connection });
}

beforeEach(async () => {
  recordTitle.mockClear();
  vi.useFakeTimers();
  const m = await import("@/lib/resumeCache/useResumeCache");
  m.resetResumeCacheForTests?.();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("le mode réseau", () => {
  it("économie, cellulaire, sinon normal — et rien de connu reste normal", async () => {
    const { resumeNetworkMode } = await import("@/lib/resumeCache/network");
    expect(resumeNetworkMode({ saveData: true, type: "wifi" })).toBe("économie");
    expect(resumeNetworkMode({ type: "cellular" })).toBe("cellulaire");
    expect(resumeNetworkMode({ type: "wifi" })).toBe("normal");
    expect(resumeNetworkMode({})).toBe("normal");
    expect(resumeNetworkMode(undefined)).toBe("normal");
  });
});

describe("runResumeCache selon le réseau", () => {
  it("Wi-Fi ou inconnu (Safari n'a pas `connection`) : tous les titres, comme avant", async () => {
    setConnection(undefined);
    const { runResumeCache } = await import("@/lib/resumeCache/useResumeCache");
    const pass = runResumeCache(targets, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10_000);
    await pass;
    expect(recordTitle).toHaveBeenCalledTimes(5);
  });

  it("économie de données : rien n'est téléchargé", async () => {
    setConnection({ saveData: true });
    const { runResumeCache } = await import("@/lib/resumeCache/useResumeCache");
    const pass = runResumeCache(targets, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await pass;
    expect(recordTitle).not.toHaveBeenCalled();
  });

  it("données mobiles : le titre en tête tout de suite, les suivants deux minutes à part", async () => {
    setConnection({ type: "cellular" });
    const { runResumeCache } = await import("@/lib/resumeCache/useResumeCache");
    const pass = runResumeCache(targets, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10_000);
    // Avant : les cinq dans ces dix secondes.
    expect(recordTitle).toHaveBeenCalledTimes(1);
    expect((recordTitle.mock.calls[0] as unknown[])[1]).toMatchObject({ itemId: "t0" });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(recordTitle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3 * 2 * 60_000);
    await pass;
    expect(recordTitle).toHaveBeenCalledTimes(5);
  });

  it("données mobiles : un passage relancé ne repart pas d'un premier titre immédiat", async () => {
    setConnection({ type: "cellular" });
    const { runResumeCache } = await import("@/lib/resumeCache/useResumeCache");
    const first = new AbortController();
    const pass = runResumeCache(targets, first.signal);
    await vi.advanceTimersByTimeAsync(10_000);
    first.abort();
    await vi.advanceTimersByTimeAsync(0);
    await pass;
    expect(recordTitle).toHaveBeenCalledTimes(1);
    const again = runResumeCache(targets.slice(1), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(recordTitle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(recordTitle).toHaveBeenCalledTimes(2);
    again.catch(() => {});
  });

  it("passé du Wi-Fi aux données mobiles en cours de passage : ralentit au titre suivant", async () => {
    const connection: Record<string, unknown> = { type: "wifi" };
    setConnection(connection);
    recordTitle.mockImplementationOnce(async () => {
      connection.type = "cellular";
      return 8;
    });
    const { runResumeCache } = await import("@/lib/resumeCache/useResumeCache");
    void runResumeCache(targets, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recordTitle).toHaveBeenCalledTimes(1);
  });
});
