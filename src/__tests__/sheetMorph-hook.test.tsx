// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useSheetMorph, sheetMorphForTests, type SheetLayout } from "@/lib/sheetMorph/useSheetMorph";
import { forgetPress } from "@/lib/sheetMorph/source";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";
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
  swipe: withSwipe = false,
}: {
  layout?: SheetLayout;
  leaving?: boolean;
  revealed?: boolean;
  active?: boolean;
  instantExit?: boolean;
  /** Le geste de la vraie fiche du téléphone sur la bannière (`useSwipeToDismiss`, carte menée sans React). */
  swipe?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const morph = useSheetMorph({ layout, rootRef, imageRef: layout === "phone" ? bannerRef : rootRef, active, leaving, revealed, instantExit });
  const swipe = useSwipeToDismiss(() => {}, { card: rootRef });
  return createPortal(
    <div ref={rootRef} data-box="sheet" data-handles={String(morph.handlesEntry)} data-settled={String(morph.settled)} className="phone-sheet-frame" style={{ zIndex: 48, backgroundColor: "rgb(10, 10, 15)" }}>
      <div ref={bannerRef} data-box="banner" {...(withSwipe ? swipe.handlers : {})}>
        {/* eslint-disable-next-line @next/next/no-img-element -- la fiche de test n'a qu'une <img> nue, comme FadeInImg */}
        <img data-sheet-photo="" src="https://img.test/backdrop.jpg" alt="" />
        <div data-sheet-veil="" />
        <button type="button" data-sheet-glass="" aria-label="fermer">
          x
        </button>
        <button type="button" data-sheet-glass="" aria-label="partager">
          p
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
/** La fenêtre du trajet : l'enfant du calque qui n'est ni l'assombrissement (le premier) ni la copie. */
const windowOf = () => Array.from(layer()!.children).find((c, i) => i > 0 && !c.classList.contains("sheet-morph-clone")) as HTMLElement;
/** Le haut de la fenêtre à une image clé : sa place de base (la carte, en haut de la fiche) plus sa translation. */
const topAt = (f: Keyframe, baseY = BOXES.sheet.y) => baseY + numbers(f.transform)[1];

/** Le départ (décodage, deux images) puis tout le trajet. */
async function runOpen() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
}

/** Les nombres d'une valeur d'image clé (`translateY(…)`, `translate(…) scale(…)`). */
function numbers(v: unknown): number[] {
  return (String(v).match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
}

/** La valeur d'une piste échantillonnée à `at` (0–1), interpolée entre ses deux images clés voisines. */
function sampleAt(frames: Keyframe[], at: number, prop: string): number[] {
  const offsets = frames.map((f, i) => (typeof f.offset === "number" ? f.offset : i / (frames.length - 1)));
  let i = offsets.findIndex((o) => o >= at);
  if (i <= 0) return numbers(frames[Math.max(0, i)][prop]);
  const t = (at - offsets[i - 1]) / (offsets[i] - offsets[i - 1] || 1);
  const a = numbers(frames[i - 1][prop]);
  const b = numbers(frames[i][prop]);
  return a.map((v, k) => v + (b[k] - v) * t);
}

/** Les images dont l'adresse est dans `loaded` passent pour chargées (jsdom n'en charge aucune). */
let loaded = new Set<string>();
const naturalDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
const completeDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete");
function markLoaded(img: HTMLImageElement) {
  loaded.add(img.getAttribute("src") ?? "");
  fireEvent.load(img);
}

beforeEach(() => {
  loaded = new Set();
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get(this: HTMLImageElement) {
      return loaded.has(this.getAttribute("src") ?? "") ? 1280 : 0;
    },
  });
  Object.defineProperty(HTMLImageElement.prototype, "complete", {
    configurable: true,
    get(this: HTMLImageElement) {
      return loaded.has(this.getAttribute("src") ?? "");
    },
  });
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
  if (naturalDesc) Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", naturalDesc);
  if (completeDesc) Object.defineProperty(HTMLImageElement.prototype, "complete", completeDesc);
  cleanup();
  clearMorphLayers();
  fake.restore();
  Element.prototype.getBoundingClientRect = originalRect;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("l'ouverture", () => {
  it("part de l'affiche touchée : la carte entière grandit depuis elle, la fiche transparente, le contenu à venir", async () => {
    const poster = addPoster();
    press(poster.querySelector("img")!);
    render(<Sheet />);

    expect(root()!.dataset.handles).toBe("true");
    // Le calque est juste avant la fiche, au même plan : la colonne passe au-dessus de ce qui vole.
    expect(layer()!.nextElementSibling).toBe(root());
    expect(layer()!.style.zIndex).toBe("48");
    expect(poster.style.opacity).toBe("0");
    // La fiche transparente et immobile : la carte (son encre) est dans la fenêtre.
    expect(root()!.style.backgroundColor).toBe("transparent");
    expect(live(root()).some((a) => a.frames.some((f) => /translate/.test(String(f.transform))))).toBe(false);
    const win = windowOf();
    const inner = win.firstElementChild as HTMLElement;
    expect((inner.firstElementChild as HTMLElement).style.background).toContain("rgb(10, 10, 15)");
    // Un rayon fixe : rien d'animé qui se peigne sur le fil principal.
    expect(win.style.borderRadius).not.toBe("");
    const track = live(win)[0] as FakeAnimation;
    expect(track.frames.length).toBeGreaterThanOrEqual(61);
    // Au départ, la fenêtre (posée sur la carte) est réduite à l'affiche ; à l'arrivée, sans transformation.
    expect(topAt(track.frames[0])).toBeCloseTo(BOXES.poster.y, 0);
    expect(track.frames.at(-1)!.transform).toBe("translate(0.00px, 0.00px) scale(1.00000, 1.00000)");
    // La croix ne surgit pas pleine : elle paraît pendant le trajet.
    const glass = live(root()!.querySelector("[data-sheet-glass]"))[0] as FakeAnimation;
    expect(glass.frames[0].opacity).toBe(0);
    expect(glass.options.delay).toBeGreaterThan(0);
    expect(root()!.querySelector<HTMLElement>("[data-sheet-photo]")!.style.visibility).toBe("hidden");
    // La fenêtre porte l'affiche déjà chargée — rien n'est téléchargé pour animer.
    const posters = Array.from(layer()!.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(posters).toContain("https://img.test/poster.jpg");
    // Créées en pause ; le contenu arrive d'un bloc quand la carte est presque entière.
    const content = root()!.querySelector("[data-sheet-content]")!;
    const reveal = live(content)[0] as FakeAnimation;
    expect(reveal.paused).toBe(true);
    expect(reveal.frames[0].opacity).toBe(0);
    expect(reveal.options.delay).toBeGreaterThan(0);
    expect(reveal.options.fill).toBe("backwards");

    await runOpen();
    // Arrivée : le vrai visuel a repris la place de la fenêtre ; l'assombrissement reste.
    expect(root()!.querySelector<HTMLElement>("[data-sheet-photo]")!.style.visibility).toBe("");
    expect(root()!.style.backgroundColor).toBe("rgb(10, 10, 15)");
    expect(layer()!.querySelectorAll("img").length).toBe(0);
    expect(layer()!.children.length).toBe(1);
  });

  it("la fenêtre ne plonge jamais : son haut reste entre l'affiche et le haut de la carte", () => {
    // Audit du 10/10/2026 : la bannière, logée dans une carte qui montait à part, partait vers le bas
    // de l'écran avant de remonter (y 282 → 626 → 8).
    press(addPoster().querySelector("img")!);
    render(<Sheet />);
    const track = live(windowOf())[0] as FakeAnimation;
    for (const f of track.frames) {
      const top = topAt(f);
      expect(top).toBeLessThanOrEqual(BOXES.poster.y + 0.01);
      expect(top).toBeGreaterThanOrEqual(BOXES.sheet.y - 0.01);
    }
  });

  it("aucun rayon animé : seules des transformations et des opacités bougent", async () => {
    press(addPoster().querySelector("img")!);
    const { rerender } = render(<Sheet />);
    await runOpen();
    rerender(<Sheet leaving />);
    for (const a of fake.created) for (const f of a.frames) expect(Object.keys(f).filter((k) => k !== "offset" && k !== "transform" && k !== "opacity")).toEqual([]);
  });

  it("ce qui est sous la ligne de flottaison attend l'arrivée et un moment calme", async () => {
    press(addPoster().querySelector("img")!);
    render(<Sheet />);
    expect(root()!.dataset.settled).toBe("false");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // En plein vol : toujours pas.
    expect(root()!.dataset.settled).toBe("false");
    await runOpen();
    expect(root()!.dataset.settled).toBe("true");
  });

  it("sans trajet, tout est là d'emblée", () => {
    render(<Sheet />);
    expect(root()!.dataset.handles).toBe("false");
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

describe("le visuel de la fiche", () => {
  it("pas encore chargé : la vignette touchée vole pleine, le visuel tenu éteint par son fondu", async () => {
    press(addPoster().querySelector("img")!);
    render(<Sheet />);
    const win = windowOf();
    const posterImg = Array.from(win.querySelectorAll("img")).find((i) => i.getAttribute("src") === "https://img.test/poster.jpg")!;
    expect((live(posterImg)[0] as FakeAnimation).frames.every((f) => f.opacity === 1)).toBe(true);
    const bdImg = Array.from(win.querySelectorAll("img")).find((i) => i.getAttribute("src") === "https://img.test/backdrop.jpg")!;
    const bdFade = bdImg.parentElement!.parentElement as HTMLElement;
    expect(bdFade.style.opacity).toBe("0");
    expect(root()!.hasAttribute("data-sheet-flying")).toBe(true);
    await runOpen();
    expect(root()!.hasAttribute("data-sheet-flying")).toBe(false);
    // Jamais arrivé pendant le vol : l'affiche reste par-dessus le visuel, dans un calque à elle.
    const photo = root()!.querySelector<HTMLElement>("[data-sheet-photo]")!;
    const standIn = photo.nextElementSibling as HTMLElement;
    expect(standIn.hasAttribute("data-sheet-standin")).toBe(true);
    expect(standIn.style.backgroundImage).toContain("https://img.test/poster.jpg");
  });

  it("décodé en plein vol : il paraît en fondu pendant le trajet, et l'arrivée n'a plus rien à échanger", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((ok) => (release = ok));
    const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value(this: HTMLImageElement) {
        return this.getAttribute("src") === "https://img.test/backdrop.jpg" ? gate : Promise.resolve();
      },
    });
    try {
      press(addPoster().querySelector("img")!);
      render(<Sheet />);
      const win = windowOf();
      const bdImg = Array.from(win.querySelectorAll("img")).find((i) => i.getAttribute("src") === "https://img.test/backdrop.jpg")!;
      const bdFade = bdImg.parentElement!.parentElement as HTMLElement;
      const posterFade = (Array.from(win.querySelectorAll("img")).find((i) => i.getAttribute("src") === "https://img.test/poster.jpg")!).parentElement as HTMLElement;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(live(bdFade)).toHaveLength(0);
      await act(async () => {
        release();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(10);
      });
      const inFade = live(bdFade)[0] as FakeAnimation;
      const outFade = live(posterFade)[0] as FakeAnimation;
      expect(inFade.frames.map((f) => f.opacity)).toEqual([0, 1]);
      expect(outFade.frames.map((f) => f.opacity)).toEqual([1, 0]);
      await runOpen();
      // Ce que la fenêtre montrait (le visuel) sert de relais tant que l'image de la fiche se charge.
      const standIn = root()!.querySelector<HTMLElement>("[data-sheet-standin]");
      expect(standIn?.style.backgroundImage ?? "").toContain("backdrop.jpg");
    } finally {
      if (original) Object.defineProperty(HTMLImageElement.prototype, "decode", original);
      else delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    }
  });

  it("arrivé après le trajet : l'affiche s'efface en fondu, jamais d'un coup", async () => {
    press(addPoster().querySelector("img")!);
    render(<Sheet />);
    await runOpen();
    const photo = root()!.querySelector<HTMLImageElement>("[data-sheet-photo]")!;
    const standIn = photo.nextElementSibling as HTMLElement;
    // Pas encore chargé : jamais rendu opaque pendant qu'il se peint par bandes.
    expect(photo.style.opacity).not.toBe("1");
    markLoaded(photo);
    expect(photo.style.opacity).toBe("1");
    const fade = live(standIn)[0] as FakeAnimation;
    expect(fade.frames.map((f) => f.opacity)).toEqual([1, 0]);
    expect(fade.options.duration).toBe(300);
    expect(standIn.isConnected).toBe(true);
    act(() => fade.finish());
    expect(standIn.isConnected).toBe(false);
  });

  it("déjà chargé : l'affiche s'efface sur lui pendant le trajet", async () => {
    loaded.add("https://img.test/backdrop.jpg");
    {
      press(addPoster().querySelector("img")!);
      render(<Sheet />);
      const posterImg = Array.from(windowOf().querySelectorAll("img")).find((i) => i.getAttribute("src") === "https://img.test/poster.jpg")!;
      const posterTrack = live(posterImg)[0] as FakeAnimation;
      expect(posterTrack.frames[0].opacity).toBe(1);
      expect(posterTrack.frames.at(-1)!.opacity).toBe(0);
    }
  });

  it("une adresse qui change pendant le chargement : l'image de relais reste jusqu'au nouveau visuel chargé", async () => {
    // Fiche de série au premier lancement (Louis, iPhone, 10/10/2026) : la bannière noire, une fine
    // bande d'image en haut — un grand visuel encore en chargement, rendu opaque trop tôt.
    press(addPoster().querySelector("img")!);
    render(<Sheet />);
    await runOpen();
    const photo = root()!.querySelector<HTMLImageElement>("[data-sheet-photo]")!;
    const standIn = photo.nextElementSibling as HTMLElement;
    photo.setAttribute("src", "https://img.test/backdrop-fresh.jpg");
    await act(async () => {
      await Promise.resolve();
    });
    // Toujours rien de chargé : l'image de relais tient la bannière, le visuel reste caché.
    expect(standIn.isConnected).toBe(true);
    expect(live(standIn)).toHaveLength(0);
    expect(photo.style.opacity).not.toBe("1");
    markLoaded(photo);
    expect(photo.style.opacity).toBe("1");
    expect((live(standIn)[0] as FakeAnimation).frames.map((f) => f.opacity)).toEqual([1, 0]);
  });

  it("le visuel monté après l'arrivée : l'image de relais tient la bannière jusqu'à son chargement", async () => {
    press(addPoster().querySelector("img")!);
    render(<Sheet />);
    const photo = root()!.querySelector<HTMLImageElement>("[data-sheet-photo]")!;
    const banner = photo.parentElement!;
    await runOpen();
    // La fiche remplace son visuel par un autre élément (les données de la série arrivées).
    const fresh = document.createElement("img");
    fresh.setAttribute("data-sheet-photo", "");
    fresh.setAttribute("src", "https://img.test/series-bd.jpg");
    photo.replaceWith(fresh);
    await act(async () => {
      await Promise.resolve();
    });
    const standIn = banner.querySelector<HTMLElement>("[data-sheet-standin]")!;
    expect(standIn).not.toBeNull();
    expect(live(standIn)).toHaveLength(0);
    expect(fresh.style.opacity).not.toBe("1");
    markLoaded(fresh);
    expect(fresh.style.opacity).toBe("1");
    expect((live(standIn)[0] as FakeAnimation).frames.map((f) => f.opacity)).toEqual([1, 0]);
  });
});

describe("la fermeture", () => {
  it("la carte entière rétrécit dans l'affiche ; la copie s'efface en place ; tout part une image plus tard", async () => {
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
    expect(copy.inert).toBe(true);
    // Copie légère : le bloc hors de l'écran n'y est qu'un vide de la même hauteur, sans ses images.
    const hole = copy.querySelector<HTMLElement>(".heavy")!;
    expect(hole.children.length).toBe(0);
    expect(hole.style.height).toBe("600px");
    expect(copy.style.backgroundColor).toBe("transparent");
    // La copie ne bouge pas : seul son contenu s'efface.
    expect(live(copy).some((a) => a.frames.some((f) => "transform" in f))).toBe(false);
    const win = copy.previousElementSibling as HTMLElement;
    const back = live(win)[0] as FakeAnimation;
    // Part de la carte posée, finit réduite à l'affiche.
    expect(back.frames[0].transform).toBe("translate(0.00px, 0.00px) scale(1.00000, 1.00000)");
    expect(topAt(back.frames.at(-1)!)).toBeCloseTo(BOXES.poster.y, 0);
    // Créées en pause, dans la tâche même de la fermeture ; lancées ensemble à l'image suivante.
    expect(live(win).every((a) => a.paused && a.startTime === null)).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    const started = live(win).map((a) => a.startTime);
    expect(started.every((t) => t !== null)).toBe(true);
    expect(new Set(started).size).toBe(1);
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

  it("fermée pendant l'aller, part de la pose peinte à cet instant", async () => {
    press(addPoster().querySelector("img")!);
    const { rerender } = render(<Sheet />);
    const winTrack = live(windowOf())[0] as FakeAnimation;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(winTrack.startTime).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    const at = (performance.now() - winTrack.startTime!) / Number(winTrack.options.duration);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(1);

    rerender(<Sheet leaving />);
    const winBack = live(layer()!.querySelector<HTMLElement>(".sheet-morph-clone")!.previousElementSibling)[0] as FakeAnimation;
    const poseNow = sampleAt(winTrack.frames, at, "transform");
    const poseFrom = numbers(winBack.frames[0].transform);
    expect(poseFrom.length).toBe(poseNow.length);
    poseFrom.forEach((v, i) => expect(Math.abs(v - poseNow[i])).toBeLessThan(Math.max(2, Math.abs(poseNow[i]) * 0.02)));
    expect(winBack.frames[0].transform).not.toBe(winTrack.frames.at(-1)!.transform);
  });

  it("tirée au doigt, la carte repart d'où le doigt l'a mise — d'un bloc, visuel compris", async () => {
    press(addPoster().querySelector("img")!);
    const { rerender } = render(<Sheet />);
    await runOpen();
    root()!.style.transform = "translateY(60px)";
    rerender(<Sheet leaving />);
    const copy = layer()!.querySelector<HTMLElement>(".sheet-morph-clone")!;
    expect(copy.style.transform).toBe("translateY(60.00px)");
    const win = copy.previousElementSibling as HTMLElement;
    const back = live(win)[0] as FakeAnimation;
    expect(topAt(back.frames[0])).toBeCloseTo(BOXES.sheet.y + 60, 1);
    // Le visuel dans la fenêtre, décalé d'autant : rien ne se sépare de la carte.
    const bdImg = Array.from(win.querySelectorAll("img")).find((i) => i.getAttribute("src") === "https://img.test/backdrop.jpg")!;
    const bdTrack = live(bdImg.parentElement)[0] as FakeAnimation;
    expect(numbers(bdTrack.frames[0].transform)[1]).toBeCloseTo(60, 1);
  });

  it("tirée au doigt pendant l'aller, la carte repart de la pose de l'aller plus le doigt", async () => {
    press(addPoster().querySelector("img")!);
    const { rerender } = render(<Sheet />);
    const winTrack = live(windowOf())[0] as FakeAnimation;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(260);
    });
    const at = (performance.now() - winTrack.startTime!) / Number(winTrack.options.duration);
    root()!.style.transform = "translateY(40px)";
    rerender(<Sheet leaving />);
    const winBack = live(layer()!.querySelector<HTMLElement>(".sheet-morph-clone")!.previousElementSibling)[0] as FakeAnimation;
    const yNow = sampleAt(winTrack.frames, at, "transform")[1];
    expect(Math.abs(numbers(winBack.frames[0].transform)[1] - (yNow + 40))).toBeLessThan(2);
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

/**
 * Tout ce que la fermeture anime finit avec son trajet (06/11/2026). Filmée à 60 i/s sur l'iPhone,
 * une fermeture d'un jet (Mr. Robot vers sa vignette de « Reprendre ») posait la carte en ~100 ms
 * pendant que le contenu s'effaçait sur un plancher de 100 ms et la croix sur 200 : texte fantôme
 * au-dessus des rangées, puis la croix seule à côté de la vignette posée ; et le corps sombre de la
 * carte débordait sous elle.
 */
describe("la fermeture finit avec son trajet", () => {
  /** Ferme la fiche ouverte — à la croix, ou d'un jet du doigt sur la bannière (≈ 3 000 px/s). */
  async function close(how: "croix" | "jet") {
    press(addPoster().querySelector("img")!);
    const { rerender } = render(<Sheet />);
    await runOpen();
    if (how === "jet") {
      const banner = root()!.querySelector("[data-box='banner']")!;
      fireEvent.pointerDown(banner, { pointerId: 2, clientY: 100 });
      for (let i = 1; i <= 5; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(16);
        });
        fireEvent.pointerMove(banner, { pointerId: 2, clientY: 100 + i * 48, buttons: 1 });
      }
      fireEvent.pointerUp(banner, { pointerId: 2, clientY: 100 + 5 * 48 });
    } else {
      fireEvent.click(root()!.querySelector("[data-sheet-glass]")!);
    }
    const before = fake.created.length;
    rerender(<Sheet leaving />);
    const created = fake.created.slice(before).filter((a) => !a.cancelled);
    const copy = layer()!.querySelector<HTMLElement>(".sheet-morph-clone")!;
    const win = copy.previousElementSibling as HTMLElement;
    const track = live(win)[0] as FakeAnimation;
    return { created, copy, win, track, flight: Number(track.options.duration) };
  }

  const endOf = (a: FakeAnimation) => Number(a.options.delay ?? 0) + Number(a.options.duration ?? 0);
  const fresh = () => {
    cleanup();
    clearMorphLayers();
    document.body.innerHTML = "";
  };
  /** Où en est le trajet à `at` (0–1) : la largeur de la fenêtre va linéairement de la carte à l'affiche. */
  const progressAt = (track: FakeAnimation, at: number) => {
    const sx = sampleAt(track.frames, at, "transform")[2];
    return (BOXES.sheet.w - sx * BOXES.sheet.w) / (BOXES.sheet.w - BOXES.poster.w);
  };

  it("un jet du doigt raccourcit le trajet — et rien ne lui survit, ni ne traîne derrière la carte", async () => {
    const croix = await close("croix");
    fresh();
    const jet = await close("jet");
    // Le geste a bien réglé l'allure : le cas filmé, pas celui de la croix.
    expect(jet.flight).toBeLessThan(croix.flight * 0.75);
    // Une affiche toute proche de la carte (celle de la bannière d'accueil) : un trajet court.
    fresh();
    BOXES.poster = { x: 20, y: 60, w: 160, h: 240 };
    let court: Awaited<ReturnType<typeof close>>;
    try {
      court = await close("jet");
    } finally {
      BOXES.poster = { x: 20, y: 500, w: 110, h: 165 };
    }
    for (const { created, flight } of [croix, jet, court]) {
      // Le trajet, l'assombrissement, le contenu, le verre, le corps de la carte : tout.
      expect(created.length).toBeGreaterThanOrEqual(6);
      for (const a of created) expect(endOf(a)).toBeLessThanOrEqual(flight + 0.01);
    }
    // Et en distance : le contenu est parti aux trois quarts du chemin, le verre avant la fin.
    for (const { copy, track, flight } of [croix, jet]) {
      const content = live(copy.querySelector("[data-sheet-content]"))[0] as FakeAnimation;
      expect(progressAt(track, endOf(content) / flight)).toBeLessThanOrEqual(0.75);
      const glass = fake.created.filter((a) => !a.cancelled && a.target.closest?.(".sheet-morph-clone") === copy && a.target !== copy && a.target !== content.target);
      expect(glass.length).toBeGreaterThan(0);
      for (const g of glass) expect(progressAt(track, endOf(g) / flight)).toBeLessThanOrEqual(0.95);
    }
  });

  it("le contenu part avec la carte : accroché au coin haut gauche de la fenêtre, effacé avant mi-chemin", async () => {
    for (const how of ["croix", "jet"] as const) {
      fresh();
      const { copy, track, flight } = await close(how);
      const el = copy.querySelector<HTMLElement>("[data-sheet-content]")!;
      const anims = live(el);
      // Un seul élément animé pour tout le bloc.
      expect(anims).toHaveLength(1);
      const content = anims[0] as FakeAnimation;
      expect(content.frames.length).toBeLessThanOrEqual(track.frames.length);
      expect(content.frames[0].opacity).toBe(1);
      expect(content.frames.at(-1)!.opacity).toBe(0);
      // Parti avant que la carte ait fait la moitié du chemin — et déjà bien entamé au quart.
      expect(progressAt(track, endOf(content) / flight)).toBeLessThanOrEqual(0.55);
      const quarter = content.frames.find((f) => progressAt(track, (Number(f.offset) * endOf(content)) / flight) >= 0.25)!;
      expect(Number(quarter.opacity)).toBeLessThanOrEqual(0.6);
      // L'origine : le coin haut gauche de la fenêtre au départ (la carte), dans la boîte du bloc.
      const { sheet } = BOXES;
      expect(numbers(el.style.transformOrigin)).toEqual([sheet.x, sheet.y]);
      // À chaque image clé, le bloc est translaté avec le coin haut gauche de la fenêtre au même
      // instant, et mis à l'échelle de sa largeur : il ne peut pas rester derrière elle.
      for (const f of content.frames) {
        const t = (Number(f.offset) * endOf(content)) / flight;
        const [tx, ty, sx] = sampleAt(track.frames, t, "transform");
        const [dx, dy, s] = numbers(f.transform);
        expect(Math.abs(tx - dx)).toBeLessThan(1.5);
        expect(Math.abs(ty - dy)).toBeLessThan(1.5);
        expect(Math.abs(sx - s)).toBeLessThan(0.01);
      }
    }
  });

  it("la croix et le partage voyagent d'un bloc avec le coin haut droit de la carte, et s'effacent avant l'arrivée", async () => {
    for (const how of ["croix", "jet"] as const) {
      fresh();
      const { copy, track, flight } = await close(how);
      const rides = copy.querySelectorAll("[data-sheet-glass-ride]");
      expect(rides.length).toBe(1);
      const ride = rides[0] as HTMLElement;
      // Les deux boutons dans l'enveloppe, et elle seule animée.
      expect(ride.querySelectorAll("[data-sheet-glass]").length).toBe(2);
      for (const b of Array.from(ride.querySelectorAll("[data-sheet-glass]"))) expect(live(b)).toHaveLength(0);
      const anim = live(ride)[0] as FakeAnimation;
      expect(anim.frames[0].opacity).toBe(1);
      expect(anim.frames.at(-1)!.opacity).toBe(0);
      expect(endOf(anim)).toBeLessThan(flight);
      // À chaque image clé, le coin de l'enveloppe est celui de la fenêtre au même instant.
      const { sheet } = BOXES;
      for (const f of anim.frames) {
        const t = (Number(f.offset) * endOf(anim)) / flight;
        const [tx, ty, sx] = sampleAt(track.frames, t, "transform");
        const [dx, dy] = numbers(f.transform);
        expect(Math.abs(sheet.x + tx + sx * sheet.w - (sheet.x + sheet.w + dx))).toBeLessThan(1.5);
        expect(Math.abs(sheet.y + ty - (sheet.y + dy))).toBeLessThan(1.5);
      }
    }
  });

  it("au bureau et à l'iPad, la copie entière s'efface sur le trajet, et finit avant lui", async () => {
    press(addPoster().querySelector("img")!);
    const { rerender } = render(<Sheet layout="desktop" />);
    await runOpen();
    const before = fake.created.length;
    rerender(<Sheet layout="desktop" leaving />);
    const created = fake.created.slice(before).filter((a) => !a.cancelled);
    const copy = layer()!.querySelector<HTMLElement>(".sheet-morph-clone")!;
    const flight = Number((live(copy.previousElementSibling)[0] as FakeAnimation).options.duration);
    for (const a of created) expect(endOf(a)).toBeLessThanOrEqual(flight + 0.01);
    const out = live(copy)[0] as FakeAnimation;
    // Indexée sur le trajet : les instants mêmes de la fenêtre, plus deux images clés d'horloge.
    expect(out.frames.length).toBeGreaterThan(2);
    expect(out.frames.at(-1)!.opacity).toBe(0);
  });

  it("le corps de la carte ne déborde jamais sous l'affiche une fois presque posée", async () => {
    for (const how of ["croix", "jet"] as const) {
      fresh();
      const { track } = await close(how);
      const { sheet, poster } = BOXES;
      let checked = 0;
      for (const f of track.frames) {
        const [, ty, sx, sy] = numbers(f.transform);
        // La largeur va linéairement de la carte à l'affiche : elle dit où en est le trajet.
        const q = (sheet.w - sx * sheet.w) / (sheet.w - poster.w);
        if (q < 0.85) continue;
        checked++;
        expect(sheet.y + ty + sy * sheet.h).toBeLessThanOrEqual(poster.y + poster.h + 0.5);
      }
      expect(checked).toBeGreaterThan(5);
    }
  });
});

/**
 * Saisie au doigt avant l'arrivée (06/11/2026, troisième film) : la bannière restait clouée en haut de
 * l'écran pendant que le reste de la carte descendait sous le doigt — le visuel était encore dans la
 * fenêtre du trajet, qui ne suit pas la carte.
 */
describe("la fiche saisie pendant son ouverture", () => {
  for (const when of [{ label: "en plein trajet", ms: 260 }, { label: "avant même le départ", ms: 0 }]) {
    it(`${when.label} : l'ouverture finit d'un coup, et visuel et carte bougent ensemble dès le premier mouvement`, async () => {
      const poster = addPoster();
      press(poster.querySelector("img")!);
      render(<Sheet swipe />);
      markLoaded(root()!.querySelector<HTMLImageElement>("[data-sheet-photo]")!);
      if (when.ms) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(when.ms);
        });
      }
      // Le trajet n'est pas fini : le visuel est encore dans la fenêtre, la fiche transparente.
      expect(windowOf()).toBeTruthy();
      expect(root()!.style.backgroundColor).toBe("transparent");
      const banner = root()!.querySelector<HTMLElement>("[data-box='banner']")!;
      fireEvent.pointerDown(banner, { pointerId: 3, clientY: 100, pointerType: "touch", button: 0 });
      // Dès l'appui, avant tout mouvement : plus de fenêtre, la fiche rendue à elle-même, le visuel
      // dans la bannière — et seul l'assombrissement reste dans le calque, à sa valeur posée.
      expect(Array.from(layer()!.children)).toHaveLength(1);
      expect(root()!.style.backgroundColor).not.toBe("transparent");
      expect(root()!.hasAttribute("data-sheet-flying")).toBe(false);
      expect(root()!.querySelector<HTMLElement>("[data-sheet-photo]")!.style.visibility).toBe("");
      expect(root()!.querySelector<HTMLElement>("[data-sheet-photo]")!.style.opacity).toBe("1");
      // Le premier mouvement déplace la carte entière, visuel compris (il est dedans).
      fireEvent.pointerMove(banner, { pointerId: 3, clientY: 100, pointerType: "touch" });
      fireEvent.pointerMove(banner, { pointerId: 3, clientY: 160, pointerType: "touch" });
      expect(root()!.style.transform).toBe("translateY(60px)");
      expect(root()!.contains(root()!.querySelector("[data-sheet-photo]"))).toBe(true);
      // Le relais prévu pour l'arrivée ne retombe pas plus tard sur la fiche saisie.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(windowOf()).toBeUndefined();
      expect(root()!.style.transform).toBe("translateY(60px)");
      fireEvent.pointerUp(banner, { pointerId: 3, clientY: 160, pointerType: "touch" });
    });
  }

  it("après l'arrivée, saisir la fiche ne touche plus à rien", async () => {
    press(addPoster().querySelector("img")!);
    render(<Sheet swipe />);
    await runOpen();
    const before = fake.created.length;
    const banner = root()!.querySelector<HTMLElement>("[data-box='banner']")!;
    fireEvent.pointerDown(banner, { pointerId: 3, clientY: 100, pointerType: "touch", button: 0 });
    expect(fake.created.length).toBe(before);
    fireEvent.pointerUp(banner, { pointerId: 3, clientY: 100, pointerType: "touch" });
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
    expect(poster.style.opacity).toBe("0");
    // La fenêtre ne repart pas de l'affiche : sa première image est le point où en était le retour.
    const firstFrame = (live(windowOf())[0] as FakeAnimation).frames[0].transform as string;
    const sx = Number(/scale\(([\d.]+),/.exec(firstFrame)![1]);
    expect(sx).toBeGreaterThan(BOXES.poster.w / BOXES.sheet.w + 0.01);
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
