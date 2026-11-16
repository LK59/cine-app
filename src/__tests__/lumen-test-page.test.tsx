// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LumenTest } from "@/components/lumenTest/LumenTest";

// La page de banc `/lumen-test` (étape 3b, DECISIONS.md §157) : ce qu'on peut en éprouver sans lecteur
// HLS — elle se monte, propose les trois découpes, refuse un identifiant mal formé sans appeler le
// serveur, demande le verdict avec la découpe choisie, et envoie une ligne `kind: "lumen-test"`.
// La lecture elle-même ne se mesure que sur un appareil (protocole dans docs/remux-serveur/README.md).

beforeEach(() => {
  // jsdom n'a pas `matchMedia` ; la page le lit pour dire si elle tourne dans l'application installée.
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("la page de banc de Lumen serveur", () => {
  it("propose les trois découpes, et un identifiant mal formé n'appelle rien", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LumenTest />);
    expect(screen.getByText("Banc Lumen serveur")).toBeInTheDocument();
    for (const label of ["idr (la règle)", "cra (essai)", "cra-leading (essai)"]) expect(screen.getByText(label)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Préparer"));
    expect(await screen.findByText(/Identifiant Jellyfin attendu/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("demande le verdict avec la découpe choisie, puis envoie les résultats", async () => {
    const id = "b".repeat(32);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(`/api/lumen/${id}/eligibility`)) {
        return new Response(
          JSON.stringify({ ok: true, version: "1c1-0123456789ab", audioTrack: 2, audio: [{ number: 2, codec: "A_EAC3", language: "fre", name: null, channels: 6, hlsChannels: "6", isDefault: true, servable: true, refusal: null }], segments: 10, targetS: 9, cutFacts: { cut: "cra", longestS: 8.5, verified: 10, craRasl: 4, cuts: 10 } }),
          { status: 200 }
        );
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LumenTest />);
    fireEvent.change(screen.getByPlaceholderText("32 caractères hexadécimaux"), { target: { value: id } });
    fireEvent.click(screen.getByText("cra (essai)"));
    fireEvent.click(screen.getByText("Préparer"));
    await screen.findByText(/CRA à RASL vérifiées 4\/10/);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/cut=cra(&|$)/);
    fireEvent.click(screen.getByText("Envoyer les résultats"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/viewport-diag")).toBe(true));
    const sentCall = fetchMock.mock.calls.find(([url]) => url === "/api/viewport-diag") as unknown as [string, RequestInit];
    expect(JSON.parse(String(sentCall[1].body))).toMatchObject({ kind: "lumen-test", runs: [] });
  });
});
