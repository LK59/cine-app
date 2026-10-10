// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useRef } from "react";

/**
 * La fiche du bureau relaie l'aperçu (DECISIONS.md §61) : le fond ne bouge pas, le logo de l'aperçu
 * glisse jusqu'à sa place dans la fiche, le texte de l'aperçu s'efface, les rangées descendent en
 * s'effaçant, le contenu arrive d'un bloc — et la fermeture fait l'inverse. Jamais d'affiche qui
 * grandit au bureau (« au survol on a déjà la bannière, au clic la même bannière zoome », 10/10/2026).
 */
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
}));

import { useDesktopContinuity, desktopContinuityForTests, BACKDROP_FADE_MS, HERO_OUT_MS, ROWS_DROP_PX, CUT_FADE_MS } from "@/lib/sheetMorph/desktopContinuity";
import { forgetPress } from "@/lib/sheetMorph/source";
import { FADE_IN_MS } from "@/lib/sheetMorph/motion";
import { clearMorphLayers, installFakeAnimations, type FakeAnimation } from "./helpers/fakeAnimations";

const BD = "https://img.test/fond.jpg";
const LOGO = "https://img.test/logo.png";
const OTHER_LOGO = "https://img.test/autre-logo.png";
const HERO_BOX = "60,220,360,120";
const SHEET_BOX = "112,230,320,107";

let fake: ReturnType<typeof installFakeAnimations>;
let rectBefore: typeof Element.prototype.getBoundingClientRect;

/** Les boîtes lues par le mouvement : `data-box="x,y,w,h"`, sinon l'écran entier. */
function stubRects() {
  rectBefore = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const raw = this.getAttribute?.("data-box");
    const [x, y, w, h] = raw ? raw.split(",").map(Number) : [0, 0, 1024, 768];
    return { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect;
  };
}

function home(logo = LOGO) {
  const el = document.createElement("div");
  el.setAttribute("data-sheet-home", "");
  el.innerHTML = `
    <div data-sheet-hero=""><img src="${logo}" data-box="${HERO_BOX}" /><p>résumé court</p></div>
    <div data-sheet-rows=""><button data-card=""><img src="https://img.test/affiche.jpg" /></button></div>`;
  document.body.appendChild(el);
  return el;
}

function press(card: Element) {
  const img = card.querySelector("img")!;
  fireEvent.pointerDown(img, { pointerId: 1, clientX: 5, clientY: 5 });
  fireEvent.pointerUp(img, { pointerId: 1, clientX: 5, clientY: 5 });
}

