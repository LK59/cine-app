// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderHook, cleanup, render, fireEvent } from "@testing-library/react";
import { useTvGridNav } from "@/lib/useTvGridNav";
import { installEdgeScroll } from "@/lib/fireTv";
import { hoverDesignates, resetPointerTracking, trackPointer } from "@/lib/pointerHover";
import { CinemaCard } from "@/components/cinema/CinemaCard";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

/**
 * La Fire TV de Timothé en mode immersif de Silk (11/10/2026), rejouée dans jsdom.
 *
 * Ce qu'il a dit : « je ne peux pas aller vers le haut » ; « tu vas à gauche, après tu ne peux plus
 * revenir à droite… au 3e film ça ne fonctionne plus » ; « si tu switches entre les 2 modes, ça
 * fonctionne ». Ce que la scène reproduit : un curseur laissé au bord en mode curseur — c'est ainsi
 * qu'on y fait défiler —, puis la navigation spatiale, qui déplace le focus d'elle-même (`focus()`
 * sans touche) ou donne ses flèches à la page. Le défilement au bord continuait alors sous un curseur
 * immobile et invisible, contre chaque flèche.
 *
 * jsdom ne calcule aucune mise en page : la scène en tient une petite, à la main — un écran de
 * 960 × 540, une bannière en haut, un panneau de rangées qui défile verticalement, des rangées de
 * vingt affiches de 128 px qui défilent horizontalement — et `requestAnimationFrame` avance d'une
 * image de 16 ms à la demande.
 */

const W = 960;
const H = 540;
const PANE_TOP = 240;
const PANE_H = H - PANE_TOP;
const ROW_H = 272;
const RAIL = 60;
const PAD = 48;
const CARD = 128;
const STEP = 140;
const TRACK_W = 840;
const COLS = 20;

let clock = 0;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 1;

function scrollProp(el: HTMLElement, prop: "scrollLeft" | "scrollTop", max: number, initial = 0) {
  let value = initial;
  Object.defineProperty(el, prop, {
    configurable: true,
    get: () => value,
    set: (v: number) => {
      value = Math.max(0, Math.min(max, v));
    },
  });
}

type Scene = {
  pane: HTMLElement;
  rows: { root: HTMLElement; track: HTMLElement; seeAll: HTMLButtonElement; cards: HTMLButtonElement[] }[];
  hero: HTMLButtonElement;
};

function buildScene(rowCount = 3): Scene {
  const hero = document.createElement("button");
  hero.dataset.tvEscapeUp = "hero";
  hero.getBoundingClientRect = () => ({ left: 100, top: 150, width: 80, height: 40, right: 180, bottom: 190 }) as DOMRect;
  document.body.appendChild(hero);

  const pane = document.createElement("div");
  pane.style.overflowY = "auto";
  Object.defineProperty(pane, "clientHeight", { value: PANE_H });
  Object.defineProperty(pane, "scrollHeight", { value: rowCount * ROW_H + 200 });
  scrollProp(pane, "scrollTop", rowCount * ROW_H + 200 - PANE_H);
  document.body.appendChild(pane);

  const rows: Scene["rows"] = [];
  for (let r = 0; r < rowCount; r++) {
    const root = document.createElement("div");
    root.setAttribute("data-tv-rowroot", "");
    root.scrollIntoView = () => {
      pane.scrollTop = r * ROW_H;
    };
    const seeAll = document.createElement("button");
    seeAll.textContent = "Voir tout";
    seeAll.getBoundingClientRect = () => {
      const top = PANE_TOP + r * ROW_H - pane.scrollTop;
      return { left: RAIL + TRACK_W - 80, top, width: 70, height: 20, right: RAIL + TRACK_W - 10, bottom: top + 20 } as DOMRect;
    };
    root.appendChild(seeAll);
    const track = document.createElement("div");
    track.style.overflowX = "auto";
    track.style.overflowY = "hidden";
    Object.defineProperty(track, "clientWidth", { value: TRACK_W });
    Object.defineProperty(track, "scrollWidth", { value: PAD * 2 + COLS * STEP });
    Object.defineProperty(track, "clientHeight", { value: 220 });
    Object.defineProperty(track, "scrollHeight", { value: 220 });
    scrollProp(track, "scrollLeft", PAD * 2 + COLS * STEP - TRACK_W);
    const cards: HTMLButtonElement[] = [];
    for (let c = 0; c < COLS; c++) {
      const card = document.createElement("button");
      card.dataset.tvCard = "true";
      card.dataset.tvRow = `row-${r}`;
      card.dataset.tvCol = String(c);
      const x = PAD + c * STEP;
      card.getBoundingClientRect = () => {
        const left = RAIL + x - track.scrollLeft;
        const top = PANE_TOP + r * ROW_H + 40 - pane.scrollTop;
        return { left, top, width: CARD, height: 192, right: left + CARD, bottom: top + 192 } as DOMRect;
      };
      // « nearest » en largeur, comme le navigateur — instantané ici.
      card.scrollIntoView = () => {
        if (x < track.scrollLeft) track.scrollLeft = x;
        else if (x + CARD > track.scrollLeft + TRACK_W) track.scrollLeft = x + CARD - TRACK_W;
      };
      track.appendChild(card);
      cards.push(card);
    }
    root.appendChild(track);
    pane.appendChild(root);
    rows.push({ root, track, seeAll, cards });
  }
  // Sous le curseur : la rangée dont la bande contient ce point, sinon le panneau.
  document.elementFromPoint = (_x: number, y: number) => {
    const inPane = y - PANE_TOP + pane.scrollTop;
    const row = rows[Math.floor(inPane / ROW_H)];
    return y >= PANE_TOP && row ? row.track : y >= PANE_TOP ? pane : hero;
  };
  return { pane, rows, hero };
}

