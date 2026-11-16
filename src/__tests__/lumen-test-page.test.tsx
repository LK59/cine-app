// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LumenTest } from "@/components/lumenTest/LumenTest";
import { QUICK_SERIES, SERIES } from "@/components/lumenTest/autoSeries";

// La page de banc `/lumen-test` (étape 3b, DECISIONS.md §157) : ce qu'on peut en éprouver sans lecteur
// HLS — elle se monte, propose les trois découpes, refuse un identifiant mal formé sans appeler le
// serveur, demande le verdict avec la découpe choisie, et envoie une ligne `kind: "lumen-test"`.
// La lecture elle-même ne se mesure que sur un appareil (protocole dans docs/remux-serveur/README.md).
// « Tout enchaîner » et « Comparatif rapide » : la série branchée sur la vraie page — un verdict par essai (les
// deux lecteurs le demandent : la piste et la durée), la description du fichier pour le lecteur actuel, une
// ligne par essai marquée du lecteur, puis les deux questions, le tableau et la ligne récapitulative
// (l'enchaînement lui-même : `lumen-test-auto.test.ts`).

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

  /** Tout refusé : la série ne lit rien et doit pourtant passer chaque essai et envoyer chaque ligne. */
  function refusingServer() {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.reject(new DOMException("pas de source", "NotSupportedError")));
    const eligibility: string[] = [];
    const direct: string[] = [];
    const lines: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/lumen/")) {
          eligibility.push(url);
          const cut = new URL(url, "http://x").searchParams.get("cut");
          return new Response(JSON.stringify({ ok: false, reason: "son-codec", detail: "A_DTS", audioTrack: 2, audio: [], segments: 3, cutFacts: { cut, longestS: 14, verified: 1, craRasl: 0, cuts: 3, trusted: 2 } }), { status: 200 });
        }
        if (url.startsWith("/api/jellyfin/direct/")) {
          // Le lecteur actuel : la description que son hôte lit, ici un fichier qu'il refuserait — rien ne s'ouvre.
          direct.push(url);
          return new Response(JSON.stringify({ streamUrl: "/x", sizeBytes: 1, fileVersion: null, video: { rangeType: "SDR" }, refusedReason: "conteneur non pris en charge", audio: [] }), { status: 200 });
        }
        if (url === "/api/viewport-diag") lines.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      })
    );
    return { eligibility, direct, lines };
  }

  it("« Tout enchaîner » : chaque essai demandé dans l'ordre et envoyé, même refusé, puis le tableau et le bilan", async () => {
    const { eligibility, direct, lines } = refusingServer();
    render(<LumenTest />);
    fireEvent.click(screen.getByText(/^Tout enchaîner/));
    const sendSummary = await screen.findByText("Envoyer le bilan", undefined, { timeout: 5000 });
    // Un verdict par essai, avec la découpe et la cible de l'essai serveur ; le lecteur actuel le demande aussi.
    const expected = SERIES.flatMap((t) => (t.prepareOnly ?? [t.cut]).map((cut) => `${t.itemId}:${cut}:${t.player === "serveur" && t.targetS !== 4 ? t.targetS : "-"}`));
    expect(eligibility.map((u) => `${u.split("/")[3]}:${new URL(u, "http://x").searchParams.get("cut")}:${new URL(u, "http://x").searchParams.get("target") ?? "-"}`)).toEqual(expected);
    expect(direct.map((u) => u.split("/")[4])).toEqual(SERIES.filter((t) => t.player === "actuel").map((t) => t.itemId));
    // Une ligne par essai, marquée de l'essai, de son rang, du lecteur et de la passe, refus compris.
    expect(lines.map((l) => (l.auto as { trial: string; rank: number }).trial)).toEqual(SERIES.map((t) => t.id));
    expect(lines.map((l) => (l.auto as { rank: number }).rank)).toEqual(SERIES.map((_, i) => i + 1));
    expect(lines.map((l) => (l.auto as { player: string }).player)).toEqual(SERIES.map((t) => t.player));
    expect(lines[0]).toMatchObject({ kind: "lumen-test", auto: { of: SERIES.length, status: "refusé", pass: "complète" }, runs: [{ trial: "maison-blanche-serveur", rank: 1, player: "serveur", cut: "cra", targetS: 4, verdict: { ok: false, reason: "son-codec" } }] });
    const firstCurrent = SERIES.findIndex((t) => t.player === "actuel");
    expect(lines[firstCurrent]).toMatchObject({ auto: { player: "actuel", status: "refusé" }, runs: [{ player: "actuel" }] });
    expect((lines[firstCurrent].runs as Record<string, unknown>[])[0]).not.toHaveProperty("cut");
    // Les positions des sauts se tirent de la même graine pour toute la série.
    expect(new Set(lines.map((l) => (l.auto as { seed: number }).seed)).size).toBe(1);
    expect(screen.getByText(/1\. À la Maison Blanche S03E01 · serveur — refusé : son-codec/)).toBeInTheDocument();
    expect(screen.getByText(/2\. À la Maison Blanche S03E01 · serveur 2 s — refusé/)).toBeInTheDocument();
    // Le tableau côte à côte.
    expect(screen.getByText("Lumen serveur", { selector: "th" })).toBeInTheDocument();
    expect(screen.getByText("Lecteur actuel", { selector: "th" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Oui")[0]);
    fireEvent.change(screen.getByLabelText(/Sur quel titre/), { target: { value: "Ghosted" } });
    fireEvent.click(screen.getByText("Je n'ai pas entendu"));
    fireEvent.click(sendSummary);
    await screen.findByText(/Bilan envoyé/);
    const summary = lines.at(-1)!;
    expect(summary).toMatchObject({ kind: "lumen-test", auto: { summary: true, of: SERIES.length, done: SERIES.length, stopped: false, pass: "complète" }, answers: { damaged: "oui", damagedTitle: "Ghosted", audioClean: "pas-entendu" } });
    expect((summary.trials as { trial: string }[]).map((t) => t.trial)).toEqual(SERIES.map((t) => t.id));
    expect((summary.comparison as { key: string }[]).length).toBeGreaterThan(0);
  });

  it("« Comparatif rapide » : sa propre série, chaque ligne marquée `pass: \"courte\"`", async () => {
    const { lines } = refusingServer();
    render(<LumenTest />);
    fireEvent.click(screen.getByText(/^Comparatif rapide/));
    await screen.findByText("Envoyer le bilan", undefined, { timeout: 5000 });
    expect(lines.map((l) => (l.auto as { trial: string }).trial)).toEqual(QUICK_SERIES.map((t) => t.id));
    expect(lines.every((l) => (l.auto as { pass: string }).pass === "courte")).toBe(true);
  });
});
