// @vitest-environment jsdom
/**
 * Les décisions partagées des commandes du lecteur, éprouvées à l'écran (22/10/2026).
 *
 * `decisions-partagees.test.ts` vérifiait ces deux règles en lisant `PlayerControls.tsx` à son chemin
 * (`const showNextUp = … !sleepBlocksAdvance;`, `activeSkip(currentTime, introSkip, recapSkip)`) :
 * le découpage prévu des commandes aurait cassé le test sans casser la règle. Ce qu'elles font se
 * voit ici, quel que soit le fichier qui le porte ; la règle « un seul porteur » reste là-bas, lue
 * sur l'ensemble du lecteur.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { useRef, type RefObject } from "react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

import { PlayerControls } from "@/components/PlayerControls";
import { sleepTimerStore } from "@/lib/sleepTimer";

afterEach(() => {
  cleanup();
  sleepTimerStore.clear();
  vi.unstubAllGlobals();
});

const noop = () => {};

function Harness(props: Partial<React.ComponentProps<typeof PlayerControls>> & { onVideoRef: (v: HTMLVideoElement) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { onVideoRef, ...rest } = props;
  return (
    <div ref={containerRef}>
      <video
        ref={(el) => {
          videoRef.current = el;
          if (el) onVideoRef(el);
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
        {...rest}
      />
    </div>
  );
}

function monter(props: Partial<React.ComponentProps<typeof PlayerControls>>) {
  // Chapitres et vignettes : un 404 inoffensif.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
  let video!: HTMLVideoElement;
  render(<Harness {...props} onVideoRef={(v) => (video = v)} />);
  const aller = (t: number) => {
    Object.defineProperty(video, "currentTime", { value: t, writable: true, configurable: true });
    act(() => void video.dispatchEvent(new Event("timeupdate")));
  };
  return { video: () => video, aller };
}

// DECISIONS.md §43 : « Fin de l'épisode » se lit par `blocksAutoAdvance`, dans les commandes (ni
// carte ni décompte) comme à la fin du fichier. La carte qui restait affichée enchaînait l'épisode
// que la minuterie devait justement retenir.
describe("la minuterie « Fin de l'épisode » retire la carte de l'épisode suivant", () => {
  it("la carte paraît au générique sans minuterie, et pas sous « Fin de l'épisode »", async () => {
    const onAdvance = vi.fn();
    const { video, aller } = monter({ creditsStart: 50, nextEpisode: { itemId: "next-1", title: "Épisode suivant" }, onAdvance });
    act(() => void video().dispatchEvent(new Event("play")));
    aller(55);
    // Le témoin : sans minuterie, la carte est là — sinon l'absence plus bas ne prouverait rien.
    expect(screen.getByText("Épisode suivant")).toBeInTheDocument();

    act(() => sleepTimerStore.choose("episode"));
    aller(56);
    expect(screen.queryByText("Épisode suivant")).toBeNull();
    expect(onAdvance).not.toHaveBeenCalled();

    // La minuterie levée, la règle ordinaire revient.
    act(() => sleepTimerStore.choose("off"));
    aller(57);
    expect(screen.getByText("Épisode suivant")).toBeInTheDocument();
  });
});

// DECISIONS.md §65 : « Passer l'intro » et « Passer le récap » sont un seul bouton, décidé par
// `activeSkip` — s'ils se chevauchent, celui qui finit le plus tard, pour qu'un appui passe les deux.
describe("un seul bouton « Passer… »", () => {
  const boutons = () => screen.queryAllByText(/^player\.skip(Intro|Recap)$/);

  it("récap et intro qui se chevauchent : un bouton, celui qui finit le plus tard, et il y mène", () => {
    const { video, aller } = monter({ introSkip: { start: 10, end: 30 }, recapSkip: { start: 5, end: 40 } });
    aller(15);
    expect(boutons().map((b) => b.textContent)).toEqual(["player.skipRecap"]);
    fireEvent.click(boutons()[0]);
    expect(video().currentTime).toBe(40);
  });

  it("l'intro qui finit après le récap l'emporte", () => {
    const { video, aller } = monter({ introSkip: { start: 10, end: 60 }, recapSkip: { start: 5, end: 40 } });
    aller(15);
    expect(boutons().map((b) => b.textContent)).toEqual(["player.skipIntro"]);
    fireEvent.click(boutons()[0]);
    expect(video().currentTime).toBe(60);
  });

  it("le récap seul a son bouton, et hors des deux plages il n'y en a aucun", () => {
    const { aller } = monter({ introSkip: { start: 100, end: 160 }, recapSkip: { start: 5, end: 40 } });
    aller(20);
    expect(boutons().map((b) => b.textContent)).toEqual(["player.skipRecap"]);
    aller(60);
    expect(boutons()).toEqual([]);
  });
});
