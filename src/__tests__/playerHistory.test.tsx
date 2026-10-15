// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";

/**
 * Retour ferme le lecteur (passe de nuit du 15/10/2026, LECTEUR-11 ; décision de Louis le 15/10 au
 * matin). Le vrai `PlaybackProvider`, le vrai historique de jsdom, et un lecteur réduit à sa croix :
 * `close()` qui écrit son bilan, puis ferme la séance après son fondu — ce que font les trois lecteurs.
 */

vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
vi.mock("@/lib/unsentStop", () => ({ flushOrphanStops: async () => {} }));
vi.mock("@/lib/unsentLines", () => ({ flushUnsentLines: async () => {} }));
vi.mock("@/lib/unsentPosition", () => ({ flushUnsentPositions: async () => {}, unsentPositionsPending: () => false }));
vi.mock("@/lib/catalogueOutage", () => ({ playBlockedByOutage: () => false }));

import { PlaybackProvider, usePlayback, PLAYER_RELOAD_INTENT_KEY, type PlaybackSession } from "@/components/PlaybackProvider";
import { PLAYER_HISTORY_KEY, usePlayerBackClose, __resetPlayerHistoryForTests, __livePlayerEntry } from "@/lib/playerHistory";
import { cinemaNavigate } from "@/lib/cinemaRoute";

type Api = ReturnType<typeof usePlayback>;
let api!: Api;
const stops: { why: string; openId?: number }[] = [];

/** Un lecteur : sa croix écrit son bilan une fois, puis ferme la séance après 30 ms de fondu. */
function FakePlayer() {
  const playback = usePlayback();
  const closed = useRef(false);
  const session = playback.session;
  const handleClose = () => {
    if (closed.current || !session) return;
    closed.current = true;
    stops.push({ why: "close", openId: session.openId });
    const openId = session.openId;
    setTimeout(() => playback.close(openId), 30);
  };
  usePlayerBackClose(handleClose);
  return <button onClick={handleClose}>croix</button>;
}

function Probe() {
  const playback = usePlayback();
  useEffect(() => {
    api = playback;
  });
  return playback.session ? <FakePlayer key={playback.session.openId} /> : null;
}

function mount() {
  return render(
    <PlaybackProvider>
      <Probe />
    </PlaybackProvider>
  );
}

const token = () => (window.history.state as Record<string, unknown> | null)?.[PLAYER_HISTORY_KEY];
const back = async () => {
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 20));
  });
};
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 80))));
const film: PlaybackSession = { itemId: "film", title: "Film", resumeAt: 0 };

beforeEach(() => {
  __resetPlayerHistoryForTests();
  stops.length = 0;
  sessionStorage.clear();
  // Une fiche ouverte au-dessus de l'accueil : l'écran sous le film.
  window.history.replaceState(null, "", "/");
  cinemaNavigate({ film: 104 });
});
afterEach(() => {
  cleanup();
});

