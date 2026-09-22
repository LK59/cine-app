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
