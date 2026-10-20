// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import {
  GRID_CHUNK_ATTR,
  ROWS_PER_CHUNK,
  chunkCardsOf,
  chunkList,
  chunkRowsIn,
  firstGridCard,
  gridCards,
  gridColumnsFor,
} from "@/lib/gridChunks";
import { PINNED_FIRST, useDecodeAhead } from "@/lib/useDecodeAhead";
import { useMeasuredCardHeight } from "@/lib/useMeasuredCardHeight";
import { usePanelArrowNav } from "@/lib/usePanelArrowNav";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false }));
vi.mock("@/lib/cinemaRoute", () => ({
  cinemaClose: vi.fn(),
  cinemaNavigate: vi.fn(),
  openLibraryTitle: vi.fn(),
  useCinemaRoute: () => ({ film: null, serie: null, discover: null, person: null }),
}));
vi.mock("@/components/PosterImage", () => ({ PosterImage: ({ alt }: { alt: string }) => <span>{alt}</span> }));

import { CinemaBrowseSheet } from "@/components/cinema/CinemaBrowseSheet";
import { BROWSE_ALL } from "@/lib/cinemaBrowse";

/**
 * La grille complète en paquets de rangées (13/10/2026). Sur l'iPhone de Louis, « Tous les films »
 * (800 cartes en `content-visibility: auto`, enfants d'une seule grille) faisait des images de 120 à
 * 133 ms en remontant près du haut : une rangée qui changeait d'état relançait la mise en page des
 * huit cents. Chaque paquet est désormais sa propre grille, de rangées entières.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("les colonnes, calculées comme la feuille de style les poserait", () => {
  it("les paliers sous 1 280 px, `auto-fill` à 9,5 rem au-delà", () => {
    expect(gridColumnsFor(390, 358)).toBe(3);
    expect(gridColumnsFor(700, 668)).toBe(4);
    expect(gridColumnsFor(800, 700)).toBe(5);
    expect(gridColumnsFor(1100, 900)).toBe(6);
    // 1 376 px de grille (1 440 moins les marges) : (1 376 + 12) / (152 + 12) = 8,46.
    expect(gridColumnsFor(1440, 1376)).toBe(8);
    // Juste huit colonnes et sept écarts : huit, pas sept sur un arrondi.
    expect(gridColumnsFor(1440, 8 * 152 + 7 * 12)).toBe(8);
    expect(gridColumnsFor(1440, 8 * 152 + 7 * 12 - 1)).toBe(7);
    expect(gridColumnsFor(2560, 1920)).toBe(11);
  });
});

describe("chunkList", () => {
  it("chaque paquet sauf le dernier tient un nombre entier de rangées, et rien ne se perd", () => {
    for (const columns of [3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      for (const n of [1, 25, 28, 212, 800]) {
        const items = Array.from({ length: n }, (_, i) => i);
        const chunks = chunkList(items, columns);
        // Une rangée incomplète au milieu de la liste serait un trou dans la grille.
        for (const chunk of chunks.slice(0, -1)) expect(chunk.length).toBe(columns * ROWS_PER_CHUNK);
        expect(chunks.flat()).toEqual(items);
      }
    }
  });
});

describe("la grille complète est faite de paquets", () => {
  const film = (id: number) => ({
    id, title: `Titre ${id}`, year: 2000, genres: ["Drame"], addedAt: null, imdbRating: null, runtimeMinutes: 100, posterUrl: null,
  });

  it("800 films sur un téléphone : des paquets de 24 cartes à trois colonnes, puis le reste", async () => {
    vi.stubGlobal("innerWidth", 390);
    const items = Array.from({ length: 800 }, (_, i) => film(i + 1));
    render(
      <CinemaBrowseSheet genre={BROWSE_ALL} mediaType="movies" items={items} genres={[]} idOf={(i) => i.id} posterOf={() => null} libraryIdOf={(i) => i.id} />
    );
    // Le reste après l'entrée (240 ms, `ENTRY_SETTLE_MS`) : l'attente par défaut (1 s) ne suffit plus
    // à jsdom chargé.
    await screen.findByText("Titre 800", undefined, { timeout: 15_000 });
    const root = document.querySelector(".grid-chunks") as HTMLElement;
    const chunks = [...root.children] as HTMLElement[];
    expect(chunks.every((c) => c.hasAttribute(GRID_CHUNK_ATTR))).toBe(true);
    expect(chunks).toHaveLength(Math.ceil(800 / 24));
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.children).toHaveLength(24);
      expect(chunk.getAttribute(GRID_CHUNK_ATTR)).toBe("3");
      expect(chunk.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
      expect(chunk.style.getPropertyValue("--rows")).toBe("8");
      expect(chunk.className).toContain("grid-chunk");
      expect(chunk.className).toContain("grid-hover-zoom");
    }
    // 800 = 33 × 24 + 8 : le dernier paquet a trois rangées, la dernière incomplète — en fin de liste.
    expect(chunks[chunks.length - 1].style.getPropertyValue("--rows")).toBe("3");
    // L'ordre de la liste est celui des cartes.
    expect(gridCards(root).map((c) => c.textContent)).toEqual(items.map((i) => `Titre ${i.id}2000`));
    // Huit cents cartes rendues dans jsdom : ~1 s seul, et plus de 5 s quand la machine est chargée
    // (agents et construction de l'image en même temps, 19/10/2026) — le délai par défaut faisait
    // échouer la construction sans rien dire de la grille.
  }, 30_000);

  it("à 1 100 px, six colonnes : des paquets de 48", async () => {
    vi.stubGlobal("innerWidth", 1100);
    const items = Array.from({ length: 100 }, (_, i) => film(i + 1));
    render(
      <CinemaBrowseSheet genre={BROWSE_ALL} mediaType="movies" items={items} genres={[]} idOf={(i) => i.id} posterOf={() => null} libraryIdOf={(i) => i.id} />
    );
    await screen.findByText("Titre 100", undefined, { timeout: 15_000 });
    const chunks = [...(document.querySelector(".grid-chunks") as HTMLElement).children];
    expect(chunks.map((c) => c.children.length)).toEqual([48, 48, 4]);
  });

  it("la feuille de style : le paquet et ses cartes sautés, l'agrandissement au survol non rogné", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toMatch(/\.grid-chunk \{\s*content-visibility: auto;/);
    expect(css).toMatch(/\.grid-chunk > \* \{\s*content-visibility: auto;/);
    expect(css).toMatch(/\.grid-chunk\.grid-hover-zoom \{\s*padding: 6px;\s*margin: -6px;/);
  });
});

/** `chunks` paquets de `ROWS_PER_CHUNK` rangées de `columns` cartes, marqués comme dans la vraie grille. */
function chunkDom(chunks: number, columns = 3) {
  const per = columns * ROWS_PER_CHUNK;
  return Array.from({ length: chunks }, (_, c) => (
    <div key={c} data-grid-chunk={columns} data-testid={`chunk${c}`}>
      {Array.from({ length: per }, (_, i) => (
        <button key={i} data-nav-item data-testid={`card${c * per + i}`} style={{ padding: 0, border: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- le banc reproduit ce que le crochet lit : une balise, un `src`. */}
          <img src={`/${c * per + i}.png`} alt="" />
        </button>
      ))}
    </div>
  ));
}

describe("gridCards, firstGridCard, chunkRowsIn", () => {
  it("trouvent les cartes au fond des paquets, et les enfants d'une grille d'un seul tenant", () => {
    render(<div data-testid="root">{chunkDom(2)}</div>);
    const root = screen.getByTestId("root");
    expect(gridCards(root)).toHaveLength(48);
    expect(gridCards(root)[24]).toBe(screen.getByTestId("card24"));
    expect(firstGridCard(root)).toBe(screen.getByTestId("card0"));
    cleanup();
    const flat = render(<div data-testid="flat"><i /><b /></div>);
    expect(gridCards(flat.getByTestId("flat"))).toHaveLength(2);
    expect(firstGridCard(flat.getByTestId("flat"))?.tagName).toBe("I");
  });

  it("les rangées d'un paquet que la marge recouvre", () => {
    render(<div>{chunkDom(1)}</div>);
    const chunk = screen.getByTestId("chunk0");
    // Huit rangées de 100 px ; la marge couvre de 150 à 420 : rangées 1 à 4.
    expect(chunkRowsIn(chunk, { top: 0, height: 800 }, { top: 150, bottom: 420 })).toEqual([1, 5]);
    expect(chunkCardsOf(chunk, [1, 5]).map((c) => c.getAttribute("data-testid"))).toEqual(
      Array.from({ length: 12 }, (_, i) => `card${i + 3}`)
    );
    // Entièrement dedans, et pas encore de boîte.
    expect(chunkRowsIn(chunk, { top: 0, height: 800 }, { top: 0, bottom: 800 })).toEqual([0, 8]);
    expect(chunkRowsIn(chunk, { top: 0, height: 0 }, { top: 0, bottom: 0 })).toEqual([0, 8]);
  });
});

type Cb = (entries: { isIntersecting: boolean; target: Element; boundingClientRect?: DOMRectReadOnly; intersectionRect?: DOMRectReadOnly }[]) => void;
let dernier: { cb: Cb; options: IntersectionObserverInit; observes: Element[] };
class FakeObserver {
  observes: Element[] = [];
  constructor(public cb: Cb, public options: IntersectionObserverInit) {
    dernier = this;
  }
  observe(el: Element) { this.observes.push(el); }
  unobserve(el: Element) { this.observes = this.observes.filter((e) => e !== el); }
  disconnect() {}
}
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRectReadOnly;

describe("le décodage anticipé dans une grille en paquets", () => {
  let decodes: string[];
  beforeEach(() => {
    decodes = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    Object.defineProperty(window.Image.prototype, "decode", {
      configurable: true,
      value: function (this: HTMLImageElement) {
        decodes.push(this.getAttribute("src") ?? "");
        return Promise.resolve();
      },
    });
  });

  function Grille({ chunks }: { chunks: number }) {
    const grid = useRef<HTMLDivElement>(null);
    useDecodeAhead(grid, chunks);
    return <div ref={grid}>{chunkDom(chunks)}</div>;
  }

  /**
   * Un paquet sauté ne met pas ses cartes en page : l'observateur n'en voit aucune. Mesuré dans
   * WebKit le 13/10/2026 — 24 cartes « proches » au lieu de 45 en haut de la grille, plus d'avance.
   */
  it("suit les paquets, rangée par rangée, et chauffe les cartes des rangées dans la marge", () => {
    render(<Grille chunks={3} />);
    expect(dernier.observes.map((e) => e.getAttribute("data-testid"))).toEqual(["chunk0", "chunk1", "chunk2"]);
    expect(dernier.options.threshold).toHaveLength(ROWS_PER_CHUNK * 2 + 1);
    // Le paquet 1 entre par le haut de la marge : ses deux premières rangées.
    dernier.cb([{ isIntersecting: true, target: screen.getByTestId("chunk1"), boundingClientRect: rect(4000, 800), intersectionRect: rect(4000, 200) }]);
    expect(decodes).toEqual(["/24.png", "/25.png", "/26.png", "/27.png", "/28.png", "/29.png"]);
    // Il avance d'une rangée : la troisième seulement est demandée.
    dernier.cb([{ isIntersecting: true, target: screen.getByTestId("chunk1"), boundingClientRect: rect(3900, 800), intersectionRect: rect(3900, 300) }]);
    expect(decodes.slice(6)).toEqual(["/30.png", "/31.png", "/32.png"]);
  });

  it("tient les PINNED_FIRST premières cartes de la liste, à cheval sur deux paquets", () => {
    render(<Grille chunks={12} />);
    const all = rect(0, 800);
    // Toute la grille parcourue, paquet par paquet…
    for (let c = 0; c < 12; c++) dernier.cb([{ isIntersecting: true, target: screen.getByTestId(`chunk${c}`), boundingClientRect: all, intersectionRect: all }]);
    expect(decodes).toHaveLength(12 * 24);
    // … puis le retour en haut : le premier paquet et les deux premières rangées du second.
    expect(PINNED_FIRST).toBe(28);
    dernier.cb([{ isIntersecting: true, target: screen.getByTestId("chunk0"), boundingClientRect: all, intersectionRect: all }]);
    dernier.cb([{ isIntersecting: true, target: screen.getByTestId("chunk1"), boundingClientRect: rect(0, 800), intersectionRect: rect(0, 200) }]);
    // Les 28 premières (24 + 4) sont restées tenues ; seules les deux suivantes, lâchées par la borne,
    // sont redemandées.
    expect(decodes.slice(12 * 24)).toEqual(["/28.png", "/29.png"]);
  });
});

describe("la hauteur mesurée dans une grille en paquets", () => {
  it("lit la première carte du premier paquet, et l'écrit sur la grille", () => {
    let observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(el: Element) { observed.push(el); }
        disconnect() { observed = []; }
      }
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ height: 224.75, width: 109, top: 0, left: 0, right: 109, bottom: 224.75, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    );
    function Grille() {
      const grid = useRef<HTMLDivElement>(null);
      useMeasuredCardHeight(grid, 1);
      return <div ref={grid} data-testid="root">{chunkDom(2)}</div>;
    }
    render(<Grille />);
    expect(observed).toEqual([screen.getByTestId("card0")]);
    expect(screen.getByTestId("root").style.getPropertyValue("--card-h")).toBe("224.75px");
  });
});

