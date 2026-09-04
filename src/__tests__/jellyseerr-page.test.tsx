// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img alt={props.alt as string} />;
  },
}));
vi.mock("next/link", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

const mockUseRole = vi.fn();
vi.mock("@/lib/useRole", () => ({
  useRole: () => mockUseRole(),
}));

import JellyseerrPage from "@/app/(dashboard)/jellyseerr/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const oneRequest = {
  id: 42,
  status: 1,
  media: { title: "Some Movie", tmdbId: 1, mediaType: "movie", posterPath: null },
  type: "movie",
  createdAt: new Date().toISOString(),
  requestedBy: { id: 1, displayName: "Someone" },
  cinemaHref: null,
};

function mockRequestsList() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [oneRequest] }) })
  );
}

// Fresh Map-backed SWR cache per render, same reasoning as the other page tests.
function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <JellyseerrPage />
    </SWRConfig>
  );
}

describe("Jellyseerr page — approve/decline guest gating", () => {
  it("admin sees the approve/decline buttons on a pending request", async () => {
    mockUseRole.mockReturnValue({ isReadOnly: false, role: "admin", jfId: null, jfUser: null });
    mockRequestsList();
    renderPage();

    expect(await screen.findByTitle("jellyseerr.approve")).toBeInTheDocument();
    expect(screen.getByTitle("jellyseerr.deny")).toBeInTheDocument();
  });

  it("guest never sees approve/decline, even on the 'all requests' tab they're limited to", async () => {
    mockUseRole.mockReturnValue({ isReadOnly: true, role: "user", jfId: "x", jfUser: "invite" });
    mockRequestsList();
    renderPage();

    // Guest's default tab is "mine" (jfUser is set) — switch to "all" to hit the same
    // showActions={!isReadOnly} code path an admin sees requests through.
    await screen.findByText("jellyseerr.tabAll");

    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    await user.click(screen.getByText("jellyseerr.tabAll"));

    await screen.findByText("Some Movie");
    expect(screen.queryByTitle("jellyseerr.approve")).not.toBeInTheDocument();
    expect(screen.queryByTitle("jellyseerr.deny")).not.toBeInTheDocument();
  });
});
