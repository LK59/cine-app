// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, within } from "@testing-library/react";
import { useRef, type RefObject } from "react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

import { PlayerControls } from "@/components/PlayerControls";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noop = () => {};

function Harness(props: Partial<React.ComponentProps<typeof PlayerControls>> & { onVideoRef?: (v: HTMLVideoElement) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef}>
      <video
        ref={(el) => {
          videoRef.current = el;
          if (el && props.onVideoRef) props.onVideoRef(el);
        }}
      />
      <PlayerControls
        videoRef={videoRef as RefObject<HTMLVideoElement | null>}
        containerRef={containerRef}
        itemId="item-1"
        title="Un titre"
        onClose={noop}
        onMinimize={noop}
        onTogglePlaybackInfo={noop}
        audioTracks={[]}
        currentAudioId={null}
        onChangeAudio={noop}
        subtitleTracks={[]}
        currentSubtitleId={null}
        onChangeSubtitle={noop}
        hidden={false}
        loading={false}
        introSkip={null}
        creditsStart={null}
        nextEpisode={null}
        onAdvance={noop}
        {...props}
      />
    </div>
  );
}

function stubMediaFetches() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
}

/** Un film de dix minutes, à 100 s, dont la position est assignable (jsdom ne l'est pas d'office). */
async function withPosition(video: HTMLVideoElement) {
  Object.defineProperty(video, "duration", { value: 600, configurable: true });
  Object.defineProperty(video, "currentTime", { value: 100, writable: true, configurable: true });
  await act(async () => void video.dispatchEvent(new Event("durationchange")));
  await act(async () => void video.dispatchEvent(new Event("timeupdate")));
}

describe("PlayerControls — le clavier, barre de progression focalisée", () => {
  it("→ sur la barre focalisée avance de dix secondes, et le relâchement ne ramène pas en arrière", async () => {
    // Après un clic sur la barre (elle garde le focus — seuls les boutons le rendent), → passait
    // bien par le saut du lecteur (+10 s), mais l'`onKeyUp` de l'input validait ensuite sa propre
    // valeur — l'ancienne position, le tic de la position étant suspendu entre l'appui et le
    // relâchement : la flèche ne faisait rien, ou ramenait le film d'où il venait.
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await withPosition(video!);
    const seek = container.querySelector<HTMLInputElement>('[data-player-nav="seek"]')!;
    seek.focus();

    await act(async () => void fireEvent.keyDown(seek, { key: "ArrowRight", code: "ArrowRight" }));
    expect(video!.currentTime).toBeCloseTo(110, 1);
    await act(async () => void fireEvent.keyUp(seek, { key: "ArrowRight", code: "ArrowRight" }));
    expect(video!.currentTime).toBeCloseTo(110, 1);
  });

  it("← sur la barre focalisée recule de dix secondes et y reste", async () => {
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await withPosition(video!);
    const seek = container.querySelector<HTMLInputElement>('[data-player-nav="seek"]')!;
    seek.focus();

    await act(async () => void fireEvent.keyDown(seek, { key: "ArrowLeft", code: "ArrowLeft" }));
    await act(async () => void fireEvent.keyUp(seek, { key: "ArrowLeft", code: "ArrowLeft" }));
    expect(video!.currentTime).toBeCloseTo(90, 1);
  });
});

describe("PlayerControls — l'épisode suivant, demandé deux fois de suite", () => {
  it("un double appui sur « Épisode suivant » n'enjambe pas un épisode", async () => {
    // Le lecteur serveur enchaîne les épisodes sans remonter ses commandes : le premier appui passe à
    // l'épisode 2, le rendu qui suit propose déjà l'épisode 3 sous le même bouton, et le second appui
    // — un double-tap, ou un appui de plus parce que rien ne bougeait encore sur une connexion lente —
    // y allait : l'épisode 2 n'était jamais vu.
    stubMediaFetches();
    const onAdvance = vi.fn();
    const { rerender, container } = render(
      <Harness itemId="ep1" nextEpisode={{ itemId: "ep2", title: "Épisode 2" }} onAdvance={onAdvance} />
    );
    await act(async () => void fireEvent.click(container.querySelector('[data-player-nav="next-episode"]')!));
    rerender(<Harness itemId="ep2" nextEpisode={{ itemId: "ep3", title: "Épisode 3" }} onAdvance={onAdvance} loading />);
    await act(async () => void fireEvent.click(container.querySelector('[data-player-nav="next-episode"]')!));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});

describe("PlayerControls — la carte de l'épisode suivant", () => {
  it("nomme sa croix, qui n'est qu'une icône", async () => {
    // Sans nom, un lecteur d'écran annonçait « bouton » à côté de « Lire maintenant » : rien ne disait
    // que celui-ci écartait la carte.
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const { getByText } = render(
      <Harness creditsStart={50} nextEpisode={{ itemId: "ep2", title: "Épisode 2" }} onVideoRef={(v) => (video = v)} />
    );
    await withPosition(video!);
    const card = getByText("Épisode 2").parentElement!;
    expect(within(card).getByRole("button", { name: "common.close" })).toBeTruthy();
  });
});

describe("PlayerControls — le clavier, commandes cachées par un écran d'erreur", () => {
  it("Espace ne relance pas le film sous l'écran d'erreur (`hidden`)", async () => {
    // Le lecteur serveur cache ses commandes derrière son écran d'erreur (`hidden`) mais garde
    // l'élément monté pour « Réessayer » : l'écouteur clavier, posé sur la fenêtre, restait actif.
    // Espace lançait l'élément en panne sous l'écran — et, retenu au `keydown`, n'activait plus le
    // bouton « Réessayer » qui avait le focus.
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    render(<Harness hidden onVideoRef={(v) => (video = v)} />);
    const play = vi.spyOn(video!, "play").mockResolvedValue(undefined);
    Object.defineProperty(video!, "paused", { value: true, configurable: true });

    const event = new KeyboardEvent("keydown", { key: " ", code: "Space", cancelable: true });
    await act(async () => void window.dispatchEvent(event));
    expect(play).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("un menu ouvert quand l'erreur survient n'est plus ouvert après « Réessayer »", async () => {
    // Cachées par l'écran d'erreur, les commandes restent montées (le lecteur serveur garde l'élément
    // pour « Réessayer ») et gardaient leur menu : le nouvel essai les rendait avec le menu « ⋮ »
    // ouvert par-dessus le film qui repart — et, menu ouvert, elles ne se cachaient plus jamais.
    stubMediaFetches();
    const { rerender, container } = render(<Harness />);
    await act(async () => void fireEvent.click(container.querySelector('[data-player-nav="more"]')!));
    expect(container.querySelector('[data-quality-row]')).not.toBeNull();

    rerender(<Harness hidden />);
    rerender(<Harness hidden={false} />);
    expect(container.querySelector('[data-quality-row]')).toBeNull();
  });

  it("les flèches ne déplacent pas la position sous l'écran d'erreur", async () => {
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    render(<Harness hidden onVideoRef={(v) => (video = v)} />);
    await withPosition(video!);
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight" })));
    expect(video!.currentTime).toBe(100);
  });
});
