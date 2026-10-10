// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useSheetMorph, sheetMorphForTests, type SheetLayout } from "@/lib/sheetMorph/useSheetMorph";
import { forgetPress } from "@/lib/sheetMorph/source";
import { clearMorphLayers, installFakeAnimations, type FakeAnimation } from "./helpers/fakeAnimations";

/**
 * L'ouverture et la fermeture des fiches (DECISIONS.md §61), par une fiche réduite à ce que
 * `useSheetMorph` lit : sa racine, sa bannière, son visuel, ses voiles, son contenu. Les places sont
 * celles d'un téléphone (390 × 844) : une affiche de rangée en bas, la bannière en haut.
 */

const BOXES: Record<string, { x: number; y: number; w: number; h: number }> = {
  poster: { x: 20, y: 500, w: 110, h: 165 },
  other: { x: 140, y: 500, w: 110, h: 165 },
  banner: { x: 0, y: 40, w: 390, h: 220 },
  sheet: { x: 0, y: 40, w: 390, h: 804 },
  home: { x: 0, y: 0, w: 390, h: 844 },
  // Un bloc de la fiche défilé hors de l'écran : la copie légère ne le recopie pas.
  below: { x: 0, y: 2000, w: 390, h: 600 },
  // Le contenu d'une fiche longue : plus haut que l'écran, la copie n'en garde que le visible.
  content: { x: 0, y: 236, w: 390, h: 2400 },
};

function rect(b: { x: number; y: number; w: number; h: number }): DOMRect {
  return { x: b.x, y: b.y, left: b.x, top: b.y, width: b.w, height: b.h, right: b.x + b.w, bottom: b.y + b.h, toJSON: () => b } as DOMRect;
}

let originalRect: typeof Element.prototype.getBoundingClientRect;
let fake: ReturnType<typeof installFakeAnimations>;

function Sheet({
  layout = "phone",
  leaving = false,
  revealed = false,
  active = true,
  instantExit = false,
}: {
  layout?: SheetLayout;
  leaving?: boolean;
  revealed?: boolean;
  active?: boolean;
  instantExit?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const morph = useSheetMorph({ layout, rootRef, imageRef: layout === "phone" ? bannerRef : rootRef, active, leaving, revealed, instantExit });
  return createPortal(
    <div ref={rootRef} data-box="sheet" data-handles={String(morph.handlesEntry)} className="phone-sheet-frame" style={{ zIndex: 48, backgroundColor: "rgb(10, 10, 15)" }}>
      <div ref={bannerRef} data-box="banner">
        {/* eslint-disable-next-line @next/next/no-img-element -- la fiche de test n'a qu'une <img> nue, comme FadeInImg */}
        <img data-sheet-photo="" src="https://img.test/backdrop.jpg" alt="" />
        <div data-sheet-veil="" />
        <button type="button" data-sheet-glass="" aria-label="fermer">
          x
        </button>
      </div>
      <div data-sheet-content="">contenu</div>
    </div>,
    document.body,
  );
}

/** Une carte de l'accueil, avec son affiche. */
function addPoster(box: "poster" | "other" = "poster"): HTMLButtonElement {
  const button = document.createElement("button");
  button.dataset.box = box;
  const img = document.createElement("img");
  img.src = `https://img.test/${box}.jpg`;
  img.dataset.box = box;
  button.appendChild(img);
  document.body.appendChild(button);
  return button;
}

/** Un appui sur place, sans glissement — ce que le traqueur retient. */
function press(el: Element) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: 50, clientY: 550 });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: 50, clientY: 550 });
}

const layer = () => document.body.querySelector<HTMLElement>("[data-sheet-morph-layer]");
const root = () => document.body.querySelector<HTMLElement>("[data-sheet-morph-root]");
const live = (el: Element | null) => fake.created.filter((a) => a.target === el && !a.cancelled);

/** Le départ (décodage, deux images) puis tout le trajet. */
async function runOpen() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const key = (this as HTMLElement).dataset?.box;
    return rect(key && BOXES[key] ? BOXES[key] : { x: 0, y: 0, w: 0, h: 0 });
  };
  fake = installFakeAnimations();
  forgetPress();
});

