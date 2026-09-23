// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

// Le 21/09/2026 : les trois annonces d'un spectateur se règlent depuis le panneau Compte.
// Avant, un compte ordinaire ne pouvait que tout couper.

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ["fr", vi.fn()] }));
const errorToast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ error: errorToast, success: vi.fn() }) }));
vi.mock("@/components/PushToggle", () => ({ PushToggle: () => <div /> }));
vi.mock("@/components/player/PlayerPanelFrame", () => ({
  PlayerPanelFrame: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

let prefs = { "new-episode": true, "request-available": true, "watchlist-available": false, "torrent-complete": true, "torrent-started": false };
let putOk = true;
let role = "user";
let testStatus = 200;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === "/api/notifications/settings" && init?.method === "PUT") {
    if (!putOk) return new Response(JSON.stringify({ error: "refusé" }), { status: 403 });
    prefs = { ...prefs, ...JSON.parse(init.body as string).preferences };
    return new Response(JSON.stringify({ preferences: prefs }));
  }
  if (url === "/api/notifications/settings") return new Response(JSON.stringify({ preferences: prefs }));
  if (url === "/api/auth/me") return new Response(JSON.stringify({ username: "mathis", jfUser: null, role }));
  if (url === "/api/push/test") return new Response(JSON.stringify({ ok: testStatus === 200 }), { status: testStatus });
  return new Response(JSON.stringify({}));
});
vi.stubGlobal("fetch", fetchMock);

import { PlayerAccountPanel } from "@/components/player/PlayerAccountPanel";

const draw = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PlayerAccountPanel />
    </SWRConfig>
  );

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  errorToast.mockClear();
  putOk = true;
  role = "user";
  testStatus = 200;
  vi.useRealTimers();
});

describe("les notifications qu'on choisit, depuis le cinéma", () => {
  it("propose les trois annonces d'un spectateur, et pas celles des téléchargements", async () => {
    draw();
    expect(await screen.findByText("player.account.notifNewEpisode")).toBeTruthy();
    expect(screen.getByText("player.account.notifRequest")).toBeTruthy();
    expect(screen.getByText("player.account.notifList")).toBeTruthy();
    expect(screen.queryByText(/torrent/i)).toBeNull();
  });

  it("enregistre un choix sous le compte", async () => {
    draw();
    await screen.findByText("player.account.notifList");
    fireEvent.click(screen.getByRole("switch", { name: "player.account.notifList" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/notifications/settings",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ preferences: { "watchlist-available": true } }) })
      )
    );
  });

  it("revient en arrière et le dit quand le serveur refuse", async () => {
    putOk = false;
    draw();
    await screen.findByText("player.account.notifNewEpisode");
    fireEvent.click(screen.getByRole("switch", { name: "player.account.notifNewEpisode" }));
    await waitFor(() => expect(errorToast).toHaveBeenCalledWith("refusé"));
  });
});

// Le 23/09/2026 : tout se règle ici, et la gestion n'en a plus de copie.
describe("le panneau Compte, seul endroit où se règlent les notifications", () => {
  it("montre à l'administrateur les annonces de téléchargement, sous les siennes", async () => {
    role = "admin";
    draw();
    expect(await screen.findByText("player.account.notifDownloads")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "player.account.notifDownloadStarted" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/notifications/settings",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ preferences: { "torrent-started": true } }) })
      )
    );
  });

  it("ne les montre pas à un compte ordinaire", async () => {
    draw();
    await screen.findByText("player.account.notifList");
    expect(screen.queryByText("player.account.notifDownloads")).toBeNull();
  });

  // Sans appareil abonné, l'essai ne peut rien envoyer : il faut le dire, pas « échec ».
  it("envoie un essai après le délai, et dit quand aucun appareil n'est abonné", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    testStatus = 404;
    draw();
    await screen.findByText("player.account.notifTest");
    fireEvent.click(screen.getByText("notifications.testButton"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledWith("/api/push/test", { method: "POST" });
    expect(await screen.findByText("player.account.notifTestNoDevice")).toBeTruthy();
  });
});
