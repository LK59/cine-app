// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
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

import RadarrPage from "@/app/(dashboard)/radarr/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockEmptyLibrary() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
  );
}

// Fresh Map-backed SWR cache per render — SWR's default cache is otherwise shared across every
// test in this file for the same fixed "/api/radarr/movies" key.
function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <RadarrPage />
    </SWRConfig>
  );
}

describe("Radarr library page — 'Ajouter un film' guest gating", () => {
  it("admin sees the Ajouter button", async () => {
    mockUseRole.mockReturnValue({ isGuest: false, role: "admin", jfId: null, jfUser: null });
    mockEmptyLibrary();
    renderPage();

    expect(await screen.findByText("radarr.addMovie")).toBeInTheDocument();
  });

  it("guest never sees the Ajouter button — the direct-add flow bypasses Jellyseerr attribution entirely", async () => {
    mockUseRole.mockReturnValue({ isGuest: true, role: "guest", jfId: "x", jfUser: "invite" });
    mockEmptyLibrary();
    renderPage();

    // Let the empty-library fetch resolve before asserting an absence.
    await screen.findByText("radarr.noMovies");
    expect(screen.queryByText("radarr.addMovie")).not.toBeInTheDocument();
  });
});