afterEach(() => {
  cleanup();
  clearMorphLayers();
  fake.restore();
  Element.prototype.getBoundingClientRect = originalRect;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("l'ouverture", () => {
  it("part de l'affiche touchée : le calque sous la fiche, l'affiche cachée, la fiche transparente, le contenu à venir", async () => {
    const poster = addPoster();
    press(poster.querySelector("img")!);
    render(<Sheet />);

    expect(root()!.dataset.handles).toBe("true");
    // Le calque est juste avant la fiche, au même plan : la colonne passe au-dessus de l'image qui vole.
    expect(layer()!.nextElementSibling).toBe(root());
    expect(layer()!.style.zIndex).toBe("48");
    expect(poster.style.opacity).toBe("0");
    // La maquette validée : la fiche transparente et immobile, son fond (l'encre, les coins) monte à
    // part, sous l'image qui vole — l'image au-dessus de la carte, jamais l'inverse.
    expect(root()!.style.backgroundColor).toBe("transparent");
    expect(live(root()).some((a) => a.frames.some((f) => /translateY/.test(String(f.transform))))).toBe(false);
    const win = layer()!.lastElementChild as HTMLElement;
    const shell = win.previousElementSibling as HTMLElement;
    expect(shell.style.background).toContain("rgb(10, 10, 15)");
    const rise = live(shell).find((a) => /translateY/.test(String(a.frames[0].transform)))!;
    expect(rise.frames[0].transform).toBe("translateY(804.00px)");
    expect(rise.frames.at(-1)!.transform).toBe("translateY(0.00px)");
    expect(rise.frames.length).toBeGreaterThanOrEqual(61);
    // La croix ne surgit pas pleine : elle paraît pendant le trajet.
    const glass = live(root()!.querySelector("[data-sheet-glass]"))[0] as FakeAnimation;
    expect(glass.frames[0].opacity).toBe(0);
    expect(glass.options.delay).toBeGreaterThan(0);
    expect(root()!.querySelector<HTMLElement>("[data-sheet-photo]")!.style.visibility).toBe("hidden");
    // La fenêtre porte l'affiche déjà chargée — rien n'est téléchargé pour animer.
    const posters = Array.from(layer()!.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(posters).toContain("https://img.test/poster.jpg");
    // Créées en pause, démarrées ensemble ; le contenu attend 90 % du trajet.
    const content = root()!.querySelector("[data-sheet-content]")!;
    const reveal = live(content)[0] as FakeAnimation;
    expect(reveal.paused).toBe(true);
    expect(reveal.options.delay).toBeGreaterThan(0);

    await runOpen();
    // Arrivée : le vrai visuel a repris la place de la fenêtre ; l'assombrissement reste.
    expect(root()!.querySelector<HTMLElement>("[data-sheet-photo]")!.style.visibility).toBe("");
    expect(root()!.style.backgroundColor).toBe("rgb(10, 10, 15)");
    expect(layer()!.querySelectorAll("img").length).toBe(0);
    // Le fond à part est parti : la vraie carte, posée exactement là, a repris son encre.
    expect(layer()!.children.length).toBe(1);
    expect(layer()).not.toBeNull();
  });

  it("ne vole pas sans appui récent, ni au retour arrière, ni pour une fiche recouverte", () => {
    render(<Sheet />);
    expect(root()!.dataset.handles).toBe("false");
    expect(layer()).toBeNull();
    cleanup();

    press(addPoster().querySelector("img")!);
    render(<Sheet revealed />);
    expect(root()!.dataset.handles).toBe("false");
    expect(layer()).toBeNull();
  });

  it("« Réduire les animations » : un fondu, rien qui se déplace", () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    press(addPoster().querySelector("img")!);
    render(<Sheet />);
    expect(root()!.dataset.handles).toBe("true");
    const opacity = live(root()).find((a) => a.frames.some((f) => "opacity" in f));
    expect(opacity).toBeDefined();
    expect(layer()!.querySelectorAll("img").length).toBe(0);
  });
});

describe("la fermeture", () => {
  it("revole vers l'affiche : une copie sort à la place de la fiche, qui se cache aussitôt", async () => {
    const poster = addPoster();
    press(poster.querySelector("img")!);
    const { rerender } = render(<Sheet />);
    await runOpen();
    // Un long bloc défilé hors de l'écran (les épisodes, les titres similaires).
    const below = document.createElement("div");
    below.dataset.box = "below";
    below.className = "heavy";
    for (let i = 0; i < 40; i++) below.appendChild(document.createElement("img"));
    const content = root()!.querySelector<HTMLElement>("[data-sheet-content]")!;
    content.dataset.box = "content";
    content.appendChild(below);

    rerender(<Sheet leaving />);
    expect(root()!.style.visibility).toBe("hidden");
    const copy = layer()!.querySelector<HTMLElement>(".sheet-morph-clone")!;
    expect(copy).not.toBeNull();
    expect(copy.inert).toBe(true);
    // Copie légère : le bloc hors de l'écran n'y est qu'un vide de la même hauteur, sans ses images.
    const hole = copy.querySelector<HTMLElement>(".heavy")!;
    expect(hole.children.length).toBe(0);
    expect(hole.style.height).toBe("600px");
    // La copie ne bouge pas (le contenu s'efface sur place) ; son fond, à part, redescend sous
    // l'image jusque sous l'écran, et la fenêtre revole vers l'affiche — sans attendre de décodage.
    expect(copy.style.backgroundColor).toBe("transparent");
    expect(live(copy).some((a) => /translateY/.test(String(a.frames.at(-1)!.transform)))).toBe(false);
    const win = copy.previousElementSibling as HTMLElement;
    const shell = win.previousElementSibling as HTMLElement;
    const down = live(shell).find((a) => /translateY/.test(String(a.frames.at(-1)!.transform)))!;
    expect(down.frames[0].transform).toBe("translateY(0.00px)");
    expect(down.frames.at(-1)!.transform).toBe("translateY(804.00px)");
    expect(live(win).length).toBeGreaterThan(0);
    expect(live(win).every((a) => !a.paused)).toBe(true);
    expect(sheetMorphForTests.flights()).toBe(1);
    expect(poster.style.opacity).toBe("0");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // Le relais : l'affiche reparaît sous la fenêtre, qui s'efface par-dessus — puis le calque part.
    expect(poster.style.opacity).toBe("");
    expect(copy.isConnected).toBe(false);
    act(() => fake.created.filter((a) => a.frames.length === 2 && a.frames[1].opacity === 0 && a.onfinish).forEach((a) => a.finish()));
    expect(layer()).toBeNull();
    expect(sheetMorphForTests.flights()).toBe(0);
  });

  it("sans affiche à l'écran, descend un peu en s'effaçant", async () => {
    const poster = addPoster();
    press(poster.querySelector("img")!);
    const { rerender } = render(<Sheet />);
    await runOpen();
    BOXES.poster = { x: 20, y: 2000, w: 110, h: 165 };
    try {
      rerender(<Sheet leaving />);
      const copy = layer()!.querySelector<HTMLElement>(".sheet-morph-clone")!;
      const out = live(copy)[0];
      expect(out.frames.at(-1)).toMatchObject({ opacity: 0, transform: "translateY(48px)" });
      expect(layer()!.querySelectorAll("img[src='https://img.test/poster.jpg']").length).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(layer()).toBeNull();
      expect(poster.style.opacity).toBe("");
    } finally {
      BOXES.poster = { x: 20, y: 500, w: 110, h: 165 };
    }
  });

  it("l'échange d'un coup quand ce qu'elle découvre n'est pas dessiné", async () => {
    const poster = addPoster();
    press(poster.querySelector("img")!);
    const { rerender } = render(<Sheet instantExit />);
    await runOpen();
    rerender(<Sheet instantExit leaving />);
    expect(layer()).toBeNull();
    expect(root()!.style.visibility).toBe("hidden");
    expect(poster.style.opacity).toBe("");
  });

  it("au relâchement du doigt (le geste), avale le clic qui suit", async () => {
    press(addPoster().querySelector("img")!);
    const { rerender } = render(<Sheet />);
    await runOpen();
    const banner = root()!.querySelector("[data-box='banner']")!;
    fireEvent.pointerDown(banner, { pointerId: 2, clientY: 100 });
    fireEvent.pointerMove(banner, { pointerId: 2, clientY: 200, buttons: 1 });
    fireEvent.pointerUp(banner, { pointerId: 2, clientY: 300 });
    rerender(<Sheet leaving />);
    const underneath = vi.fn();
    const other = addPoster("other");
    other.addEventListener("click", underneath);
    fireEvent.click(other);
    expect(underneath).not.toHaveBeenCalled();
  });

  it("à la croix, ne retient aucun clic", async () => {
    press(addPoster().querySelector("img")!);
    const { rerender } = render(<Sheet />);
    await runOpen();
    fireEvent.click(root()!.querySelector("[data-sheet-glass]")!);
    rerender(<Sheet leaving />);
    const next = vi.fn();
    const other = addPoster("other");
    other.addEventListener("click", next);
    fireEvent.click(other);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("démontée par un retour du navigateur : la même fermeture que la croix, vers l'affiche", async () => {
    const poster = addPoster();
    press(poster.querySelector("img")!);
    const { unmount } = render(<Sheet />);
    await runOpen();
    window.dispatchEvent(new PopStateEvent("popstate"));
    unmount();
    expect(sheetMorphForTests.flights()).toBe(1);
    expect(layer()!.querySelector(".sheet-morph-clone")).not.toBeNull();
    expect(poster.style.opacity).toBe("0");
    // Le drapeau du retour retombe à l'image suivante : la laisser passer, pour les tests d'après.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  });

  it("démontée sans fermeture, rend tout : calque parti, affiche rendue", async () => {
    const poster = addPoster();
    press(poster.querySelector("img")!);
    const { unmount } = render(<Sheet />);
    await runOpen();
    unmount();
    expect(layer()).toBeNull();
    expect(poster.style.opacity).toBe("");
  });
});

describe("l'interruption", () => {
  it("une autre affiche touchée pendant le retour : il est coupé, la nouvelle fiche part aussitôt", async () => {
    const poster = addPoster();
    press(poster.querySelector("img")!);
    const first = render(<Sheet />);
    await runOpen();
    first.rerender(<Sheet leaving />);
    first.unmount();
    expect(sheetMorphForTests.flights()).toBe(1);

    const other = addPoster("other");
    press(other.querySelector("img")!);
    render(<Sheet />);
    // L'ancien retour est coupé : son affiche reparaît, sa copie est partie ; la nouvelle fiche vole.
    expect(sheetMorphForTests.flights()).toBe(0);
    expect(poster.style.opacity).toBe("");
    expect(document.body.querySelectorAll(".sheet-morph-clone").length).toBe(0);
    expect(other.style.opacity).toBe("0");
  });

  it("la même affiche retouchée : le retour se retourne en ouverture, d'où il en était", async () => {
    const poster = addPoster();
    press(poster.querySelector("img")!);
    const first = render(<Sheet />);
    await runOpen();
    first.rerender(<Sheet leaving />);
    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    press(poster.querySelector("img")!);
    render(<Sheet />);
    expect(sheetMorphForTests.flights()).toBe(0);
    // Toujours cachée : la fiche en repart. Et la fenêtre ne repart pas de la carte : sa première
    // image est le point où en était le retour, plus grand que l'affiche.
    expect(poster.style.opacity).toBe("0");
    // La fenêtre (l'élément qui porte les deux images), au-dessus du fond de la carte.
    const win = layer()!.querySelector("img")!.parentElement!.parentElement!.parentElement as HTMLElement;
    const firstFrame = live(win).find((a) => a.frames[0].transform)!.frames[0].transform as string;
    // Le fond de la carte repart d'où le retour l'avait laissé, pas du bas de l'écran.
    const shell = win.previousElementSibling as HTMLElement;
    const rise = live(shell).find((a) => /translateY/.test(String(a.frames[0].transform)))!;
    expect(rise.frames[0].transform).not.toBe("translateY(804.00px)");
    const sx = Number(/scale\(([\d.]+),/.exec(firstFrame)![1]);
    expect(sx).toBeGreaterThan(BOXES.poster.w / BOXES.banner.w + 0.01);
  });
});

describe("le bureau", () => {
  it("l'accueil recule d'un rien derrière la première fiche, et revient avec la fermeture", async () => {
    const home = document.createElement("div");
    home.dataset.sheetHome = "";
    home.dataset.box = "home";
    document.body.appendChild(home);
    const poster = addPoster();
    home.appendChild(poster);
    press(poster.querySelector("img")!);
    const { rerender } = render(<Sheet layout="desktop" />);
    expect(live(home).at(-1)!.frames.at(-1)!.transform).toBe("scale(0.98000)");
    // Au bureau, la fiche entière est transparente le temps du trajet.
    expect(root()!.style.backgroundColor).toBe("transparent");
    await runOpen();
    // Ce que l'animation tient à la fin (les fausses animations ne touchent pas aux styles calculés).
    home.style.transform = "matrix(0.98, 0, 0, 0.98, 0, 0)";
    rerender(<Sheet layout="desktop" leaving />);
    expect(live(home).at(-1)!.frames.at(-1)!.transform).toBe("scale(1.00000)");
  });
});