/** Avance le temps, image par image. */
function advance(ms: number) {
  const end = clock + ms;
  while (clock < end) {
    clock += 16;
    const due = [...frames.values()];
    frames.clear();
    for (const cb of due) cb(clock);
  }
}

function moveCursor(x: number, y: number) {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
}

/** Une flèche que la page reçoit, sur l'élément focalisé — comme le navigateur l'envoie. */
function press(key: string) {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/** L'affiche est-elle entièrement dans sa rangée, à l'écran ? */
function visibleInRow(scene: Scene, card: HTMLElement): boolean {
  const box = card.getBoundingClientRect();
  return box.left >= RAIL && box.right <= RAIL + TRACK_W;
}

let removeEdge: () => void = () => {};

beforeEach(() => {
  clock = 1000;
  frames = new Map();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: W });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: H });
  trackPointer(window);
});

afterEach(() => {
  removeEdge();
  removeEdge = () => {};
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  resetPointerTracking();
});

describe("Fire TV, mode immersif : une seule sélection, et rien qui la contredit", () => {
  it("le focus posé par Silk sans touche est celui dont la grille repart — elle n'a pas d'autre sélection", () => {
    const scene = buildScene();
    renderHook(() => useTvGridNav());
    // La navigation spatiale déplace le focus elle-même, sans flèche donnée à la page.
    scene.rows[1].cards[5].focus();
    press("ArrowRight");
    expect(document.activeElement).toBe(scene.rows[1].cards[6]);
    press("ArrowUp");
    expect(document.activeElement).toBe(scene.rows[0].cards[6]);
  });

  it("gauche ×3 puis droite : l'affiche choisie reste à l'écran, même avec le curseur laissé au bord gauche", () => {
    const scene = buildScene();
    renderHook(() => useTvGridNav());
    removeEdge = installEdgeScroll(window);
    const row = scene.rows[0];
    row.track.scrollLeft = 900;

    // Au curseur : posé au bord gauche, la rangée défile — ce que le mode curseur demande.
    moveCursor(20, PANE_TOP + 100);
    advance(400);
    expect(row.track.scrollLeft).toBeLessThan(900);

    // Bascule en mode immersif : le curseur reste là, invisible. Silk pose le focus sur une
    // affiche à l'écran, puis la page reçoit les flèches.
    row.cards[7].focus();
    for (let i = 0; i < 3; i++) {
      press("ArrowLeft");
      advance(250);
    }
    expect(document.activeElement).toBe(row.cards[4]);
    expect(visibleInRow(scene, row.cards[4])).toBe(true);

    for (let i = 0; i < 6; i++) {
      press("ArrowRight");
      advance(250);
      expect(visibleInRow(scene, document.activeElement as HTMLElement)).toBe(true);
    }
    expect(document.activeElement).toBe(row.cards[10]);
  });

  it("↑ remonte d'une rangée et y reste, même avec le curseur laissé au bord bas", () => {
    const scene = buildScene();
    renderHook(() => useTvGridNav());
    removeEdge = installEdgeScroll(window);

    moveCursor(W / 2, H - 8);
    advance(300);
    scene.rows[2].cards[0].focus();
    scene.pane.scrollTop = 2 * ROW_H;

    press("ArrowUp");
    advance(600);
    expect(document.activeElement).toBe(scene.rows[1].cards[0]);
    expect(scene.pane.scrollTop).toBe(ROW_H);

    press("ArrowUp");
    advance(600);
    expect(scene.pane.scrollTop).toBe(0);
    press("ArrowUp");
    expect(document.activeElement).toBe(scene.hero);
  });

  it("un focus déplacé par Silk, sans touche, arrête aussi le défilement au bord", () => {
    const scene = buildScene();
    removeEdge = installEdgeScroll(window);
    const row = scene.rows[0];
    row.track.scrollLeft = 900;
    moveCursor(20, PANE_TOP + 100);
    advance(400);
    const at = row.track.scrollLeft;
    row.cards[6].focus();
    advance(600);
    expect(row.track.scrollLeft).toBe(at);
  });

  it("le survol que la navigation spatiale pose au centre de l'affiche choisie n'arme rien", () => {
    const scene = buildScene();
    removeEdge = installEdgeScroll(window);
    const row = scene.rows[0];
    row.track.scrollLeft = 110;
    const card = row.cards[0];
    card.focus();
    const box = card.getBoundingClientRect();
    // Son centre est dans la bande du bord gauche (< 7 % de 960 px).
    expect(box.left + box.width / 2).toBeLessThan(W * 0.07);
    moveCursor(box.left + box.width / 2, box.top + box.height / 2);
    advance(600);
    expect(row.track.scrollLeft).toBe(110);
  });

  it("au curseur, le bord fait toujours défiler, et la boucle s'arrête au bout", () => {
    const scene = buildScene();
    removeEdge = installEdgeScroll(window);
    const row = scene.rows[0];
    moveCursor(W - 10, PANE_TOP + 100);
    advance(300);
    expect(row.track.scrollLeft).toBeGreaterThan(0);
    advance(10_000);
    expect(row.track.scrollLeft).toBe(PAD * 2 + COLS * STEP - TRACK_W);
    // Plus rien à faire défiler : plus aucune image demandée.
    expect(frames.size).toBe(0);
    // Un nouveau mouvement, ailleurs au bord, relance.
    moveCursor(10, PANE_TOP + 100);
    advance(400);
    expect(row.track.scrollLeft).toBeLessThan(PAD * 2 + COLS * STEP - TRACK_W);
  });

  it("une touche arrête le défilement au bord ; seul un curseur qui bouge le relance", () => {
    const scene = buildScene();
    removeEdge = installEdgeScroll(window);
    const row = scene.rows[0];
    moveCursor(W - 10, PANE_TOP + 100);
    advance(300);
    press("ArrowDown");
    const at = row.track.scrollLeft;
    advance(500);
    expect(row.track.scrollLeft).toBe(at);
    // Un `mousemove` au même endroit — celui que le navigateur fabrique après un défilement.
    moveCursor(W - 10, PANE_TOP + 100);
    advance(500);
    expect(row.track.scrollLeft).toBe(at);
    moveCursor(W - 12, PANE_TOP + 100);
    advance(500);
    expect(row.track.scrollLeft).toBeGreaterThan(at);
  });
});

