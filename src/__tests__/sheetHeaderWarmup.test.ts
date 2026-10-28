// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * L'en-tête du fichier lu pendant que la fiche est à l'écran (`sheetHeaderWarmup.ts`) : rien avant
 * une seconde, un seul fichier à la fois, tout arrêté à la fermeture, et jamais au prix du relais
 * qu'un film tout juste fermé a laissé à sa réouverture.
 */

const h = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  openMediaFile: vi.fn(async () => ({ tracks: [] })),
  info: vi.fn(async (id: string) => ({ streamUrl: `/api/jellyfin/stream/${id}/stream.mkv?static=true`, sizeBytes: 5000, fileVersion: "etag-1" as string | undefined })),
  openDisk: vi.fn(async () => null as unknown),
  account: "louis" as string | null,
  held: null as string | null,
}));
vi.mock("@/lib/webcodecs/byteSource", () => ({
  HttpByteSource: { open: (...a: unknown[]) => h.open(...a) },
  holdsHandover: (url: string) => url === h.held,
}));
vi.mock("@/lib/webcodecs/mediaFile", async (importOriginal) => ({
  mediaHeaderKey: (await importOriginal<typeof import("@/lib/webcodecs/mediaFile")>()).mediaHeaderKey,
  openMediaFile: (...a: unknown[]) => h.openMediaFile(...(a as [])),
}));
vi.mock("@/lib/directInfo", () => ({ fetchDirectInfo: (id: string) => h.info(id) }));
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => h.account }));
vi.mock("@/lib/resumeCache/diskChunks", () => ({ openDiskChunks: (...a: unknown[]) => h.openDisk(...(a as [])) }));

import { forgetSheetHeaderWarmups, scheduleSheetHeaderWarmup, SHEET_WARMUP_DELAY_MS } from "@/lib/sheetHeaderWarmup";

/** Une source dont chaque fermeture est comptée, et dont la lecture d'en-tête peut rester pendante. */
function fakeSource() {
  const source = { close: vi.fn((leaveForNext?: boolean) => h.close(leaveForNext)), withoutReadahead: vi.fn(() => source) };
  return source;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  forgetSheetHeaderWarmups();
  h.account = "louis";
  h.held = null;
  h.open.mockImplementation(async () => fakeSource());
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("l'en-tête préparé depuis la fiche", () => {
  it("après une seconde : lit l'en-tête sous le nom que l'ouverture cherchera, puis ferme la source sans la laisser au relais", async () => {
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.open).toHaveBeenCalledWith("/api/jellyfin/stream/film/stream.mkv?static=true", 5000, null);
    expect(h.openMediaFile).toHaveBeenCalledWith(expect.anything(), "/api/jellyfin/stream/film/stream.mkv?static=true#etag-1");
    expect(h.close).toHaveBeenCalledWith(false);
  });

  it("une fiche fermée avant la seconde ne lit rien", async () => {
    const cancel = scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS - 1);
    cancel();
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.info).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("la fermeture de la fiche coupe une lecture en cours", async () => {
    let finish: (v: { tracks: never[] }) => void = () => {};
    h.openMediaFile.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const cancel = scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.openMediaFile).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
    cancel();
    expect(h.close).toHaveBeenCalledWith(false);
    finish({ tracks: [] });
    await flush();
  });

  it("un fichier à la fois : la fiche suivante arrête la lecture de la précédente", async () => {
    h.openMediaFile.mockImplementationOnce(() => new Promise(() => {}));
    scheduleSheetHeaderWarmup("premier");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.close).not.toHaveBeenCalled();
    scheduleSheetHeaderWarmup("second");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    // La première source est fermée dès que la seconde part, puis la seconde à la fin de sa lecture.
    expect(h.close).toHaveBeenCalledTimes(2);
    expect(h.openMediaFile).toHaveBeenLastCalledWith(expect.anything(), "/api/jellyfin/stream/second/stream.mkv?static=true#etag-1");
  });

  it("ne touche pas au relais qu'un film tout juste fermé laisse à sa réouverture", async () => {
    h.held = "/api/jellyfin/stream/film/stream.mkv?static=true";
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("rien quand l'appareil économise ses données, ni quand la page est cachée", async () => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.info).not.toHaveBeenCalled();
  });

  it("un titre gardé sur l'appareil se lit depuis l'appareil", async () => {
    const disk = { kind: "disque" };
    h.openDisk.mockResolvedValueOnce(disk);
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.open).toHaveBeenCalledWith(expect.any(String), 5000, disk);
  });

  it("un échec ne lève rien : l'ouverture lira l'en-tête elle-même", async () => {
    h.openMediaFile.mockRejectedValueOnce(new Error("réseau"));
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.close).toHaveBeenCalledWith(false);
  });
});
