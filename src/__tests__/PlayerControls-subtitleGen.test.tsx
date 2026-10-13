// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { useRef, type RefObject } from "react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

import { PlayerControls, type SubtitleGenerationMenu } from "@/components/PlayerControls";

/**
 * « Générer des sous-titres » dans le menu des sous-titres (lecteur natif, DECISIONS.md §70) :
 * sous les pistes comme « Améliorer les dialogues » sous celles du son, la langue du compte d'abord,
 * les autres derrière « Autre langue… », et l'avancement discret d'une entrée temporaire.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noop = () => {};

function Harness(props: Partial<React.ComponentProps<typeof PlayerControls>>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef}>
      <video ref={videoRef} />
      <PlayerControls
        videoRef={videoRef as RefObject<HTMLVideoElement | null>}
        containerRef={containerRef}
        itemId="item-1"
        title="Un film"
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

function menu(over: Partial<SubtitleGenerationMenu> = {}): SubtitleGenerationMenu {
  return {
    targets: [
      { code: "fr", label: "Français" },
      { code: "de", label: "Allemand" },
      { code: "es", label: "Espagnol" },
    ],
    busy: false,
    onGenerate: vi.fn(),
    resumable: [],
    onResume: vi.fn(),
    ...over,
  };
}

async function openSubtitles(props: Partial<React.ComponentProps<typeof PlayerControls>>) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
  const { container } = render(<Harness {...props} />);
  await act(async () => {});
  const button = container.querySelector('[data-player-nav="captions"]');
  if (button) await act(async () => void fireEvent.click(button));
  return container;
}

describe("Générer des sous-titres — le menu", () => {
  it("absent sans la prop : ni ligne, ni bouton de sous-titres pour un film sans piste", async () => {
    const container = await openSubtitles({});
    expect(container.querySelector('[data-player-nav="captions"]')).toBeNull();
    const withTracks = await openSubtitles({ subtitleTracks: [{ id: 5, label: "Français — Complets" }] });
    expect(withTracks.querySelector("[data-subtitle-gen-row]")).toBeNull();
  });

  it("un film sans aucun sous-titre garde le bouton quand on peut en générer", async () => {
    const container = await openSubtitles({ subtitleGeneration: menu() });
    expect(container.querySelector('[data-player-nav="captions"]')).not.toBeNull();
    expect(container.querySelector("[data-subtitle-gen-row]")?.textContent).toContain("player.subtitleGen.generate");
  });

  it("la langue du compte d'abord, d'un geste ; les autres derrière « Autre langue… »", async () => {
    const generation = menu();
    const container = await openSubtitles({ subtitleTracks: [{ id: 5, label: "Anglais — Complets" }], subtitleGeneration: generation });
    await act(async () => void fireEvent.click(container.querySelector("[data-subtitle-gen-row]")!));
    const first = [...document.querySelectorAll("[data-subtitle-gen-target]")];
    expect(first.map((b) => b.textContent)).toEqual(["Français"]);
    await act(async () => void fireEvent.click(container.querySelector("[data-subtitle-gen-other]")!));
    const others = [...document.querySelectorAll("[data-subtitle-gen-target]")];
    expect(others.map((b) => b.getAttribute("data-subtitle-gen-target"))).toEqual(["de", "es"]);
    await act(async () => void fireEvent.click(others[1]));
    expect(generation.onGenerate).toHaveBeenCalledWith("es");
    // Le menu se referme, comme après un choix de piste.
    expect(document.querySelector("[data-subtitle-gen-target]")).toBeNull();
  });

  it("une seule langue : pas d'« Autre langue… » ; le retour ramène aux sous-titres", async () => {
    const generation = menu({ targets: [{ code: "fr", label: "Français" }] });
    const container = await openSubtitles({ subtitleGeneration: generation });
    await act(async () => void fireEvent.click(container.querySelector("[data-subtitle-gen-row]")!));
    expect(container.querySelector("[data-subtitle-gen-other]")).toBeNull();
    await act(async () => void fireEvent.click(screen.getByText("common.back")));
    expect(container.querySelector("[data-subtitle-gen-row]")).not.toBeNull();
    await act(async () => void fireEvent.click(container.querySelector("[data-subtitle-gen-row]")!));
    await act(async () => void fireEvent.click(document.querySelector('[data-subtitle-gen-target="fr"]')!));
    expect(generation.onGenerate).toHaveBeenCalledWith("fr");
  });

  it("une demande en vol ne se propose pas deux fois", async () => {
    const container = await openSubtitles({ subtitleGeneration: menu({ busy: true }) });
    expect((container.querySelector("[data-subtitle-gen-row]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("l'entrée temporaire montre son avancement à part, en petit", async () => {
    const container = await openSubtitles({
      subtitleTracks: [{ id: -1_000_000, label: "Français — génération…", detail: "42 %" }],
      currentSubtitleId: -1_000_000,
    });
    const entry = screen.getByText("Français — génération…");
    expect(entry.querySelector("[data-track-detail]")?.textContent).toBe("42 %");
    // La piste retenue porte la coche (13/10/2026 : l'accent blanc ne la distinguait plus).
    expect(entry.closest("button")!.className).toContain("font-semibold");
    expect(entry.closest("button")!.querySelector("svg")!.getAttribute("class")).not.toContain("invisible");
    expect(container.querySelectorAll("[data-track-detail]")).toHaveLength(1);
  });

  it("une génération en pause se reprend d'un geste depuis le menu, sans langue à proposer", async () => {
    const generation = menu({ targets: [], resumable: [{ code: "fr", label: "Français" }] });
    const container = await openSubtitles({ subtitleGeneration: generation });
    expect(container.querySelector("[data-subtitle-gen-row]")).toBeNull();
    const resume = container.querySelector('[data-subtitle-gen-resume="fr"]')!;
    expect(resume.textContent).toBe('player.subtitleGen.resume:{"language":"Français"}');
    await act(async () => void fireEvent.click(resume));
    expect(generation.onResume).toHaveBeenCalledWith("fr");
  });
});
