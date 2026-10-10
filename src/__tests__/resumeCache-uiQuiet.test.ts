// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// L'enregistrement d'un titre sur l'appareil lit l'en-tête et l'index du fichier d'un tenant, sur le
// fil principal : 100 à 270 ms sur un téléphone ralenti. Il ne commence jamais pendant un geste — un
// appui sur une affiche tombait au milieu, et l'ouverture de la fiche démarrait derrière (Chromium,
// iPhone 13, processeur ×4, 10/10/2026 : la plus longue tâche pendant l'ouverture d'une fiche du
// Top 10 était cette lecture).

const open = vi.fn(async () => ({ withoutReadahead: () => ({}) }));
vi.mock("@/lib/directInfo", () => ({
  fetchDirectInfo: vi.fn(async () => ({ streamUrl: "/api/jellyfin/stream/x/stream.mkv", sizeBytes: 1_000_000, fileVersion: "v1" })),
}));
vi.mock("@/lib/playbackBusy", () => ({ isWatchingFullScreen: () => false }));
vi.mock("@/lib/webcodecs/byteSource", () => ({ CHUNK_SIZE: 1 << 20, HttpByteSource: { open } }));
vi.mock("@/lib/resumeCache/record", () => ({ recordOpening: vi.fn(async () => null) }));
vi.mock("@/lib/resumeCache/store", () => ({
  readResumeManifest: vi.fn(async () => null),
  removeResumeEntry: vi.fn(async () => {}),
  commitResumeEntry: vi.fn(async () => true),
  resumeStoreGeneration: () => 1,
  writeResumeChunk: vi.fn(async () => {}),
}));

const { recordTitle } = await import("@/lib/resumeCache/recordTitle");
const { UI_QUIET_MS, uiQuietForTests } = await import("@/lib/uiQuiet");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  uiQuietForTests.reset();
  open.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("l'enregistrement d'une ouverture sur l'appareil", () => {
  it("attend la fin du geste avant de lire le fichier", async () => {
    uiQuietForTests.touch(); // un appui sur une affiche, à l'instant
    void recordTitle("louis", { itemId: "x", startSeconds: 0 }, 32, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(UI_QUIET_MS - 200);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("au repos, part tout de suite", async () => {
    void recordTitle("louis", { itemId: "x", startSeconds: 0 }, 32, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("pendant un film (l'épisode suivant préparé au générique), il n'attend pas de geste", async () => {
    uiQuietForTests.touch();
    void recordTitle("louis", { itemId: "x", startSeconds: 0 }, 32, new AbortController().signal, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