describe("le focus dans l'intitulé d'une rangée (« Voir tout »)", () => {
  it("↓ entre dans cette rangée, à l'affiche la plus proche, au lieu de repartir en haut de l'accueil", () => {
    const scene = buildScene();
    renderHook(() => useTvGridNav());
    scene.rows[1].seeAll.focus();
    press("ArrowDown");
    // « Voir tout » est au bord droit de la rangée : l'affiche visible la plus proche.
    expect(document.activeElement).toBe(scene.rows[1].cards[5]);
  });

  it("↑ depuis l'intitulé de la première rangée va à la bannière ; depuis une autre, à la rangée du dessus", () => {
    const scene = buildScene();
    renderHook(() => useTvGridNav());
    scene.rows[0].seeAll.focus();
    press("ArrowUp");
    expect(document.activeElement).toBe(scene.hero);
    scene.rows[2].seeAll.focus();
    press("ArrowUp");
    expect(document.activeElement?.getAttribute("data-tv-row")).toBe("row-1");
  });
});

describe("un survol sans mouvement du pointeur ne désigne rien", () => {
  const movie = { radarrId: 1, jellyfinItemId: "j1", title: "Un film", posterUrl: null, addedAt: null } as unknown as CinemaMovie;

  it("la carte qui glisse sous une souris immobile ne prend pas la bannière ; une souris qui bouge, si", () => {
    const onFocusItem = vi.fn();
    const { container } = render(
      <CinemaCard item={movie} index={0} rowKey="r" widthClassName="w-32" onFocusItem={onFocusItem} onSelectItem={() => {}} />
    );
    const card = container.querySelector("button")!;
    moveCursor(300, 300);
    clock += 1000;
    // Le contenu a défilé sous la souris posée là : même position, aucun mouvement récent.
    fireEvent.mouseEnter(card, { clientX: 300, clientY: 300 });
    expect(onFocusItem).not.toHaveBeenCalled();
    // La souris arrive sur la carte : position neuve.
    fireEvent.mouseEnter(card, { clientX: 320, clientY: 300 });
    expect(onFocusItem).toHaveBeenCalledTimes(1);
  });

  it("un survol juste après un mouvement désigne, quel que soit l'ordre des évènements", () => {
    moveCursor(10, 10);
    expect(hoverDesignates({ clientX: 10, clientY: 10 })).toBe(true);
    clock += 1000;
    expect(hoverDesignates({ clientX: 10, clientY: 10 })).toBe(false);
  });

  it("un pointeur dont on ne sait rien désigne : le premier survol de la page marche", () => {
    resetPointerTracking();
    expect(hoverDesignates({ clientX: 5, clientY: 5 })).toBe(true);
  });
});
