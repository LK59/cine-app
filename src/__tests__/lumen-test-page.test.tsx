// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LumenTest } from "@/components/lumenTest/LumenTest";
import { SERIES } from "@/components/lumenTest/autoSeries";

// La page de banc `/lumen-test` (étape 3b, DECISIONS.md §157) : ce qu'on peut en éprouver sans lecteur
// HLS — elle se monte, propose les trois découpes, refuse un identifiant mal formé sans appeler le
// serveur, demande le verdict avec la découpe choisie, et envoie une ligne `kind: "lumen-test"`.
// La lecture elle-même ne se mesure que sur un appareil (protocole dans docs/remux-serveur/README.md).
// « Tout enchaîner » : la série branchée sur la vraie page — un verdict par essai, une ligne par essai, puis les
// deux questions et la ligne récapitulative (l'enchaînement lui-même : `lumen-test-auto.test.ts`).

beforeEach(() => {
  // jsdom n'a pas `matchMedia` ; la page le lit pour dire si elle tourne dans l'application installée.
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("la page de banc de Lumen serveur", () => {
  it("propose les trois découpes, et un identifiant mal formé n'appelle rien", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LumenTest />);
    expect(screen.getByText("Banc Lumen serveur")).toBeInTheDocument();
    for (const label of ["cra (la règle)", "idr (essai)", "cra-leading (essai)"]) expect(screen.getByText(label)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Préparer"));
    expect(await screen.findByText(/Identifiant Jellyfin attendu/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("demande le verdict avec la découpe choisie, puis envoie les résultats", async () => {
    const id = "b".repeat(32);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(`/api/lumen/${id}/eligibility`)) {
        return new Response(
          JSON.stringify({ ok: true, version: "2i1-0123456789ab", audioTrack: 2, audio: [{ number: 2, codec: "A_EAC3", language: "fre", name: null, channels: 6, hlsChannels: "6", isDefault: true, servable: true, refusal: null }], segments: 10, targetS: 9, cutFacts: { cut: "idr", longestS: 8.5, verified: 10, craRasl: 4, cuts: 10, trusted: 0 } }),
          { status: 200 }
        );
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LumenTest />);
    fireEvent.change(screen.getByPlaceholderText("32 caractères hexadécimaux"), { target: { value: id } });
    fireEvent.click(screen.getByText("idr (essai)"));
    fireEvent.click(screen.getByText("Préparer"));
    expect((await screen.findAllByText(/CRA à RASL vérifiées 4\/10/)).length).toBeGreaterThan(0);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/cut=idr(&|$)/);
    fireEvent.click(screen.getByText("Envoyer les résultats"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/viewport-diag")).toBe(true));
    const sentCall = fetchMock.mock.calls.find(([url]) => url === "/api/viewport-diag") as unknown as [string, RequestInit];
    expect(JSON.parse(String(sentCall[1].body))).toMatchObject({ kind: "lumen-test", runs: [] });
  });

  it("« Tout enchaîner » : chaque essai demandé dans l'ordre et envoyé, même refusé, puis le bilan avec les réponses", async () => {
    // jsdom n'a pas de lecteur : `load`/`play`/`pause` tus (ils ne feraient qu'écrire « Not implemented »).
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.reject(new DOMException("pas de source", "NotSupportedError")));
    const eligibility: string[] = [];
    const lines: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/lumen/")) {
          eligibility.push(url);
          const cut = new URL(url, "http://x").searchParams.get("cut");
          // Tout refusé : la série ne lit rien et doit pourtant passer chaque essai et envoyer chaque ligne.
          return new Response(JSON.stringify({ ok: false, reason: "segment-trop-long", detail: "208 s", audioTrack: null, audio: [], segments: 3, cutFacts: { cut, longestS: 208, verified: 1, craRasl: 0, cuts: 3 } }), { status: 200 });
        }
        if (url === "/api/viewport-diag") lines.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      })
    );
    render(<LumenTest />);
    fireEvent.click(screen.getByText("Tout enchaîner"));
    const sendSummary = await screen.findByText("Envoyer le bilan", undefined, { timeout: 5000 });
    // Un verdict par essai, avec la découpe de l'essai ; Le Prestige deux fois (idr puis cra).
    const expected = SERIES.flatMap((t) => (t.prepareOnly ?? [t.cut]).map((cut) => `${t.itemId}:${cut}`));
    expect(eligibility.map((u) => `${u.split("/")[3]}:${new URL(u, "http://x").searchParams.get("cut")}`)).toEqual(expected);
    // Une ligne par essai, marquée de l'essai et de son rang, refus compris.
    expect(lines.map((l) => (l.auto as { trial: string; rank: number }).trial)).toEqual(SERIES.map((t) => t.id));
    expect(lines.map((l) => (l.auto as { rank: number }).rank)).toEqual(SERIES.map((_, i) => i + 1));
    expect(lines[0]).toMatchObject({ kind: "lumen-test", auto: { of: SERIES.length, status: "refusé" }, runs: [{ trial: "maison-blanche-idr", rank: 1, cut: "idr", verdict: { ok: false, reason: "segment-trop-long" } }] });
    expect(screen.getByText(/1\. À la Maison Blanche S03E01 · idr — refusé : segment-trop-long/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Oui")[0]);
    fireEvent.change(screen.getByLabelText(/Sur quel titre/), { target: { value: "Ghosted" } });
    fireEvent.click(screen.getByText("Je n'ai pas entendu"));
    fireEvent.click(sendSummary);
    await screen.findByText(/Bilan envoyé/);
    const summary = lines.at(-1)!;
    expect(summary).toMatchObject({ kind: "lumen-test", auto: { summary: true, of: SERIES.length, done: SERIES.length, stopped: false }, answers: { damaged: "oui", damagedTitle: "Ghosted", audioClean: "pas-entendu" } });
    expect((summary.trials as { trial: string }[]).map((t) => t.trial)).toEqual(SERIES.map((t) => t.id));
  });
});
