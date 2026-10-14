// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { useRef, useState, type RefObject } from "react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

import { PlayerControls, type SecondSubtitleMenu } from "@/components/PlayerControls";

/**
 * « Deux sous-titres » dans le menu des sous-titres (DECISIONS.md §87) : une porte sous l'apparence,
 * le principal et le second choisis chacun dans sa liste, cochés comme le reste des menus, un décalage
 * à part pour le second, la génération proposée comme second — et « Désactiver » qui revient à un seul.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noop = () => {};
const TRACKS = [
  { id: 3, label: "Anglais" },
  { id: 4, label: "Français" },
  { id: -1, label: "Espagnol — Externe" },
];

/** Les commandes, avec un hôte réduit à l'état des deux choix — pour voir ce que les gestes produisent. */
function Harness({
  primary = 3,
  second = null,
  extra = {},
  onPrimary = vi.fn(),
  onSecond = vi.fn(),
}: {
  primary?: number | null;
  second?: number | null;
  extra?: Partial<SecondSubtitleMenu> & { omit?: boolean; chromecast?: boolean; subtitleTracks?: { id: number; label: string }[] };
  onPrimary?: (id: number | null) => void;
  onSecond?: (id: number | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [p, setP] = useState<number | null>(primary);
  const [s, setS] = useState<number | null>(second);
  const { omit, chromecast, subtitleTracks, ...menuExtra } = extra;
  return (
    <div ref={containerRef}>
      <video ref={videoRef} />
      <p data-testid="state">{`${p}|${s}`}</p>
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
        subtitleTracks={subtitleTracks ?? TRACKS}
        currentSubtitleId={p}
        onChangeSubtitle={(id) => {
          onPrimary(id);
          // Comme les deux hôtes : un principal éteint ou devenu le second retire le second.
          if (id === null || id === s) setS(null);
          setP(id);
        }}
        secondSubtitle={
          omit
            ? undefined
            : {
                currentId: s,
                onChange: (id) => {
                  onSecond(id);
                  setS(id);
                },
                ...menuExtra,
              }
        }
        chromecast={chromecast ? { active: false, onRequest: noop } : undefined}
        hidden={false}
        loading={false}
        introSkip={null}
        creditsStart={null}
        nextEpisode={null}
        onAdvance={noop}
      />
    </div>
  );
}

async function openSubtitles(props: React.ComponentProps<typeof Harness> = {}) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
  const view = render(<Harness {...props} />);
  await act(async () => {});
  await act(async () => void fireEvent.click(view.container.querySelector('[data-player-nav="captions"]')!));
  return view.container;
}

const click = (el: Element | null) => act(async () => void fireEvent.click(el!));
const checked = (button: Element) => !button.querySelector("svg")!.getAttribute("class")!.includes("invisible");
const state = () => screen.getByTestId("state").textContent;

describe("Deux sous-titres — le menu", () => {
  it("une porte sous les pistes, seulement là où un hôte sait dessiner le second et qu'il y a de quoi faire deux", async () => {
    let container = await openSubtitles();
    expect(container.querySelector("[data-dual-subtitles-row]")?.textContent).toContain("player.dualSubtitles.title");
    cleanup();
    // Chromecast, mini-lecteur : pas de prop, pas d'entrée.
    container = await openSubtitles({ extra: { omit: true } });
    expect(container.querySelector("[data-dual-subtitles-row]")).toBeNull();
    cleanup();
    // Une seule piste et rien à générer : rien à mettre au-dessus.
    container = await openSubtitles({ extra: { subtitleTracks: [{ id: 3, label: "Anglais" }] } });
    expect(container.querySelector("[data-dual-subtitles-row]")).toBeNull();
    cleanup();
    // Une seule piste, mais une langue à générer : proposé.
    container = await openSubtitles({
      extra: { subtitleTracks: [{ id: 3, label: "Anglais" }], generation: { targets: [{ code: "fr", label: "Français" }], busy: false, onGenerate: vi.fn() } },
    });
    expect(container.querySelector("[data-dual-subtitles-row]")).not.toBeNull();
  });

  it("activer : choisir le second, coché ; la porte dit ensuite lequel", async () => {
    const onSecond = vi.fn();
    const container = await openSubtitles({ onSecond });
    await click(container.querySelector("[data-dual-subtitles-row]"));
    expect(container.querySelector("[data-dual-primary-row]")?.textContent).toContain("Anglais");
    expect(container.querySelector("[data-dual-second-row]")?.textContent).toContain("player.none");
    await click(container.querySelector("[data-dual-second-row]"));
    // Le principal n'est pas proposé comme second ; « Aucun » est coché.
    const rows = [...document.querySelectorAll("[data-dual-second]")];
    expect(rows.map((r) => r.getAttribute("data-dual-second"))).toEqual(["none", "4", "-1"]);
    expect(checked(rows[0])).toBe(true);
    await click(document.querySelector('[data-dual-second="4"]'));
    expect(onSecond).toHaveBeenCalledWith(4);
    expect(state()).toBe("3|4");
    // Retour à la vue « Deux sous-titres », qui dit le second.
    expect(container.querySelector("[data-dual-second-row]")?.textContent).toContain("Français");
    await click(container.querySelector("[data-dual-second-row]"));
    expect(checked(document.querySelector('[data-dual-second="4"]')!)).toBe(true);
    expect(checked(document.querySelector('[data-dual-second="none"]')!)).toBe(false);
    await click(screen.getByText("common.back"));
    await click(screen.getByText("common.back"));
    expect(container.querySelector("[data-dual-subtitles-row]")?.textContent).toContain("Français");
  });

  it("choisir le principal depuis « Deux sous-titres » ; prendre le second comme principal les échange", async () => {
    const onPrimary = vi.fn();
    const onSecond = vi.fn();
    const container = await openSubtitles({ second: 4, onPrimary, onSecond });
    await click(container.querySelector("[data-dual-subtitles-row]"));
    await click(container.querySelector("[data-dual-primary-row]"));
    expect(checked(document.querySelector('[data-dual-primary="3"]')!)).toBe(true);
    await click(document.querySelector('[data-dual-primary="-1"]'));
    expect(state()).toBe("-1|4");
    await click(container.querySelector("[data-dual-primary-row]"));
    await click(document.querySelector('[data-dual-primary="4"]'));
    expect(onPrimary).toHaveBeenLastCalledWith(4);
    expect(onSecond).toHaveBeenLastCalledWith(-1);
    expect(state()).toBe("4|-1");
  });

  it("le second choisi comme principal depuis la liste ordinaire : échangés aussi", async () => {
    const container = await openSubtitles({ second: 4 });
    await click(screen.getAllByText("Français")[0].closest("button"));
    expect(state()).toBe("4|3");
    expect(container).toBeTruthy();
  });

  it("désactiver revient à un seul sous-titre ; « Aucun » aussi", async () => {
    const onSecond = vi.fn();
    let container = await openSubtitles({ second: 4, onSecond });
    await click(container.querySelector("[data-dual-subtitles-row]"));
    await click(container.querySelector("[data-dual-off]"));
    expect(onSecond).toHaveBeenCalledWith(null);
    expect(state()).toBe("3|null");
    // Retour au menu des sous-titres, la porte ne nomme plus de second.
    expect(container.querySelector("[data-dual-subtitles-row]")?.textContent).not.toContain("Français");
    cleanup();

    container = await openSubtitles({ second: 4 });
    await click(container.querySelector("[data-dual-subtitles-row]"));
    await click(container.querySelector("[data-dual-second-row]"));
    await click(document.querySelector('[data-dual-second="none"]'));
    expect(state()).toBe("3|null");
  });

  it("sans principal, le second attend : la ligne est grisée et le dit", async () => {
    const container = await openSubtitles({ primary: null });
    await click(container.querySelector("[data-dual-subtitles-row]"));
    expect((container.querySelector("[data-dual-second-row]") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("player.dualSubtitles.primaryFirst")).toBeTruthy();
  });

  it("le décalage du second : le sien, même pas que celui du principal — par l'hôte qui dessine", async () => {
    const onShift = vi.fn();
    const container = await openSubtitles({ second: 4, extra: { offset: { seconds: 1.5, onShift } } });
    await click(container.querySelector("[data-dual-subtitles-row]"));
    expect(screen.getByText("player.dualSubtitles.secondOffset").parentElement!.textContent).toContain("+1.5s");
    await click(screen.getByText("player.dualSubtitles.secondOffset").parentElement!.querySelectorAll("button")[0]);
    expect(onShift).toHaveBeenCalledWith(-0.5);
  });

  it("le décalage du second, lecteur serveur : les répliques de sa propre piste, pas celles du principal", async () => {
    const primaryCue = { startTime: 10, endTime: 12 };
    const secondCue = { startTime: 10, endTime: 12 };
    const textTracks = [{ cues: [] }, { cues: [primaryCue] }, { cues: [secondCue] }];
    Object.defineProperty(HTMLMediaElement.prototype, "textTracks", { configurable: true, get: () => textTracks });
    try {
      // Pistes dans l'ordre des `<track>` : 3, 4, -1. Principal 4, second -1.
      const container = await openSubtitles({ primary: 4, second: -1 });
      await click(container.querySelector("[data-dual-subtitles-row]"));
      const row = screen.getByText("player.dualSubtitles.secondOffset").parentElement!;
      await click(row.querySelectorAll("button")[1]);
      expect(secondCue).toEqual({ startTime: 10.5, endTime: 12.5 });
      expect(primaryCue).toEqual({ startTime: 10, endTime: 12 });
      expect(row.textContent).toContain("+0.5s");
    } finally {
      delete (HTMLMediaElement.prototype as unknown as { textTracks?: unknown }).textTracks;
    }
  });

  it("générer le second : « Générer — <langue> » sous les pistes, la demande part, le menu se ferme", async () => {
    const onGenerate = vi.fn();
    const container = await openSubtitles({ extra: { generation: { targets: [{ code: "de", label: "Allemand" }], busy: false, onGenerate } } });
    await click(container.querySelector("[data-dual-subtitles-row]"));
    await click(container.querySelector("[data-dual-second-row]"));
    const row = document.querySelector('[data-dual-generate="de"]')!;
    expect(row.textContent).toBe('player.dualSubtitles.generate:{"language":"Allemand"}');
    await click(row);
    expect(onGenerate).toHaveBeenCalledWith("de");
    expect(document.querySelector("[data-dual-generate]")).toBeNull();
  });

  it("une liste imposée par l'hôte (génération du principal en cours) remplace celle du menu", async () => {
    const container = await openSubtitles({ extra: { tracks: [{ id: 4, label: "Français" }] } });
    await click(container.querySelector("[data-dual-subtitles-row]"));
    await click(container.querySelector("[data-dual-second-row]"));
    expect([...document.querySelectorAll("[data-dual-second]")].map((r) => r.getAttribute("data-dual-second"))).toEqual(["none", "4"]);
  });

  it("là où l'on peut diffuser, dit que la télévision ne reçoit que le principal", async () => {
    let container = await openSubtitles({ second: 4 });
    await click(container.querySelector("[data-dual-subtitles-row]"));
    expect(container.querySelector("[data-dual-tv-note]")).toBeNull();
    cleanup();
    container = await openSubtitles({ second: 4, extra: { chromecast: true } });
    await click(container.querySelector("[data-dual-subtitles-row]"));
    expect(container.querySelector("[data-dual-tv-note]")?.textContent).toBe("player.dualSubtitles.tvNote");
  });
});
