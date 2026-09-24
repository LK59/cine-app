// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { SWRConfig } from "swr";

// L'écran d'accueil (21/09/2026) et ses règles : préremplir sans écraser, « Passer » jusqu'au
// prochain lancement seulement, seule la fin éteint le marqueur.

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v?.name !== undefined ? `${k}:${v.name}` : k),
  useLocale: () => ({ locale: "fr", setLocale: vi.fn(async () => {}) }),
}));
const errorToast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ error: errorToast, success: vi.fn() }) }));
vi.mock("@/components/PushToggle", () => ({ PushToggle: () => <div data-testid="push" /> }));

let pending = true;
let prefs: Record<string, string | null> = { audioLanguage: null, subtitleLanguage: null, subtitleMode: "Default" };
let me: Record<string, unknown> = { username: "louis", jfUser: "louis" };
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const json = (body: unknown) => new Response(JSON.stringify(body));
  if (url === "/api/onboarding" && init?.method === "POST") {
    pending = false;
    return json({ pending: false });
  }
  if (url === "/api/onboarding") return json({ pending });
  if (url === "/api/auth/me") return json(me);
  if (url === "/api/player/account/preferences" && init?.method === "POST") return json({ ok: true });
  if (url === "/api/player/account/preferences") return json(prefs);
  if (url === "/api/notifications/settings") return json({ preferences: { "new-episode": true, "request-available": true, "watchlist-available": true } });
  return json({});
});

import { PlayerOnboardingGate } from "@/components/player/PlayerOnboarding";
import { openOnboarding } from "@/components/player/onboardingEvents";

const draw = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PlayerOnboardingGate />
    </SWRConfig>
  );
const next = () => fireEvent.click(screen.getByText(/^player\.onboarding\.(next|finish)$/));
const called = (url: string) => fetchMock.mock.calls.some(([u]) => u === url);
const posted = (url: string) =>
  fetchMock.mock.calls.filter(([u, init]) => u === url && (init as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  sessionStorage.clear();
  pending = true;
  prefs = { audioLanguage: null, subtitleLanguage: null, subtitleMode: "Default" };
  me = { username: "louis", jfUser: "louis" };
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("l'écran d'accueil", () => {
  // « louis » s'écrit en minuscules ; l'accueil le dit « Louis », sans toucher au nom lui-même.

  it("se propose quand le marqueur du compte est allumé, et pas sinon", async () => {
    draw();
    expect(await screen.findByText("player.onboarding.welcomeTitle:Louis")).toBeTruthy();
    cleanup();
    pending = false;
    draw();
    await waitFor(() => expect(called("/api/onboarding")).toBe(true));
    expect(screen.queryByText(/welcomeTitle/)).toBeNull();
  });

  it("« Passer » le cache jusqu'au prochain lancement, sans toucher au marqueur", async () => {
    draw();
    fireEvent.click(await screen.findByText("player.onboarding.skip"));
    expect(screen.queryByText(/welcomeTitle/)).toBeNull();
    expect(Number(sessionStorage.getItem("cine:onboarding-skipped"))).toBeGreaterThan(0);
    expect(posted("/api/onboarding")).toHaveLength(0);

    // Même onglet, remonté : toujours caché. Nouveau lancement (session vide) : il revient.
    cleanup();
    draw();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/welcomeTitle/)).toBeNull();
    cleanup();
    sessionStorage.clear();
    draw();
    expect(await screen.findByText("player.onboarding.welcomeTitle:Louis")).toBeTruthy();
  });

  it("« Passer » ne tient pas plus de quelques heures dans un onglet qui ne se ferme jamais", async () => {
    // Safari sur Mac garde la session d'un onglet à travers rechargements et réouvertures : un
    // « Passer » du 21/09 cachait encore l'accueil le 24, marqueur allumé côté serveur.
    sessionStorage.setItem("cine:onboarding-skipped", String(Date.now() - 7 * 3600_000));
    draw();
    expect(await screen.findByText("player.onboarding.welcomeTitle:Louis")).toBeTruthy();
    cleanup();
    // L'ancienne valeur, écrite avant le correctif, ne cache plus rien.
    sessionStorage.setItem("cine:onboarding-skipped", "1");
    draw();
    expect(await screen.findByText("player.onboarding.welcomeTitle:Louis")).toBeTruthy();
    cleanup();
    sessionStorage.setItem("cine:onboarding-skipped", String(Date.now() - 3600_000));
    draw();
    await waitFor(() => expect(called("/api/onboarding")).toBe(true));
    expect(screen.queryByText(/welcomeTitle/)).toBeNull();
  });

  it("préremplit le français là où rien n'est réglé, et l'enregistre", async () => {
    draw();
    await screen.findByText("player.onboarding.welcomeTitle:Louis");
    next();
    await screen.findByText("player.onboarding.playbackTitle");
    const selects = await waitFor(() => {
      const found = screen.getAllByRole("combobox") as HTMLSelectElement[];
      expect(found[0].value).toBe("fra");
      return found;
    });
    expect(selects[1].value).toBe("fra");
    // Rien réglé du tout : « quand l'audio n'est pas dans ma langue ».
    expect(selects[2].value).toBe("Smart");
    next();
    await screen.findByText("player.onboarding.notifTitle");
    expect(JSON.parse(posted("/api/player/account/preferences")[0][1]!.body as string)).toEqual({
      audioLanguage: "fra",
      subtitleLanguage: "fra",
      subtitleMode: "Smart",
    });
  });

  it("n'écrase jamais un choix déjà fait chez Jellyfin", async () => {
    prefs = { audioLanguage: "eng", subtitleLanguage: "fra", subtitleMode: "OnlyForced" };
    draw();
    await screen.findByText("player.onboarding.welcomeTitle:Louis");
    next();
    await screen.findByText("player.onboarding.playbackTitle");
    await waitFor(() => expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("eng"));
    expect((screen.getAllByRole("combobox")[2] as HTMLSelectElement).value).toBe("OnlyForced");
    next();
    await screen.findByText("player.onboarding.notifTitle");
    // Rien de changé : rien d'écrit chez Jellyfin.
    expect(posted("/api/player/account/preferences")).toHaveLength(0);
  });

  it("seule la fin éteint le marqueur", async () => {
    draw();
    await screen.findByText("player.onboarding.welcomeTitle:Louis");
    next();
    await screen.findByText("player.onboarding.playbackTitle");
    await waitFor(() => expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("fra"));
    next();
    await screen.findByText("player.onboarding.notifTitle");
    expect(posted("/api/onboarding")).toHaveLength(0);
    next();
    await screen.findByText("player.onboarding.doneTitle");
    next();
    await waitFor(() => expect(posted("/api/onboarding")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("player.onboarding.doneTitle")).toBeNull());
  });

  it("saute les réglages de lecture pour un compte sans Jellyfin", async () => {
    me = { username: "admin", jfUser: null };
    draw();
    await screen.findByText("player.onboarding.welcomeTitle:Admin");
    await waitFor(() => expect(called("/api/auth/me")).toBe(true));
    next();
    expect(await screen.findByText("player.onboarding.notifTitle")).toBeTruthy();
  });

  it("se rouvre depuis Compte, même marqueur éteint", async () => {
    pending = false;
    draw();
    await waitFor(() => expect(called("/api/onboarding")).toBe(true));
    act(() => openOnboarding());
    expect(await screen.findByText("player.onboarding.welcomeTitle:Louis")).toBeTruthy();
  });
});
