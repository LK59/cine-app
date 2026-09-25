// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

/**
 * Ce que la fiche prépare pour « Lire » : la description du fichier et l'état du spectateur,
 * demandés à l'ouverture de la fiche plutôt qu'à l'appui.
 *
 * Ce qui compte ici n'est pas la vitesse — c'est de ne jamais servir une position périmée. Une
 * réponse gardée trop longtemps, ou gardée à travers une lecture du même titre, ferait reprendre
 * un film là où il en était *avant* qu'on le regarde.
 */

let legacy: boolean | undefined = false;
let serverFallback: boolean | undefined = true;
let enabled = true;
vi.mock("@/lib/usePlayerEnabled", () => ({
  usePlayerEnabled: () => enabled,
  usePlayerEnabledState: () => enabled,
  usePlayerServerFallback: () => serverFallback,
}));
vi.mock("@/lib/useLegacyPlayer", () => ({ useLegacyPlayer: () => ({ legacy }) }));

import {
  prefetchPlaybackState,
  takePrefetchedPlaybackState,
  forgetPrefetchedPlaybackState,
  directInfoKey,
  PLAYBACK_STATE_FRESH_MS,
} from "@/lib/playbackPrefetch";
import { usePlaybackPrefetch } from "@/lib/usePlaybackPrefetch";
import { refreshAfterPlayback, revalidateWatchState } from "@/lib/swr";
import { markFileMissing, useFileMissing } from "@/lib/missingFiles";

let resumeSeconds = 0;
const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith("/api/jellyfin/playback-state/")) {
    return { ok: true, json: async () => ({ resumeSeconds, preferences: null }) };
  }
  return { ok: true, json: async () => ({ streamUrl: "/s.mkv", sizeBytes: 1 }) };
});
const calls = (prefix: string) => fetchMock.mock.calls.filter(([url]) => url.startsWith(prefix)).length;

beforeEach(() => {
  forgetPrefetchedPlaybackState();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  resumeSeconds = 0;
  legacy = false;
  serverFallback = true;
  enabled = true;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("l'état du spectateur demandé d'avance", () => {
  it("sert la réponse de la fiche quand elle est fraîche, sans reposer la question", async () => {
    resumeSeconds = 1200;
    prefetchPlaybackState("film");
    // Deux ouvertures de fiche coup sur coup : une seule question.
    prefetchPlaybackState("film");
    expect(calls("/api/jellyfin/playback-state/")).toBe(1);
    const taken = takePrefetchedPlaybackState("film");
    expect(await taken).toMatchObject({ resumeSeconds: 1200 });
    expect(calls("/api/jellyfin/playback-state/")).toBe(1);
  });

  it("ne sert qu'une fois : une seconde lecture du même titre relit sa position", () => {
    prefetchPlaybackState("film");
    expect(takePrefetchedPlaybackState("film")).not.toBeNull();
    expect(takePrefetchedPlaybackState("film")).toBeNull();
  });

  it("ne sert plus rien au-delà de trente secondes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    prefetchPlaybackState("film");
    vi.setSystemTime(Date.now() + PLAYBACK_STATE_FRESH_MS);
    expect(takePrefetchedPlaybackState("film")).toBeNull();
    // Et une fiche rouverte après ce délai redemande.
    prefetchPlaybackState("film");
    expect(calls("/api/jellyfin/playback-state/")).toBe(2);
  });

  it("redemande quand la réponse d'avance était vide", async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => null }) as never);
    prefetchPlaybackState("film");
    resumeSeconds = 300;
    expect(await takePrefetchedPlaybackState("film")).toMatchObject({ resumeSeconds: 300 });
    expect(calls("/api/jellyfin/playback-state/")).toBe(2);
  });

  it("n'attend pas plus que la garde de huit secondes quand la demande d'avance est restée muette", async () => {
    // Chasse aux bugs du 22/09/2026 : une demande d'avance suspendue épuisait ses huit secondes,
    // puis la question reposée en attendait huit autres — jusqu'à seize secondes de roue au lieu
    // de la garde de huit.
    vi.useFakeTimers();
    // Le délai d'AbortSignal.timeout ne suit pas les horloges simulées : le même, sur elles.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("délai", "TimeoutError")), ms);
      return controller.signal;
    });
    // Un serveur qui ne répond jamais : seul le délai termine la demande.
    const silent = (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))) as never;
    fetchMock.mockImplementationOnce(silent).mockImplementationOnce(silent);
    prefetchPlaybackState("film");
    await vi.advanceTimersByTimeAsync(1000);
    let settled = false;
    const taken = takePrefetchedPlaybackState("film")!.then((state) => {
      settled = true;
      return state;
    });
    // Huit secondes après l'appui sur Lire, c'est fini — la demande d'avance comprise.
    await vi.advanceTimersByTimeAsync(8000);
    expect(settled).toBe(true);
    expect(await taken).toBeNull();
    vi.restoreAllMocks();
  });

  it("est oubliée dès qu'une lecture se ferme, et de nouveau quand son arrêt est enregistré", async () => {
    prefetchPlaybackState("film");
    let reported!: () => void;
    const done = refreshAfterPlayback(new Promise<void>((resolve) => (reported = resolve)), "film");
    expect(takePrefetchedPlaybackState("film")).toBeNull();
    // Une fiche rouverte pendant que l'arrêt est encore en route lit la position d'avant.
    prefetchPlaybackState("film");
    reported();
    await done;
    expect(takePrefetchedPlaybackState("film")).toBeNull();
  });

  it("est oubliée quand « vu » change à la main", async () => {
    prefetchPlaybackState("film");
    await revalidateWatchState("film");
    expect(takePrefetchedPlaybackState("film")).toBeNull();
  });
});