describe("Retour ferme le lecteur", () => {
  it("le lecteur empile une entrée ; Retour le ferme comme la croix, la fiche dessous intacte", async () => {
    mount();
    const before = window.history.length;
    act(() => api.play(film));
    expect(window.history.length).toBe(before + 1);
    expect(typeof token()).toBe("string");
    expect(window.location.hash).toBe("#film=104");

    await back();
    await settle();
    expect(stops.map((s) => s.why)).toEqual(["close"]);
    expect(api.session).toBeNull();
    expect(window.location.hash).toBe("#film=104");
    expect(token()).toBeUndefined();
  });

  it("la croix rend l'entrée : le Retour suivant ferme la fiche, pas l'application", async () => {
    const { getByText } = mount();
    act(() => api.play(film));
    act(() => getByText("croix").click());
    await settle();
    expect(api.session).toBeNull();
    expect(token()).toBeUndefined();
    expect(window.location.hash).toBe("#film=104");
    await back();
    expect(window.location.hash).toBe("");
    expect(stops).toHaveLength(1);
  });

  it("mini-lecteur : réduit, il n'a plus d'entrée — Retour referme la fiche et laisse jouer ; agrandi, il la reprend", async () => {
    mount();
    act(() => api.play(film));
    act(() => api.minimize());
    await settle();
    expect(token()).toBeUndefined();
    expect(window.location.hash).toBe("#film=104");
    await back();
    expect(window.location.hash).toBe("");
    expect(api.session).not.toBeNull();
    expect(api.mode).toBe("mini");
    expect(stops).toHaveLength(0);

    act(() => api.expand());
    expect(typeof token()).toBe("string");
    await back();
    await settle();
    expect(stops).toHaveLength(1);
    expect(api.session).toBeNull();
  });

  it("épisode suivant : pas une entrée par épisode", async () => {
    mount();
    act(() => api.play({ itemId: "ep-1", title: "Épisode 1", resumeAt: 0 }));
    const after = window.history.length;
    act(() => api.advance({ itemId: "ep-2", title: "Épisode 2" }));
    act(() => api.advance({ itemId: "ep-3", title: "Épisode 3" }));
    expect(window.history.length).toBe(after);
    await back();
    await settle();
    expect(api.session).toBeNull();
    expect(window.location.hash).toBe("#film=104");
  });

  it("un film qui en remplace un autre (la suite d'une saga) réécrit l'entrée au lieu d'en empiler une", async () => {
    mount();
    act(() => api.play(film));
    const after = window.history.length;
    act(() => api.play({ itemId: "suite", title: "La suite", resumeAt: 0 }));
    expect(window.history.length).toBe(after);
    await back();
    await settle();
    expect(api.session).toBeNull();
    expect(window.location.hash).toBe("#film=104");
  });

  it("fin de film (le lecteur se ferme de lui-même) : l'entrée est rendue, le Retour suivant ferme la fiche", async () => {
    mount();
    act(() => api.play(film));
    const openId = api.session!.openId;
    act(() => api.close(openId));
    await settle();
    expect(token()).toBeUndefined();
    expect(window.location.hash).toBe("#film=104");
    await back();
    expect(window.location.hash).toBe("");
    expect(stops).toHaveLength(0);
  });

  it("une scène (réplique) se ferme au Retour comme un film", async () => {
    mount();
    act(() => api.play({ ...film, scene: true, resumeAt: 3600 }));
    await back();
    await settle();
    expect(stops.map((s) => s.why)).toEqual(["close"]);
    expect(api.session).toBeNull();
  });

  it("Retour pendant le fondu de la croix : un seul bilan, et l'historique reste juste", async () => {
    const { getByText } = mount();
    act(() => api.play(film));
    act(() => getByText("croix").click());
    await back(); // dans les 30 ms du fondu
    await settle();
    expect(stops).toHaveLength(1);
    expect(api.session).toBeNull();
    expect(window.location.hash).toBe("#film=104");
    expect(token()).toBeUndefined();
  });

  it("double Retour rapide : le premier ferme le lecteur, le second la fiche", async () => {
    mount();
    act(() => api.play(film));
    // Deux appuis, deux événements : le second tombe pendant le fondu du lecteur (30 ms ici).
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 5));
      window.history.back();
      await new Promise((r) => setTimeout(r, 40));
    });
    await settle();
    expect(stops).toHaveLength(1);
    expect(api.session).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("un titre ouvert depuis l'écran de fin : la fermeture du lecteur ne referme pas la fiche qui vient de s'ouvrir", async () => {
    const { getByText } = mount();
    act(() => api.play(film));
    act(() => {
      getByText("croix").click();
      cinemaNavigate({ film: 205 });
    });
    await settle();
    expect(api.session).toBeNull();
    expect(window.location.hash).toBe("#film=205");
    // L'entrée du lecteur, restée dessous, est sautée : un Retour ramène à la fiche d'avant le film.
    await back();
    await settle();
    expect(window.location.hash).toBe("#film=104");
    expect(token()).toBeUndefined();
  });
});

describe("Retour ferme le lecteur — pages rechargées", () => {
  it("rechargée pour rouvrir le lecteur (WebKit : piste, relais) : l'entrée gardée est reprise, pas doublée", async () => {
    // La page d'avant avait empilé son entrée ; le rechargement la garde, avec son jeton.
    window.history.pushState({ ...window.history.state, [PLAYER_HISTORY_KEY]: "ancienne-page:3" }, "", window.location.href);
    sessionStorage.setItem(PLAYER_RELOAD_INTENT_KEY, JSON.stringify({ itemId: "film", title: "Film", resumeAt: 1200, attempt: 1, server: true }));
    const before = window.history.length;
    mount();
    await settle();
    expect(api.session?.itemId).toBe("film");
    expect(window.history.length).toBe(before);
    expect(token()).not.toBe("ancienne-page:3");
    expect(__livePlayerEntry()).toBe(token());
    await back();
    await settle();
    expect(stops).toHaveLength(1);
    expect(window.location.hash).toBe("#film=104");
  });

  it("rechargée autrement (F5 en plein film) : l'entrée orpheline perd son jeton, le film suivant empile la sienne", async () => {
    window.history.pushState({ ...window.history.state, [PLAYER_HISTORY_KEY]: "ancienne-page:1" }, "", window.location.href);
    mount();
    await settle();
    expect(api.session).toBeNull();
    expect(token()).toBeUndefined();
    const before = window.history.length;
    act(() => api.play(film));
    expect(window.history.length).toBe(before + 1);
    await back();
    await settle();
    expect(api.session).toBeNull();
  });

  it("une entrée de lecteur retrouvée par Suivant, sans lecteur : sautée", async () => {
    const { getByText } = mount();
    act(() => api.play(film));
    act(() => getByText("croix").click());
    await settle();
    await act(async () => {
      window.history.forward();
      await new Promise((r) => setTimeout(r, 40));
    });
    await settle();
    expect(token()).toBeUndefined();
    expect(window.location.hash).toBe("#film=104");
    expect(api.session).toBeNull();
  });
});
