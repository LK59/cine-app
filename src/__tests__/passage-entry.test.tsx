// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/liquidGlass/useLiquidDelegation", () => ({ useLiquidDelegation: () => {} }));
const nav = vi.hoisted(() => ({ to: [] as string[] }));
vi.mock("@/lib/signOut", () => ({ hardNavigate: (to: string) => void nav.to.push(to) }));

import { PassageEntry } from "@/components/passage/PassageEntry";
import { isInstalledApp } from "@/lib/iosInstall";

/**
 * La page `/passage` devant un navigateur déjà connecté (DECISIONS.md §119, relecture de sécurité du
 * 23/10/2026) : un lien piégé `#t=<jeton d'un autre compte>` ne change plus de compte sans accord.
 */
const TOKEN = "A".repeat(43);
const fetchMock = vi.fn();

beforeEach(() => {
  nav.to.length = 0;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", `/passage#t=${TOKEN}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sentBodies = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));

describe("PassageEntry — déjà connecté", () => {
  it("demande d'abord ; « Rester » n'envoie rien et ne consomme pas le jeton", async () => {
    render(<PassageEntry signedIn />);
    await screen.findByText("passage.page.confirm");
    expect(fetchMock).not.toHaveBeenCalled();
    // Le jeton a quand même quitté l'adresse.
    expect(window.location.hash).toBe("");
    fireEvent.click(screen.getByText("passage.page.confirmStay"));
    expect(nav.to).toEqual(["/"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("« Changer de compte » échange avec l'accord", async () => {
    render(<PassageEntry signedIn />);
    fireEvent.click(await screen.findByText("passage.page.confirmSwitch"));
    await waitFor(() => expect(nav.to).toEqual(["/"]));
    expect(sentBodies()).toEqual([{ token: TOKEN, replace: true }]);
  });

  it("non connecté : échange aussitôt, sans accord ; un 409 du serveur ramène à la question", async () => {
    render(<PassageEntry signedIn={false} />);
    await waitFor(() => expect(nav.to).toEqual(["/"]));
    expect(sentBodies()).toEqual([{ token: TOKEN }]);

    cleanup();
    nav.to.length = 0;
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: "passage-confirm" }), { status: 409 }));
    window.history.replaceState(null, "", `/passage#t=${TOKEN}`);
    render(<PassageEntry signedIn={false} />);
    await screen.findByText("passage.page.confirm");
    expect(nav.to).toEqual([]);
  });
});

// iPhone du propriétaire, 23/10/2026 : « Passer » ouvre la nouvelle adresse dans la vue intégrée de
// l'ancienne application, qui se dit « standalone ». L'arrivée par le lien marque l'onglet : il n'est
// pas l'application de l'écran d'accueil, et l'aide d'installation est demandée pour l'accueil.
describe("PassageEntry — arrivée par le lien sur iPhone", () => {
  afterEach(() => {
    delete (navigator as unknown as { userAgent?: string }).userAgent;
    sessionStorage.clear();
  });

  it("la vue intégrée « standalone » demande l'aide d'installation, et ne se lit plus comme installée", async () => {
    sessionStorage.clear();
    Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1" });
    window.matchMedia = ((q: string) => ({ matches: q.includes("standalone"), media: q, addEventListener: () => {}, removeEventListener: () => {} })) as never;
    expect(isInstalledApp()).toBe(true);
    render(<PassageEntry signedIn={false} />);
    await waitFor(() => expect(nav.to).toEqual(["/"]));
    expect(isInstalledApp()).toBe(false);
    expect(sessionStorage.getItem("cine:passage-install-help")).not.toBeNull();
  });
});