function Sheet({ itemId }: { itemId: string | null | undefined }) {
  usePlaybackPrefetch(itemId);
  return null;
}

describe("usePlaybackPrefetch", () => {
  it("demande la description du fichier et l'état du spectateur à l'ouverture de la fiche", async () => {
    render(<Sheet itemId="film-a" />);
    await waitFor(() => expect(calls(directInfoKey("film-a"))).toBe(1));
    expect(calls("/api/jellyfin/playback-state/film-a")).toBe(1);
    expect(takePrefetchedPlaybackState("film-a")).not.toBeNull();
  });

  it("ne demande rien pour un compte qui lit par le serveur, ni tant qu'on ne le sait pas", async () => {
    legacy = true;
    const { rerender } = render(<Sheet itemId="film-b" />);
    legacy = undefined;
    rerender(<Sheet itemId="film-b" />);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prépare quand même le lecteur natif d'une installation sans lecteur serveur", async () => {
    legacy = true;
    serverFallback = false;
    render(<Sheet itemId="film-c" />);
    await waitFor(() => expect(calls(directInfoKey("film-c"))).toBe(1));
  });

  it("ne demande rien sans titre à lancer, ni quand la lecture est fermée", async () => {
    render(<Sheet itemId={undefined} />);
    enabled = false;
    render(<Sheet itemId="film-d" />);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Le bouton Lire grisé (25/09/2026) : seulement quand Jellyfin a répondu que le fichier n'existe
 * plus. Un réseau coupé, un Jellyfin absent ou un jeton refusé ne grisent jamais un titre lisible.
 */
describe("usePlaybackPrefetch — fichier manquant", () => {
  // `mockReset` rend l'implémentation d'origine : celles posées ici ne débordent pas ailleurs.
  afterEach(() => fetchMock.mockReset());
  function Missing({ itemId }: { itemId: string }) {
    usePlaybackPrefetch(itemId);
    return <span data-testid="missing">{String(useFileMissing(itemId))}</span>;
  }
  const answer = (status: number, body: unknown) => async (url: string) =>
    url.startsWith("/api/jellyfin/playback-state/")
      ? { ok: true, json: async () => ({ resumeSeconds: 0, preferences: null }) }
      : { ok: false, status, headers: new Headers(), json: async () => body };

  it("grise sur la réponse `file_missing` de la route", async () => {
    fetchMock.mockImplementation(answer(404, { error: "Fichier introuvable côté Jellyfin", code: "file_missing" }) as never);
    const { getByTestId } = render(<Missing itemId="perdu-1" />);
    await waitFor(() => expect(getByTestId("missing").textContent).toBe("true"));
  });

  it.each([
    ["un 404 sans code (Jellyfin injoignable)", 404, { error: "Fichier introuvable côté Jellyfin" }],
    ["une panne du serveur", 502, { error: "Bad gateway" }],
    ["un jeton refusé", 401, { error: "Unauthorized" }],
  ])("ne grise pas sur %s", async (_label, status, body) => {
    fetchMock.mockImplementation(answer(status, body) as never);
    const itemId = `lisible-${status}-${Object.keys(body).length}`;
    const { getByTestId } = render(<Missing itemId={itemId} />);
    await waitFor(() => expect(calls(directInfoKey(itemId))).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(getByTestId("missing").textContent).toBe("false");
  });

  it("ne grise pas sur une coupure réseau", async () => {
    fetchMock.mockImplementation((async (url: string) => {
      if (url.startsWith("/api/jellyfin/playback-state/")) return { ok: true, json: async () => ({ resumeSeconds: 0 }) };
      throw new TypeError("Load failed");
    }) as never);
    const { getByTestId } = render(<Missing itemId="coupure" />);
    await waitFor(() => expect(calls(directInfoKey("coupure"))).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(getByTestId("missing").textContent).toBe("false");
  });

  it("efface la marque quand le fichier répond de nouveau", async () => {
    markFileMissing("retrouve");
    const { getByTestId } = render(<Missing itemId="retrouve" />);
    await waitFor(() => expect(getByTestId("missing").textContent).toBe("false"));
  });
});