describe("les flèches passent d'un paquet à l'autre", () => {
  it("la dernière rangée d'un paquet descend sur la première du suivant, et remonte", () => {
    Element.prototype.scrollIntoView = vi.fn();
    // Une géométrie de grille : trois colonnes de 110 px, des rangées de 250 px, sans écart entre les
    // paquets autre que celui d'une rangée — ce que dessine la vraie grille.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const i = Number(this.getAttribute("data-testid")?.replace("card", ""));
      const row = Math.floor(i / 3);
      const col = i % 3;
      return { top: row * 250, left: col * 120, width: 110, height: 226, right: col * 120 + 110, bottom: row * 250 + 226, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    function Panneau() {
      const ref = useRef<HTMLDivElement>(null);
      usePanelArrowNav(ref);
      return <div ref={ref} data-testid="panel">{chunkDom(2)}</div>;
    }
    render(<Panneau />);
    const panel = screen.getByTestId("panel");
    // Carte 22 : huitième rangée du premier paquet, colonne du milieu.
    screen.getByTestId("card22").focus();
    fireEvent.keyDown(panel, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("card25"));
    fireEvent.keyDown(panel, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("card22"));
    // À droite au bout d'une rangée : la touche est rendue, pas de saut vers le paquet suivant.
    screen.getByTestId("card23").focus();
    fireEvent.keyDown(panel, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("card23"));
  });
});

// Garde contre un retour à la grille d'un seul tenant dans la feuille complète.
describe("la feuille complète passe par les paquets", () => {
  it("BrowseGrid découpe la liste et suit ses colonnes", () => {
    const src = readFileSync("src/components/cinema/CinemaBrowseSheet.tsx", "utf8");
    expect(src).toMatch(/useGridColumns\(gridRef\)/);
    expect(src).toMatch(/chunkList\(items, columns\)/);
    expect(src).not.toMatch(/className="player-grid grid-hover-zoom/);
  });
});