function Sheet({ leaving = false }: { leaving?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const m = useDesktopContinuity({ layout: "desktop", rootRef: ref, imageRef: ref, active: true, leaving, revealed: false });
  return (
    <div ref={ref} data-testid="sheet" className={m.handlesEntry ? "" : "animate-fade-in"} style={{ zIndex: 47 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img data-sheet-photo="" src={BD} alt="" />
      <div data-sheet-veil="" />
      <div data-sheet-settle="" />
      <div data-sheet-content="">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={LOGO} alt="" data-box={SHEET_BOX} />
        <p>synopsis</p>
      </div>
      <button>Retour</button>
    </div>
  );
}

const on = (el: Element | null) => fake.created.filter((a) => a.target === el && !a.cancelled);
const lastFrame = (a: FakeAnimation) => a.frames[a.frames.length - 1];

beforeEach(() => {
  fake = installFakeAnimations();
  stubRects();
  forgetPress();
});
afterEach(() => {
  cleanup();
  clearMorphLayers();
  desktopContinuityForTests.reset();
  fake.restore();
  Element.prototype.getBoundingClientRect = rectBefore;
  document.body.innerHTML = "";
});

describe("la continuité du fond au bureau", () => {
  it("depuis une affiche dont l'aperçu montre le titre : le fond reste, le logo glisse, les rangées descendent", () => {
    const h = home();
    const card = h.querySelector("[data-card]")!;
    press(card);
    const { getByTestId } = render(<Sheet />);
    const root = getByTestId("sheet");
    expect(root.className).not.toContain("animate-fade-in");
    expect(root.style.backgroundColor).toBe("transparent");
    // Aucune affiche qui grandit : pas de calque de trajet, la carte reste visible.
    expect(document.querySelector("[data-sheet-morph-layer]")).toBeNull();
    expect((card as HTMLElement).style.opacity).toBe("");
    // Le fond de la fiche fond par-dessus celui de l'aperçu — opacité seulement, jamais déplacé.
    const photo = root.querySelector("[data-sheet-photo]");
    const fade = on(photo);
    expect(fade).toHaveLength(1);
    expect(fade[0].options.duration).toBe(BACKDROP_FADE_MS);
    expect(fade[0].frames.some((f) => "transform" in f)).toBe(false);
    // Le logo de la fiche part de la boîte de celui de l'aperçu (60,220 → 112,230 ; 360/320 de large).
    const logo = root.querySelector("[data-sheet-content] img");
    const track = on(logo);
    expect(track).toHaveLength(1);
    expect(String(track[0].frames[0].transform)).toBe("translate(-52.00px, -10.00px) scale(1.12500, 1.12150)");
    expect(String(lastFrame(track[0]).transform)).toBe("translate(0.00px, 0.00px) scale(1.00000, 1.00000)");
    expect(track[0].frames.length).toBeGreaterThanOrEqual(60);
    // Le texte de l'aperçu s'efface vite ; les rangées descendent en s'effaçant.
    const heroFade = on(h.querySelector("[data-sheet-hero]"));
    expect(heroFade[0].options.duration).toBe(HERO_OUT_MS);
    expect(lastFrame(heroFade[0]).opacity).toBe(0);
    const rows = on(h.querySelector("[data-sheet-rows]"));
    expect(String(lastFrame(rows[0]).transform)).toBe(`translateY(${ROWS_DROP_PX.toFixed(2)}px)`);
    expect(lastFrame(rows[0]).opacity).toBe(0);
    // Le contenu arrive d'un bloc, le logo n'en fait pas partie : il voyage.
    const synopsis = on(root.querySelector("[data-sheet-content] p"));
    expect(synopsis[0].options.delay).toBeGreaterThan(0);
    expect(on(root.querySelector(":scope > button"))).toHaveLength(1);
    // Tout est créé en pause, pour partir ensemble deux images plus tard.
    expect(fake.created.every((a) => a.paused)).toBe(true);
  });

  it("depuis un endroit où l'aperçu montre autre chose : le fond fond, le logo arrive avec le contenu", () => {
    const h = home(OTHER_LOGO);
    press(h.querySelector("[data-card]")!);
    const { getByTestId } = render(<Sheet />);
    const root = getByTestId("sheet");
    const logo = root.querySelector("[data-sheet-content] img");
    const anims = on(logo);
    expect(anims).toHaveLength(1);
    expect(anims[0].frames[0].opacity).toBe(0);
    expect(String(anims[0].frames[0].transform)).toMatch(/^translateY/);
    expect(on(root.querySelector("[data-sheet-photo]"))[0].options.duration).toBe(BACKDROP_FADE_MS);
  });

  it("se ferme à l'inverse : la copie rend l'adresse, le logo regagne l'aperçu, les rangées remontent", () => {
    const h = home();
    press(h.querySelector("[data-card]")!);
    const { getByTestId, rerender } = render(<Sheet />);
    const root = getByTestId("sheet");
    rerender(<Sheet leaving />);
    expect(root.style.visibility).toBe("hidden");
    const copy = document.querySelector<HTMLElement>("[data-sheet-morph-layer] .sheet-morph-clone")!;
    expect(copy).not.toBeNull();
    expect(desktopContinuityForTests.flights()).toBe(1);
    const copyLogo = copy.querySelector("[data-sheet-content] img");
    const back = on(copyLogo);
    expect(String(back[0].frames[0].transform)).toBe("translate(0.00px, 0.00px) scale(1.00000, 1.00000)");
    expect(String(lastFrame(back[0]).transform)).toBe("translate(-52.00px, -10.00px) scale(1.12500, 1.12150)");
    // Le fond de la copie s'efface sur celui de l'aperçu, le contenu d'abord.
    expect(lastFrame(on(copy.querySelector("[data-sheet-photo]"))[0]).opacity).toBe(0);
    expect(lastFrame(on(copy.querySelector("[data-sheet-content] p"))[0]).opacity).toBe(0);
    const rows = on(h.querySelector("[data-sheet-rows]"));
    expect(String(lastFrame(rows[rows.length - 1]).transform)).toBe("translateY(0.00px)");
    const hero = on(h.querySelector("[data-sheet-hero]"));
    expect(lastFrame(hero[hero.length - 1]).opacity).toBe(1);
  });

  it("une ouverture pendant la fermeture la coupe aussitôt : la copie s'efface, rien n'attend", () => {
    const h = home();
    press(h.querySelector("[data-card]")!);
    const first = render(<Sheet />);
    first.rerender(<Sheet leaving />);
    const copy = document.querySelector<HTMLElement>("[data-sheet-morph-layer] .sheet-morph-clone")!;
    expect(desktopContinuityForTests.flights()).toBe(1);
    // Une autre affiche, touchée pendant le retour.
    const other = document.createElement("button");
    other.innerHTML = `<img src="https://img.test/autre.jpg" />`;
    h.querySelector("[data-sheet-rows]")!.appendChild(other);
    press(other);
    render(<Sheet />);
    expect(desktopContinuityForTests.flights()).toBe(0);
    const cut = on(copy).find((a) => a.options.duration === CUT_FADE_MS);
    expect(cut).toBeDefined();
    expect(lastFrame(cut!).opacity).toBe(0);
  });

  it("« Réduire les animations » : un simple fondu, rien qui glisse", () => {
    const before = window.matchMedia;
    window.matchMedia = ((media: string) =>
      ({ matches: true, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList) as typeof window.matchMedia;
    try {
      const h = home();
      press(h.querySelector("[data-card]")!);
      const { getByTestId } = render(<Sheet />);
      const root = getByTestId("sheet");
      const fade = on(root);
      expect(fade).toHaveLength(1);
      expect(fade[0].options.duration).toBe(FADE_IN_MS);
      expect(on(root.querySelector("[data-sheet-content] img"))).toHaveLength(0);
      expect(on(h.querySelector("[data-sheet-rows]"))).toHaveLength(0);
    } finally {
      window.matchMedia = before;
    }
  });

  it("sans appui récent (un lien, un rechargement) : l'entrée d'avant, l'accueil intact", () => {
    const h = home();
    const { getByTestId } = render(<Sheet />);
    expect(getByTestId("sheet").className).toContain("animate-fade-in");
    expect(on(h.querySelector("[data-sheet-rows]"))).toHaveLength(0);
  });
});
