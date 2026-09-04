// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}));
const mockUseRole = vi.fn();
vi.mock("@/lib/useRole", () => ({ useRole: () => mockUseRole() }));

import QbittorrentPage from "@/app/(dashboard)/qbittorrent/page";

const torrent = {
  hash: "abc123",
  name: "Un.Film.2024.1080p",
  state: "downloading",
  progress: 0.42,
  dlspeed: 1_000_000,
  upspeed: 0,
  size: 8_000_000_000,
  eta: 600,
  category: "radarr",
  tracker: "https://tracker.example/announce",
  ratio: 0,
  num_seeds: 10,
  num_leechs: 2,
  added_on: 1_700_000_000,
  content_path: "/downloads/Un.Film.2024.1080p",
  downloaded: 0,
  uploaded: 0,
};

/** Renvoie le mock de fetch, pour inspecter l'appel exact envoyé à la route. */
function stubApi(onAction: (url: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/qbittorrent/torrents" && !init?.method) {
      return Promise.resolve({ ok: true, json: async () => [torrent] });
    }
    if (url === "/api/qbittorrent/transfer") {
      return Promise.resolve({ ok: true, json: async () => ({ dl_info_speed: 0, up_info_speed: 0 }) });
    }
    return Promise.resolve(onAction(url, init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <QbittorrentPage />
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mockUseRole.mockReturnValue({ role: "admin", isGuest: false });
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("page Téléchargements", () => {
  it("envoie bien l'ordre de pause et bascule le bouton sur « relancer »", async () => {
    const fetchMock = stubApi(() => ({ ok: true, json: async () => ({ ok: true }) }));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Un.Film.2024.1080p");
    await user.click(screen.getByLabelText("qbittorrent.actionPause"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/qbittorrent/torrents/abc123",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "pause" }) })
      )
    );
    // Le serveur a dit oui : on le dit, et le bouton propose maintenant l'inverse.
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("qbittorrent.paused"));
    expect(screen.getByLabelText("qbittorrent.actionResume")).toBeInTheDocument();
  });

  it("remet le bouton sur « pause » et prévient quand qBittorrent refuse", async () => {
    stubApi(() => ({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => ({ error: "qBittorrent injoignable" }),
    }));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Un.Film.2024.1080p");
    await user.click(screen.getByLabelText("qbittorrent.actionPause"));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("qBittorrent injoignable"));
    expect(toastSuccess).not.toHaveBeenCalled();
    // L'état affiché revient à ce qu'il était : rien ne laisse croire que la pause a pris.
    await waitFor(() => expect(screen.getByLabelText("qbittorrent.actionPause")).toBeInTheDocument());
  });

  it("ne supprime rien tant que la confirmation n'est pas donnée", async () => {
    const fetchMock = stubApi(() => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Un.Film.2024.1080p");
    await user.click(screen.getByLabelText("qbittorrent.actionDelete"));

    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("deleteFiles"),
      expect.anything()
    );
  });

  it("cache les boutons d'action aux invités", async () => {
    mockUseRole.mockReturnValue({ role: "guest", isGuest: true });
    stubApi(() => ({ ok: true, json: async () => ({}) }));
    renderPage();

    await screen.findByText("Un.Film.2024.1080p");
    expect(screen.queryByLabelText("qbittorrent.actionPause")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("qbittorrent.actionDelete")).not.toBeInTheDocument();
  });
});
