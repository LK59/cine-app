// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  dualSubtitleMemory,
  pickRememberedDual,
  rememberDual,
  secondOverlayCss,
  primaryDualCss,
  SECOND_SUBTITLE_TINT,
} from "@/lib/dualSubtitles";
import { overlayCss, subtitleRowStyle, DEFAULT_SUBTITLE_STYLE } from "@/lib/subtitleStyle";
import { SubtitleLayer } from "@/components/player/SubtitleLayer";

/**
 * « Deux sous-titres » (DECISIONS.md §87), hors des lecteurs : l'apparence du second, l'empilement
 * qui ne déplace jamais le principal, et ce que l'appareil retient pour le film suivant.
 */

const track = (number: number, language: string | null, over: Record<string, unknown> = {}) => ({
  number,
  language,
  name: null as string | null,
  isDefault: false,
  isForced: false,
  ...over,
});

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("l'apparence du second", () => {
  it("80 % du principal, une teinte plus douce, la même ombre", () => {
    const style = DEFAULT_SUBTITLE_STYLE;
    const second = secondOverlayCss(style);
    // La taille du second est celle du principal à 0,8 × le facteur choisi.
    expect(String(second.fontSize)).toContain(String(overlayCss({ ...style, size: 0.8 }).fontSize));
    expect(second.color).toBe(SECOND_SUBTITLE_TINT.white);
    expect(second.color).not.toBe(overlayCss(style).color);
    expect(second.textShadow).toBe(overlayCss(style).textShadow);
    expect(secondOverlayCss({ ...style, color: "yellow" }).color).toBe(SECOND_SUBTITLE_TINT.yellow);
    // Avec une boîte, le second a la sienne aussi.
    expect(secondOverlayCss({ ...style, background: "box" }).backgroundColor).toBe(overlayCss({ ...style, background: "box" }).backgroundColor);
  });

  it("le facteur du mode (`--dual-k`, réduit en portrait) s'applique aux deux, la taille du principal sinon inchangée", () => {
    expect(String(primaryDualCss(DEFAULT_SUBTITLE_STYLE).fontSize)).toBe(`calc(var(--dual-k, 1) * ${overlayCss(DEFAULT_SUBTITLE_STYLE).fontSize})`);
    expect(String(secondOverlayCss(DEFAULT_SUBTITLE_STYLE).fontSize)).toMatch(/^calc\(var\(--dual-k, 1\) \* /);
  });
});

describe("le calque : deux lignes empilées, le principal immobile", () => {
  const chrome = { top: 80, bottom: 140 };
  const lines = (container: HTMLElement) => [...container.querySelectorAll("p")];
  /** Le style attendu, passé par le même moteur CSS que l'élément (jsdom réordonne les `calc`). */
  const expected = (top: boolean) => {
    const probe = document.createElement("div");
    Object.assign(probe.style, subtitleRowStyle(top, chrome));
    return probe.style;
  };

  it("un seul sous-titre : le calque d'avant, à l'identique", () => {
    const { container } = render(<SubtitleLayer primary="Bonjour." style={DEFAULT_SUBTITLE_STYLE} chromeEdges={chrome} />);
    expect(lines(container)).toHaveLength(1);
    const row = container.querySelector(".subtitle-lift") as HTMLElement;
    expect(row.className).toBe("subtitle-lift absolute inset-x-0 flex justify-center px-8");
    expect(row.style.bottom).toBe(expected(false).bottom);
    expect(container.querySelector("[data-subtitle-second]")).toBeNull();
  });

  it("rien à dire : rien de dessiné, en mode un ou deux", () => {
    expect(render(<SubtitleLayer primary={null} style={DEFAULT_SUBTITLE_STYLE} chromeEdges={null} />).container.innerHTML).toBe("");
    expect(render(<SubtitleLayer dual primary={null} second={null} style={DEFAULT_SUBTITLE_STYLE} chromeEdges={null} />).container.innerHTML).toBe("");
  });

  it("les deux répliques : le second juste au-dessus du principal, dans une rangée posée là où l'était le principal seul", () => {
    const { container } = render(<SubtitleLayer dual primary="Hello." second="Bonjour." style={DEFAULT_SUBTITLE_STYLE} chromeEdges={chrome} />);
    const row = container.querySelector('[data-subtitle-row="bottom"]') as HTMLElement;
    const [first, last] = [...row.children] as HTMLElement[];
    expect(first.hasAttribute("data-subtitle-second")).toBe(true);
    expect(first.textContent).toBe("Bonjour.");
    // Le principal est le dernier enfant d'une rangée ancrée par son bas : il ne bouge pas quand le
    // second grandit, rétrécit ou se tait.
    expect(last.hasAttribute("data-subtitle-primary")).toBe(true);
    expect(last.textContent).toBe("Hello.");
    expect(row.style.bottom).toBe(expected(false).bottom);
    expect(row.style.transform).toBe(expected(false).transform);
  });

  it("seul le second parle : il garde sa place au-dessus d'une ligne vide du principal, il ne descend pas", () => {
    const { container } = render(<SubtitleLayer dual primary={null} second="Bonjour." style={DEFAULT_SUBTITLE_STYLE} chromeEdges={null} />);
    const row = container.querySelector('[data-subtitle-row="bottom"]') as HTMLElement;
    const [first, last] = [...row.children] as HTMLElement[];
    expect(first.hasAttribute("data-subtitle-second")).toBe(true);
    expect(last.hasAttribute("data-subtitle-primary-space")).toBe(true);
    expect(last.style.height).toBe("1.375em");
    expect(last.style.fontSize).toBe(String(primaryDualCss(DEFAULT_SUBTITLE_STYLE).fontSize));
  });

  it("seul le principal parle : à sa place, sans second, à la même taille qu'avec", () => {
    const { container } = render(<SubtitleLayer dual primary="Hello." second={null} style={DEFAULT_SUBTITLE_STYLE} chromeEdges={null} />);
    const primary = container.querySelector("[data-subtitle-primary]") as HTMLElement;
    expect(primary.textContent).toBe("Hello.");
    expect(container.querySelector("[data-subtitle-second]")).toBeNull();
    expect(primary.style.fontSize).toBe(String(primaryDualCss(DEFAULT_SUBTITLE_STYLE).fontSize));
  });

  it("un message de génération sur le second est marqué comme tel, à la place du second", () => {
    const { container } = render(
      <SubtitleLayer dual primary="Hello." second="Préparation…" secondNotice style={DEFAULT_SUBTITLE_STYLE} chromeEdges={null} />
    );
    expect(container.querySelector("[data-subtitle-second]")!.hasAttribute("data-subtitle-notice")).toBe(true);
    expect(container.querySelector("[data-subtitle-primary]")!.hasAttribute("data-subtitle-notice")).toBe(false);
  });

  it("une réplique placée en haut (`{\\an8}`) y reste, l'autre en bas", () => {
    const { container } = render(<SubtitleLayer dual primary="Hello." second={"{\\an8}PANNEAU"} style={DEFAULT_SUBTITLE_STYLE} chromeEdges={null} />);
    const second = container.querySelector("[data-subtitle-second]") as HTMLElement;
    expect(second.textContent).toBe("PANNEAU");
    expect(second.closest('[data-subtitle-row="bottom"]')).toBeNull();
    expect(container.querySelector('[data-subtitle-row="bottom"] [data-subtitle-primary]')?.textContent).toBe("Hello.");
  });
});

describe("ce que l'appareil retient", () => {
  it("les deux langues du choix, et rien quand il n'y a plus de second", () => {
    rememberDual(track(3, "eng"), track(4, "fre"));
    expect(dualSubtitleMemory.read()).toEqual({ primary: "en", second: "fr" });
    rememberDual(track(3, "eng"), null);
    expect(dualSubtitleMemory.read()).toBeNull();
    // Un second sans langue ne pourrait pas être retrouvé : un seul sous-titre.
    rememberDual(track(3, "eng"), track(4, null));
    expect(dualSubtitleMemory.read()).toBeNull();
  });

  it("au film suivant : le second de la langue retenue, à côté du principal déjà choisi", () => {
    const tracks = [track(3, "eng"), track(4, "fre", { isForced: true }), track(5, "fre", { isHearingImpaired: true }), track(6, "fra"), track(-1, "spa")];
    const pair = pickRememberedDual(tracks, 3, { primary: "en", second: "fr" });
    // Ni la forcée (quelques panneaux), ni celle pour malentendants quand une ordinaire existe.
    expect(pair?.primary.number).toBe(3);
    expect(pair?.second.number).toBe(6);
  });

  it("sans principal choisi : celui de la langue retenue ; sans la langue du second : un seul sous-titre", () => {
    const tracks = [track(3, "eng"), track(-1, "fre")];
    expect(pickRememberedDual(tracks, null, { primary: "en", second: "fr" })).toMatchObject({ primary: { number: 3 }, second: { number: -1 } });
    expect(pickRememberedDual([track(3, "eng")], 3, { primary: "en", second: "fr" })).toBeNull();
    expect(pickRememberedDual([track(3, "eng"), track(4, "fre")], 3, null)).toBeNull();
  });

  it("un principal déjà dans la langue du second : pas deux fois la même langue", () => {
    expect(pickRememberedDual([track(3, "fre"), track(4, "fre")], 3, { primary: "en", second: "fr" })).toBeNull();
  });

  it("un stockage illisible ou d'une autre forme se lit comme un seul sous-titre", () => {
    window.localStorage.setItem("cine:dual-subtitles", "{pas du json");
    expect(dualSubtitleMemory.read()).toBeNull();
    window.localStorage.setItem("cine:dual-subtitles", JSON.stringify({ v: 9, second: "fr" }));
    expect(dualSubtitleMemory.read()).toBeNull();
  });
});
