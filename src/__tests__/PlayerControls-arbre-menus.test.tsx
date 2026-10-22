// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { useRef, useState, type RefObject } from "react";
import { SWRConfig } from "swr";

/**
 * L'arbre des menus du lecteur, toutes les fonctions allumées : chaque vue atteinte par les gestes
 * du spectateur, son titre, son « Retour » et la vue où il mène, ses lignes dans l'ordre, celles qui
 * sont cochées. Écrit avant le découpage de `PlayerControls` (audit du lecteur, 22/10/2026, étapes
 * 2–3 : `PlayerSettingsMenu`, `MENU_PARENT`, `MenuOption`) — une version durable et lisible de la
 * comparaison de 209 états faite alors dans un script jetable. On y lit des libellés et des
 * attributs, jamais un instantané du DOM entier.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr" }),
}));

import { PlayerControls } from "@/components/PlayerControls";
import { sleepTimerStore } from "@/lib/sleepTimer";

const SERIES = "cccccccccccccccccccccccccccccccc";

beforeEach(() => {
  window.localStorage.clear();
  sleepTimerStore.choose("off");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.startsWith("/api/player/item/")
        ? { seriesId: SERIES, download: null }
        : url.startsWith("/api/jellyfin/chapters")
          ? [{ start: 0, name: "Ouverture" }, { start: 600, name: null }]
          : url.endsWith("/episodes")
            ? { seasons: [{ seasonNumber: 1, episodes: [] }], nextEpisode: null }
            : null;
      return { ok: !!body, status: body ? 200 : 404, json: async () => body };
    })
  );
});
afterEach(() => {
  cleanup();
  sleepTimerStore.choose("off");
  vi.unstubAllGlobals();
});

const noop = () => {};

/** Les commandes avec tout ce qu'un hôte peut leur donner ; le second sous-titre tenu par le harnais. */
function Harness({ onFrameFit = noop, onChangeAudio = noop }: { onFrameFit?: (on: boolean) => void; onChangeAudio?: (id: number) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [second, setSecond] = useState<number | null>(4);
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <div ref={containerRef}>
        <video ref={videoRef} />
        <p data-testid="second">{String(second)}</p>
        <PlayerControls
          videoRef={videoRef as RefObject<HTMLVideoElement | null>}
          containerRef={containerRef}
          itemId="ep-3"
          title="Série — S01E03"
          onClose={noop}
          onMinimize={noop}
          onTogglePlaybackInfo={noop}
          audioTracks={[
            { id: 1, label: "Français" },
            { id: 2, label: "Anglais" },
          ]}
          currentAudioId={1}
          onChangeAudio={onChangeAudio}
          dialogue={{ mode: "on", applies: true, onChange: noop }}
          subtitleTracks={[
            { id: 3, label: "Anglais (st)" },
            { id: 4, label: "Français (st)" },
          ]}
          currentSubtitleId={3}
          onChangeSubtitle={noop}
          subtitleOffset={{ seconds: 0, onShift: noop }}
          secondSubtitle={{
            currentId: second,
            onChange: setSecond,
            offset: { seconds: 0, onShift: noop },
            generation: { targets: [{ code: "es", label: "Espagnol" }], busy: false, onGenerate: noop },
          }}
          subtitleGeneration={{
            targets: [
              { code: "fr", label: "Français" },
              { code: "de", label: "Allemand" },
            ],
            busy: false,
            onGenerate: noop,
            resumable: [{ code: "it", label: "Italien" }],
            onResume: noop,
          }}
          hdrCap={{ current: 203, autoNits: 203, onPick: noop }}
          frameFit={{ on: true, onChange: onFrameFit }}
          onCastReturn={noop}
          castActive={false}
          onPlayEpisode={noop}
          hidden={false}
          loading={false}
          introSkip={null}
          creditsStart={null}
          nextEpisode={{ itemId: "ep-4", title: "Épisode 4" }}
          onAdvance={noop}
        />
      </div>
    </SWRConfig>
  );
}

const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

