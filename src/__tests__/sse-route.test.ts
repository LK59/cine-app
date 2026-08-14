import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

const mockQbittorrent = { getTorrents: vi.fn() };
vi.mock("@/lib/clients/qbittorrent", () => ({ qbittorrent: mockQbittorrent }));
const mockSendPushToAll = vi.fn();
vi.mock("@/lib/push", () => ({ sendPushToAll: (...a: unknown[]) => mockSendPushToAll(...a) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function fakeReq(): { req: NextRequest; abort: () => void } {
  const controller = new AbortController();
  const req = { signal: controller.signal } as unknown as NextRequest;
  return { req, abort: () => controller.abort() };
}

async function readNextChunk(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockQbittorrent.getTorrents.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/sse", () => {
  it("immediately sends a 'connected' event on subscribe", async () => {
    const { GET } = await import("@/app/api/sse/route");
    const { req } = fakeReq();
    const res = await GET(req);
    const chunk = await readNextChunk(res.body!);
    expect(chunk).toContain("event: connected");
  });

  it("broadcasts torrent-started only for downloads not already active on a previous tick", async () => {
    mockQbittorrent.getTorrents.mockResolvedValue([{ hash: "h1", name: "Movie X", state: "downloading" }]);
    const { GET } = await import("@/app/api/sse/route");
    const { req } = fakeReq();
    const res = await GET(req);
    const reader = res.body!.getReader();
    await reader.read(); // consume the initial "connected" event

    // First poll tick just bootstraps state — must not fire a push for something already downloading.
    await vi.advanceTimersByTimeAsync(6000);
    expect(mockSendPushToAll).not.toHaveBeenCalled();

    // A brand new torrent appears afterwards -> should notify.
    mockQbittorrent.getTorrents.mockResolvedValue([
      { hash: "h1", name: "Movie X", state: "downloading" },
      { hash: "h2", name: "Movie Y", state: "downloading" },
    ]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(mockSendPushToAll).toHaveBeenCalledWith(expect.objectContaining({ tag: "torrent-started", body: "Movie Y" }));
    reader.releaseLock();
  });

  it("removes the client on abort without throwing", async () => {
    const { GET } = await import("@/app/api/sse/route");
    const { req, abort } = fakeReq();
    const res = await GET(req);
    const reader = res.body!.getReader();
    await reader.read();
    expect(() => abort()).not.toThrow();
  });
});
