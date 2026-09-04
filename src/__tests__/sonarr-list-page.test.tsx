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

import SonarrPage from "@/app/(dashboard)/sonarr/page";

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
// test in this file for the same fixed "/api/sonarr/series" key.
function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SonarrPage />
    </SWRConfig>
  );
}

describe("Sonarr library page — 'Ajouter une série' guest gating", () => {
  it("admin sees the Ajouter button", async () => {
    mockUseRole.mockReturnValue({ isReadOnly: false, role: "admin", jfId: null, jfUser: null });
    mockEmptyLibrary();
    renderPage();

    expect(await screen.findByText("sonarr.addSeries")).toBeInTheDocument();
  });

  it("guest never sees the Ajouter button — same direct-add bypass fixed on the movie side", async () => {
    mockUseRole.mockReturnValue({ isReadOnly: true, role: "user", jfId: "x", jfUser: "invite" });
    mockEmptyLibrary();
    renderPage();

    await screen.findByText("sonarr.noSeries");
    expect(screen.queryByText("sonarr.addSeries")).not.toBeInTheDocument();
  });
});