/** Ce que montre le menu ouvert : son titre, s'il a un « Retour », ses lignes, les cochées, ses notes. */
function readView(container: HTMLElement) {
  const menu = container.querySelector(".player-menu");
  if (!menu) return null;
  const list = menu.querySelector(".player-menu-list")!;
  const buttons = [...list.querySelectorAll("button")];
  const back = buttons.find((b) => text(b) === "common.back");
  return {
    title: text(menu.querySelector(".player-menu-title")!),
    back: !!back,
    rows: buttons.filter((b) => b !== back).map(text),
    checked: buttons.filter((b) => b.querySelector("[data-option-on]")).map(text),
    notes: [...list.querySelectorAll("p")].map(text),
  };
}

/** Un geste : le bouton de la pilule (`nav`), une ligne du menu par sélecteur (`sel`) ou par libellé (`txt`). */
type Step = ["nav" | "sel" | "txt", string];
type View = {
  path: Step[];
  title: string;
  parent: string | null;
  rows: string[];
  checked: string[];
  notes?: string[];
};

const OFFSET = ["−0.5s", "+0.5s"];

/**
 * Les seize vues des menus. `parent` : la vue où mène « Retour » ; `null`, une racine ouverte par un
 * bouton de la pilule. Chaque vue a son titre — « dialogue » et « quality » n'en avaient pas
 * (relevé par l'audit du 22/10/2026), elles portent celui de la ligne qui les ouvre.
 */
const VIEWS: Record<string, View> = {
  audio: {
    path: [["nav", "audio"]],
    title: "player.audio",
    parent: null,
    rows: ["Français", "Anglais", "player.dialogue.titleplayer.chromecast.beta"],
    checked: ["Français"],
  },
  dialogue: {
    path: [["nav", "audio"], ["sel", "[data-dialogue-row]"]],
    title: "player.dialogue.title",
    parent: "audio",
    rows: ["player.dialogue.off", "player.dialogue.enhance", "player.dialogue.further"],
    checked: ["player.dialogue.enhance"],
  },
  subtitles: {
    path: [["nav", "captions"]],
    title: "player.subtitles",
    parent: null,
    rows: [
      "Anglais (st)",
      "Français (st)",
      "player.none",
      "player.subtitleGen.generate",
      'player.subtitleGen.resume:{"language":"Italien"}',
      "player.subtitleStyle.title",
      ...OFFSET,
      "player.dualSubtitles.titleFrançais (st)",
    ],
    checked: ["Anglais (st)"],
  },
  subtitleGen: {
    path: [["nav", "captions"], ["sel", "[data-subtitle-gen-row]"]],
    title: "player.subtitleGen.generate",
    parent: "subtitles",
    rows: ["Français", "player.subtitleGen.otherLanguage"],
    checked: [],
  },
  subtitleGenOther: {
    path: [["nav", "captions"], ["sel", "[data-subtitle-gen-row]"], ["sel", "[data-subtitle-gen-other]"]],
    title: "player.subtitleGen.generate",
    parent: "subtitleGen",
    rows: ["Allemand"],
    checked: [],
  },
  subtitleStyle: {
    path: [["nav", "captions"], ["txt", "player.subtitleStyle.title"]],
    title: "player.subtitleStyle.title",
    parent: "subtitles",
    rows: [
      "player.subtitleSizeXSmall",
      "player.subtitleSizeSmall",
      "player.subtitleSizeNormal",
      "player.subtitleSizeLarge",
      "player.subtitleSizeXLarge",
      "player.subtitleStyle.colours.white",
      "player.subtitleStyle.colours.yellow",
      "player.subtitleStyle.backgrounds.shadow",
      "player.subtitleStyle.backgrounds.box",
      "player.subtitleStyle.backgrounds.none",
    ],
    // L'apparence se dit par `aria-pressed`, pas par une coche (voir le test plus bas).
    checked: [],
    notes: ["player.subtitleSize", "player.subtitleStyle.colour", "player.subtitleStyle.background"],
  },
  dual: {
    path: [["nav", "captions"], ["sel", "[data-dual-subtitles-row]"]],
    title: "player.dualSubtitles.title",
    parent: "subtitles",
    rows: ["player.dualSubtitles.primaryAnglais (st)", "player.dualSubtitles.secondFrançais (st)", ...OFFSET, "player.dualSubtitles.off"],
    checked: [],
  },
  dualPrimary: {
    path: [["nav", "captions"], ["sel", "[data-dual-subtitles-row]"], ["sel", "[data-dual-primary-row]"]],
    title: "player.dualSubtitles.primary",
    parent: "dual",
    rows: ["Anglais (st)", "Français (st)"],
    checked: ["Anglais (st)"],
  },
  dualSecond: {
    path: [["nav", "captions"], ["sel", "[data-dual-subtitles-row]"], ["sel", "[data-dual-second-row]"]],
    title: "player.dualSubtitles.second",
    parent: "dual",
    // Le principal n'y est pas : on ne peut pas le prendre aussi comme second.
    rows: ["player.none", "Français (st)", 'player.dualSubtitles.generate:{"language":"Espagnol"}'],
    checked: ["Français (st)"],
  },
  more: {
    path: [["nav", "more"]],
    title: "player.moreOptions",
    parent: null,
    rows: [
      "player.chapters",
      "player.speed · player.speedNormal",
      "player.sleep.title",
      "player.castReturn",
      "player.frameFit",
      "player.playbackInfo",
      "player.quality.title · player.quality.auto",
      "player.hdrCap.title · 203 nits",
    ],
    checked: [],
  },
  chapters: {
    path: [["nav", "more"], ["txt", "player.chapters"]],
    title: "player.chapters",
    parent: "more",
    rows: ["Ouverture0:00", 'player.chapterN:{"n":2}10:00'],
    checked: ["Ouverture0:00"],
  },
  speed: {
    path: [["nav", "more"], ["sel", '[data-player-nav="speed"]']],
    title: "player.speed",
    parent: "more",
    rows: ["0.5x", "0.75x", "player.speedNormal", "1.25x", "1.5x", "1.75x", "2x"],
    checked: ["player.speedNormal"],
  },
  sleep: {
    path: [["nav", "more"], ["txt", "player.sleep.title"]],
    title: "player.sleep.title",
    parent: "more",
    // « Fin de l'épisode » parce qu'un épisode suit.
    rows: [
      "player.sleep.off",
      'player.sleep.minutes:{"n":15}',
      'player.sleep.minutes:{"n":30}',
      'player.sleep.minutes:{"n":60}',
      'player.sleep.minutes:{"n":90}',
      "player.sleep.episode",
    ],
    checked: ["player.sleep.off"],
  },
  quality: {
    path: [["nav", "more"], ["sel", "[data-quality-row]"]],
    title: "player.quality.title",
    parent: "more",
    rows: ["player.quality.auto", "player.quality.original"],
    checked: ["player.quality.auto"],
    notes: ["player.quality.hint"],
  },
  hdrCap: {
    path: [["nav", "more"], ["txt", "player.hdrCap.title"]],
    title: "player.hdrCap.title",
    parent: "more",
    rows: ["player.hdrCap.auto · 203 nits", "player.hdrCap.native", "650 nits", "400 nits", "203 nits", "150 nits", "100 nits"],
    checked: ["203 nits"],
    notes: ["player.hdrCap.hint"],
  },
  episodes: {
    path: [["nav", "episodes"]],
    title: "player.episodes.title",
    parent: null,
    rows: [],
    checked: [],
  },
};

