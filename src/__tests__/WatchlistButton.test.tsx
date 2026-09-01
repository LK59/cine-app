// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
}));

import { WatchlistButton } from "@/components/WatchlistButton";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Fresh Map-backed SWR cache per render — same reasoning as the other component tests: the
// item-status key is shared across tests otherwise and would leak a cached "in list" flag.
function renderButton(props: Partial<Parameters<typeof WatchlistButton>[0]> = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <WatchlistButton mediaType="movie" tmdbId={1} title="Some Movie" {...props} />
    </SWRConfig>
  );
}

describe("WatchlistButton", () => {
  it("shows 'add' before the item-status fetch resolves and after it resolves absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ item: null }) }));
    renderButton();

    await waitFor(() => expect(screen.getByText("common.add")).toBeInTheDocument());
  });

  it("shows 'remove' once the item is already in the watchlist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ item: { tmdbId: 1, mediaType: "movie" } }) })
    );
    renderButton();

    await waitFor(() => expect(screen.getByText("search.removeFromList")).toBeInTheDocument());
  });

  it("POSTs the add and the item then reads back as in-list after revalidation", async () => {
    // Stateful mock: the item-status GET reflects whatever the last POST/DELETE did, the way the
    // real API would. A GET mock that always returns null would mask the POST outcome once the
    // post-toggle revalidate (mutate(itemKey) with no data) re-fetches it.
    let inList = false;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/watchlist/item")) {
        return Promise.resolve({ ok: true, json: async () => ({ item: inList ? { tmdbId: 1, mediaType: "movie" } : null }) });
      }
      if (url === "/api/watchlist" && init?.method === "POST") inList = true;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderButton();

    await waitFor(() => expect(screen.getByText("common.add")).toBeInTheDocument());
    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(screen.getByText("search.removeFromList")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/watchlist",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("rolls back the optimistic flip when the POST fails", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/watchlist" && init?.method === "POST") return Promise.resolve({ ok: false, json: async () => ({}) });
      return Promise.resolve({ ok: true, json: async () => ({ item: null }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderButton();

    await waitFor(() => expect(screen.getByText("common.add")).toBeInTheDocument());
    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(screen.getByText("common.add")).toBeInTheDocument());
  });

  it("ignores a second click while a toggle is already in flight", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/watchlist" && init?.method === "POST") {
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: async () => ({}) }), 50));
      }
      return Promise.resolve({ ok: true, json: async () => ({ item: null }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderButton();

    await waitFor(() => expect(screen.getByText("common.add")).toBeInTheDocument());
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => u === "/api/watchlist").length).toBe(1)
    );
  });
});
