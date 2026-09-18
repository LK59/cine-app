// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStableFallback, takeoverFor, NEGOTIATING_MS } from "@/lib/useStableFallback";

// The handover itself, apart from the two players it sits between. What matters is that it
// happens without asking, says so once, and leaves an account of why.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useStableFallback", () => {
  it("cède la main sans rien demander, et retient pourquoi", () => {
    const { result } = renderHook(() => useStableFallback());
    expect(result.current.handedOver).toEqual([]);
    expect(result.current.negotiating).toBe(false);

    act(() => result.current.stepAside("film-1", "le navigateur a refusé une opération sur le tampon"));

    expect(result.current.handedOver).toEqual(["film-1"]);
    expect(result.current.negotiating).toBe(true);
    // The viewer is told nothing of this; the panel of the player taking over is.
    expect(result.current.reason).toContain("refusé une opération");
  });

  it("retire le mot tout seul, sans rien à fermer", () => {
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "raison"));
    expect(result.current.negotiating).toBe(true);

    act(() => void vi.advanceTimersByTime(NEGOTIATING_MS + 10));
    expect(result.current.negotiating).toBe(false);
    // The reason outlives the word: it is what the panel shows long afterwards.
    expect(result.current.reason).toBe("raison");
  });

  it("ne redit pas le mot pour un film déjà cédé", () => {
    // The failing path can report more than once on its way down. Saying it twice would
    // interrupt a player that is by then busy playing.
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "première raison"));
    act(() => void vi.advanceTimersByTime(NEGOTIATING_MS + 10));
    act(() => result.current.stepAside("film-1", "deuxième raison"));

    expect(result.current.negotiating).toBe(false);
    expect(result.current.reason).toBe("première raison");
    expect(result.current.handedOver).toEqual(["film-1"]);
  });

  it("porte la position et la piste quand la main est cédée en cours de lecture", () => {
    // Un repli au démarrage n'a rien à transmettre. Celui-ci part de quarante minutes de film et
    // d'une piste que le spectateur vient de demander : sans ces deux valeurs, le lecteur qui
    // reprend rouvrirait au début et dans la langue qu'on essayait justement de quitter.
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "piste A_TRUEHD", { resumeAt: 2400, audioStreamIndex: 2 }));

    expect(result.current.takeover).toEqual({ resumeAt: 2400, audioStreamIndex: 2 });
  });

  it("n'a rien à transmettre pour un repli au démarrage", () => {
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "raison"));
    expect(result.current.takeover).toBeNull();
  });

  it("ne fait pas hériter un film du relais du précédent", () => {
    // Une position de 2400 s appliquée au film suivant le ferait ouvrir quarante minutes trop
    // loin — ou après la fin, pour un épisode plus court.
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "raison", { resumeAt: 2400, audioStreamIndex: 2 }));
    act(() => result.current.stepAside("film-2", "autre raison"));

    expect(result.current.takeover).toBeNull();
  });

  it("ne condamne qu'un film à la fois", () => {
    // One file the experimental player cannot carry says nothing about the next, so the next
    // still gets the good path.
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "raison"));
    expect(result.current.handedOver).not.toContain("film-2");

    act(() => result.current.stepAside("film-2", "autre raison"));
    expect(result.current.handedOver).toEqual(["film-1", "film-2"]);
    expect(result.current.negotiating).toBe(true);
  });
});

describe("takeoverFor", () => {
  const session = { itemId: "film-1" };

  it("rend le relais à la lecture qui l'a produit", () => {
    const takeover = { resumeAt: 2400, audioStreamIndex: 2, owner: session };
    expect(takeoverFor(takeover, session)).toBe(takeover);
  });

  it("ne le rend pas à une lecture ouverte plus tard sur le même film", () => {
    // `handedOver` est gardé pour toute la session de l'application, donc rouvrir ce film revient
    // droit au lecteur serveur. Sans cette règle il y retrouvait une position vieille de quarante
    // minutes et écrasait le `resumeAt` demandé : « Recommencer depuis le début » repartait au
    // milieu. `PlaybackProvider` recrée l'objet de séance à chaque `play`, l'identité suffit donc.
    const takeover = { resumeAt: 2400, audioStreamIndex: 2, owner: session };
    const replayed = { itemId: "film-1" };
    expect(takeoverFor(takeover, replayed)).toBeNull();
  });

  it("ne le fait pas non plus hériter à l'épisode suivant", () => {
    // `advance` recrée lui aussi l'objet : un épisode ne reprend pas où finissait le précédent.
    const takeover = { resumeAt: 2400, owner: session };
    expect(takeoverFor(takeover, { ...session, itemId: "episode-2" })).toBeNull();
  });

  it("ne rend rien quand il n'y a pas eu de repli", () => {
    expect(takeoverFor(null, session)).toBeNull();
    expect(takeoverFor(undefined, session)).toBeNull();
  });
});

describe("le retour après une diffusion", () => {
  // Une bascule pour diffuser n'est pas un échec : le lecteur natif marchait très bien, on l'a
  // quitté parce qu'un flux MediaSource ne se diffuse pas. Lui seul autorise donc le retour.
  it("rend la main, à la position où la diffusion s'est arrêtée", () => {
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "diffusion demandée", { resumeAt: 120, cast: true }));
    expect(result.current.handedOver).toEqual(["film-1"]);

    act(() => result.current.stepBack("film-1", 4200));

    expect(result.current.handedOver).toEqual([]);
    expect(result.current.returning).toEqual({ itemId: "film-1", resumeAt: 4200 });
    // Le relais est consommé : il ne doit pas resservir au montage suivant.
    expect(result.current.takeover).toBeNull();
  });

  it("ne rend pas la main après un échec", () => {
    // Y revenir rejouerait l'échec, puis rebasculerait, en boucle. C'est la raison d'être de la
    // distinction, et elle vit dans le hook et non chez l'appelant.
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "le tampon a été refusé", { resumeAt: 120 }));

    act(() => result.current.stepBack("film-1", 4200));

    expect(result.current.handedOver).toEqual(["film-1"]);
    expect(result.current.returning).toBeNull();
  });

  it("n'a rien à rendre quand rien n'a été cédé", () => {
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepBack("film-1", 4200));
    expect(result.current.returning).toBeNull();
    expect(result.current.handedOver).toEqual([]);
  });

  it("annule un retour en attente si l'on rebascule", () => {
    // Diffuser, revenir, rediffuser : la seconde bascule ne doit pas laisser traîner la position
    // de la première, qui ferait rouvrir le film au mauvais endroit.
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "diffusion", { resumeAt: 0, cast: true }));
    act(() => result.current.stepBack("film-1", 4200));
    act(() => result.current.stepAside("film-1", "diffusion", { resumeAt: 4200, cast: true }));

    expect(result.current.returning).toBeNull();
    expect(result.current.handedOver).toEqual(["film-1"]);
  });
});
