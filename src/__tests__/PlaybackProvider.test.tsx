// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PlaybackProvider,
  usePlayback,
  PLAYER_RELOAD_INTENT_KEY,
} from "@/components/PlaybackProvider";

function wrapper({ children }: { children: ReactNode }) {
  return <PlaybackProvider>{children}</PlaybackProvider>;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("PlaybackProvider / usePlayback", () => {
  it("starts closed, with no session", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    expect(result.current.mode).toBe("closed");
    expect(result.current.session).toBeNull();
  });

  it("play() opens the session in full mode", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });

    act(() => result.current.play({ itemId: "1", title: "Movie A" }));

    expect(result.current.mode).toBe("full");
    expect(result.current.session).toEqual({ itemId: "1", title: "Movie A", openId: expect.any(Number) });
  });

  it("minimize()/expand() switch mode without touching the session", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    act(() => result.current.play({ itemId: "1", title: "Movie A", resumeAt: 42 }));

    act(() => result.current.minimize());
    expect(result.current.mode).toBe("mini");
    expect(result.current.session?.itemId).toBe("1");

    act(() => result.current.expand());
    expect(result.current.mode).toBe("full");
    expect(result.current.session?.itemId).toBe("1");
  });

  it("close() clears both the mode and the session", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    act(() => result.current.play({ itemId: "1", title: "Movie A" }));

    act(() => result.current.close());

    expect(result.current.mode).toBe("closed");
    expect(result.current.session).toBeNull();
  });

  // « Remis à zéro » veut désormais dire zéro, et non « pas d'avis ». Le champ était laissé
  // absent, ce que le lecteur natif lit comme « prends la position dont le serveur se souvient » —
  // l'épisode suivant repartait donc à sa propre reprise, alors qu'un enchaînement commence au
  // début. Voir PlaybackSession.
  it("advance() swaps to the next episode, starts it at zero, and preserves other session fields", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    const getNextEpisode = () => null;
    act(() =>
      result.current.play({ itemId: "ep1", title: "Episode 1", resumeAt: 120, getNextEpisode })
    );

    act(() => result.current.advance({ itemId: "ep2", title: "Episode 2" }));

    expect(result.current.session?.itemId).toBe("ep2");
    expect(result.current.session?.title).toBe("Episode 2");
    expect(result.current.session?.resumeAt).toBe(0);
    expect(result.current.session?.getNextEpisode).toBe(getNextEpisode);
  });

  it("advance() is a no-op when there is no active session", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });

    act(() => result.current.advance({ itemId: "ep2", title: "Episode 2" }));

    expect(result.current.session).toBeNull();
  });

  it("usePlayback() throws outside a PlaybackProvider", () => {
    expect(() => renderHook(() => usePlayback())).toThrow(
      "usePlayback must be used within a PlaybackProvider"
    );
  });

  it("resumes a pending WebKit reload intent found in sessionStorage on mount, then clears it", () => {
    sessionStorage.setItem(
      PLAYER_RELOAD_INTENT_KEY,
      JSON.stringify({ itemId: "ep3", title: "Episode 3", audioStreamIndex: 2, resumeAt: 30, attempt: 1 })
    );

    const { result } = renderHook(() => usePlayback(), { wrapper });

    expect(result.current.mode).toBe("full");
    expect(result.current.session).toMatchObject({
      itemId: "ep3",
      title: "Episode 3",
      resumeAt: 30,
      initialAudioStreamIndex: 2,
      fromReload: true,
      reloadAttempt: 1,
    });
    expect(sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY)).toBeNull();
  });

  it("ignores a malformed reload intent instead of crashing", () => {
    sessionStorage.setItem(PLAYER_RELOAD_INTENT_KEY, "{not json");

    const { result } = renderHook(() => usePlayback(), { wrapper });

    expect(result.current.mode).toBe("closed");
    expect(result.current.session).toBeNull();
  });
});

/**
 * Une fermeture ne vaut que pour la lecture qui l'a demandée.
 *
 * Le lecteur se ferme deux cents millisecondes après le geste, le temps de son fondu. Un film
 * lancé pendant ce délai — « Lire » sur une autre fiche, l'épisode suivant — était refermé par la
 * fermeture de l'ancien, et l'écran revenait à la fiche sans rien jouer (relevé le 23/09/2026).
 */
describe("PlaybackProvider — fermeture d'une lecture précise", () => {
  it("ignore la fermeture d'une lecture déjà remplacée", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    act(() => result.current.play({ itemId: "1", title: "Movie A" }));
    const first = result.current.session?.openId;

    act(() => result.current.play({ itemId: "2", title: "Movie B" }));
    act(() => result.current.close(first));

    expect(result.current.mode).toBe("full");
    expect(result.current.session?.itemId).toBe("2");
  });

  it("ferme la lecture en cours quand c'est bien elle", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    act(() => result.current.play({ itemId: "1", title: "Movie A" }));
    act(() => result.current.close(result.current.session?.openId));
    expect(result.current.mode).toBe("closed");
  });

  it("donne un nouveau numéro à chaque ouverture, même du même film", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    act(() => result.current.play({ itemId: "1", title: "Movie A" }));
    const first = result.current.session?.openId;
    act(() => result.current.play({ itemId: "1", title: "Movie A", resumeAt: 0 }));
    expect(result.current.session?.openId).not.toBe(first);
  });
});

/**
 * Au lancement, le bilan d'une séance qu'iOS a tuée en arrière-plan part enfin (23/09/2026).
 */
describe("PlaybackProvider — bilans restés sur l'appareil", () => {
  it("les envoie dès le lancement", async () => {
    localStorage.setItem(
      "cine:unsent-stop:abcd1234",
      JSON.stringify({ savedAt: Date.now() - 10 * 60_000, fields: { itemId: "x", session: "abcd1234" } })
    );
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // Un compte connecté : sans lui, rien ne part (26/09/2026, voir `findOrphanStops`). Posé par
    // l'hydratation, comme au lancement réel — `SWRProvider` le fait avant les écrans.
    const { hydrateFromDisk } = await import("@/lib/persistentCache");
    await hydrateFromDisk("louis", { has: () => true, set: () => {} }).catch(() => 0);
    renderHook(() => usePlayback(), { wrapper });
    await waitFor(() => expect(localStorage.getItem("cine:unsent-stop:abcd1234")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith("/api/player/log", expect.objectContaining({ method: "POST" }));
    vi.unstubAllGlobals();
  });
});