async function mounted() {
  const view = render(<Harness />);
  // Le titre de l'épisode (sa série) et les chapitres arrivent par le réseau.
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  return view.container;
}
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("élément introuvable");
  await act(async () => void fireEvent.click(el));
};
async function walk(container: HTMLElement, path: Step[]) {
  for (const [kind, arg] of path) {
    if (kind === "nav") await click(container.querySelector(`[data-player-nav="${arg}"]`));
    else if (kind === "sel") await click(container.querySelector(`.player-menu ${arg}`));
    else await click([...container.querySelectorAll(".player-menu-list button")].find((b) => text(b).startsWith(arg)));
  }
}
const expected = (name: string) => {
  const v = VIEWS[name];
  return { title: v.title, back: v.parent !== null, rows: v.rows, checked: v.checked, notes: v.notes ?? [] };
};

describe("PlayerControls — l'arbre des menus, toutes fonctions allumées", () => {
  it("seize vues, toutes atteintes par les gestes du spectateur", () => {
    expect(Object.keys(VIEWS).sort()).toEqual(
      ["audio", "chapters", "dialogue", "dual", "dualPrimary", "dualSecond", "episodes", "hdrCap", "more", "quality", "sleep", "speed", "subtitleGen", "subtitleGenOther", "subtitleStyle", "subtitles"].sort()
    );
  });

  for (const name of Object.keys(VIEWS)) {
    it(`${name} : titre, « Retour », lignes et coches`, async () => {
      const container = await mounted();
      await walk(container, VIEWS[name].path);
      expect(readView(container)).toEqual(expected(name));
    });
  }

  for (const name of Object.keys(VIEWS).filter((n) => VIEWS[n].parent !== null)) {
    it(`${name} : « Retour » mène à ${VIEWS[name].parent}`, async () => {
      const container = await mounted();
      await walk(container, VIEWS[name].path);
      await click([...container.querySelectorAll(".player-menu-list button")].find((b) => text(b) === "common.back"));
      expect(readView(container)).toEqual(expected(VIEWS[name].parent!));
    });
  }

  it("les quatre racines : un bouton nommé de la pilule, marqué ouvert, qui referme au second appui", async () => {
    const container = await mounted();
    const roots: [string, string][] = [
      ["audio", "player.audio"],
      ["captions", "player.subtitles"],
      ["more", "player.moreOptions"],
      ["episodes", "player.episodes.title"],
    ];
    for (const [nav, label] of roots) {
      const button = container.querySelector(`[data-player-nav="${nav}"]`)!;
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.hasAttribute("data-on")).toBe(false);
      await click(button);
      expect(button.hasAttribute("data-on")).toBe(true);
      // Une seule racine ouverte à la fois.
      expect(container.querySelectorAll("[data-player-nav][data-on]")).toHaveLength(1);
      await click(button);
      expect(button.hasAttribute("data-on")).toBe(false);
      expect(readView(container)).toBeNull();
    }
    // Ouvrir une racine depuis une autre la remplace.
    await click(container.querySelector('[data-player-nav="audio"]'));
    await click(container.querySelector('[data-player-nav="more"]'));
    expect(readView(container)?.title).toBe("player.moreOptions");
  });

  it("l'apparence des sous-titres dit son choix par `aria-pressed`, un par groupe", async () => {
    const container = await mounted();
    await walk(container, VIEWS.subtitleStyle.path);
    const pressed = [...container.querySelectorAll('.player-menu-list button[aria-pressed="true"]')].map(text);
    expect(pressed).toHaveLength(3);
    expect(pressed[0]).toMatch(/^player\.subtitleSize/);
    expect(pressed[1]).toMatch(/^player\.subtitleStyle\.colours\./);
    expect(pressed[2]).toMatch(/^player\.subtitleStyle\.backgrounds\./);
  });

  it("« Ajuster à l'écran » est un interrupteur : son état en `aria-checked`, et le menu reste ouvert", async () => {
    const onFrameFit = vi.fn();
    const { container } = render(<Harness onFrameFit={onFrameFit} />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    await walk(container, VIEWS.more.path);
    const toggle = container.querySelector('.player-menu [role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await click(toggle);
    expect(onFrameFit).toHaveBeenCalledWith(false);
    expect(readView(container)?.title).toBe("player.moreOptions");
  });

  it("où mène un choix : une piste referme le menu ; les choix de « Deux sous-titres » reviennent à leur vue, « Désactiver » aux sous-titres", async () => {
    const onChangeAudio = vi.fn();
    const { container, getByTestId } = render(<Harness onChangeAudio={onChangeAudio} />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    const row = (label: string) => [...container.querySelectorAll(".player-menu-list button")].find((b) => text(b) === label);

    await walk(container, VIEWS.audio.path);
    await click(row("Anglais"));
    expect(onChangeAudio).toHaveBeenCalledWith(2);
    expect(readView(container)).toBeNull();

    await walk(container, VIEWS.dualSecond.path);
    await click(row("player.none"));
    expect(getByTestId("second").textContent).toBe("null");
    expect(readView(container)?.title).toBe("player.dualSubtitles.title");

    await click(container.querySelector(".player-menu [data-dual-second-row]"));
    await click(row("Français (st)"));
    expect(getByTestId("second").textContent).toBe("4");
    expect(readView(container)?.title).toBe("player.dualSubtitles.title");

    await click(container.querySelector(".player-menu [data-dual-off]"));
    expect(getByTestId("second").textContent).toBe("null");
    expect(readView(container)?.title).toBe("player.subtitles");
  });
});
