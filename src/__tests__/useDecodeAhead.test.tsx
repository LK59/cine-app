// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { useDecodeAhead } from "@/lib/useDecodeAhead";

/**
 * Le décodage anticipé des affiches : ce que le banc du 20/09/2026 a désigné comme la vraie cause
 * des à-coups de la grille complète. Ce test ne mesure rien — il vérifie le contrat : une carte
 * qui approche chauffe son affiche, une seule fois, et rien ne remonte quand `decode` échoue.
 */
type Cb = (entries: { isIntersecting: boolean; target: Element }[]) => void;
let dernier: { cb: Cb; options: IntersectionObserverInit; observes: Element[]; disconnected: boolean };

class FakeObserver {
  observes: Element[] = [];
  disconnected = false;
  constructor(public cb: Cb, public options: IntersectionObserverInit) {
    dernier = this;
  }
  observe(el: Element) { this.observes.push(el); }
  unobserve(el: Element) { this.observes = this.observes.filter((e) => e !== el); }
  disconnect() { this.disconnected = true; }
}

function Grille({ srcs }: { srcs: string[] }) {
  const grid = useRef<HTMLDivElement>(null);
  useDecodeAhead(grid, srcs.length);
  return (
    <div ref={grid}>
      {srcs.map((s, i) => (
        <div key={i} data-testid={`card${i}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- le banc d'essai reproduit
              exactement ce que le navigateur reçoit : une balise, un attribut `src`. Passer par
              `next/image` ici ne testerait plus le contrat que le crochet lit. */}
          <img src={s} alt="" />
        </div>
      ))}
    </div>
  );
}

describe("useDecodeAhead", () => {
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
  afterEach(() => vi.unstubAllGlobals());

  it("prend deux écrans et demi d'avance", () => {
    render(<Grille srcs={["/a.png"]} />);
    expect(dernier.options.rootMargin).toBe("3000px 0px");
  });

  it("chauffe l'affiche d'une carte qui approche, et continue de la suivre", () => {
    // Suivie encore : en remontant, elle doit pouvoir se rechauffer (voir le bloc suivant).
    const r = render(<Grille srcs={["/a.png", "/b.png"]} />);
    const carte = r.getByTestId("card0");
    dernier.cb([{ isIntersecting: true, target: carte }]);
    expect(decodes).toEqual(["/a.png"]);
    expect(dernier.observes).toContain(carte);
  });

  it("ne chauffe pas deux fois la même adresse", () => {
    const r = render(<Grille srcs={["/a.png", "/a.png"]} />);
    dernier.cb([{ isIntersecting: true, target: r.getByTestId("card0") }]);
    dernier.cb([{ isIntersecting: true, target: r.getByTestId("card1") }]);
    expect(decodes).toEqual(["/a.png"]);
  });

  it("ignore une carte qui sort du champ", () => {
    const r = render(<Grille srcs={["/a.png"]} />);
    dernier.cb([{ isIntersecting: false, target: r.getByTestId("card0") }]);
    expect(decodes).toEqual([]);
  });

  it("survit à un navigateur sans decode et à un décodage refusé", () => {
    Object.defineProperty(window.Image.prototype, "decode", { configurable: true, value: undefined });
    const r = render(<Grille srcs={["/a.png"]} />);
    expect(() => dernier.cb([{ isIntersecting: true, target: r.getByTestId("card0") }])).not.toThrow();
    r.unmount();

    Object.defineProperty(window.Image.prototype, "decode", {
      configurable: true,
      value: () => Promise.reject(new Error("pas d'image")),
    });
    const r2 = render(<Grille srcs={["/b.png"]} />);
    expect(() => dernier.cb([{ isIntersecting: true, target: r2.getByTestId("card0") }])).not.toThrow();
  });

  it("lâche tout au démontage", () => {
    const r = render(<Grille srcs={["/a.png"]} />);
    r.unmount();
    expect(dernier.disconnected).toBe(true);
  });
});

/**
 * Le défaut que la relecture du 20/09/2026 a trouvé, et que le nombre d'éléments cachait.
 *
 * L'effet dépendait de `items.length`. Changer le tri garde exactement le même nombre de cartes,
 * donc il ne repartait pas — et l'observateur ne suivait que les cartes de son montage : le
 * premier écran n'était plus anticipé du tout après un tri, là même où quelqu'un se remet à
 * faire défiler.
 */
describe("useDecodeAhead, quand la liste change sans changer de taille", () => {
  // Le double est posé par le `beforeEach` de l'autre bloc, qui ne s'applique pas ici : sans
  // celui-ci, le test lisait l'observateur du bloc précédent et passait pour de mauvaises raisons.
  beforeEach(() => vi.stubGlobal("IntersectionObserver", FakeObserver));
  afterEach(() => vi.unstubAllGlobals());

  function Triable({ liste }: { liste: string[] }) {
    const grid = useRef<HTMLDivElement>(null);
    useDecodeAhead(grid, liste);
    return (
      <div ref={grid}>
        {liste.map((s, i) => (
          <div key={i} data-testid={`c${i}`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- voir le banc ci-dessus. */}
            <img src={s} alt="" />
          </div>
        ))}
      </div>
    );
  }

  it("reprend les cartes après un changement de tri", () => {
    const r = render(<Triable liste={["/a.png", "/b.png"]} />);
    dernier.cb([{ isIntersecting: true, target: r.getByTestId("c0") }]);
    const premier = dernier;

    // Même nombre de cartes, contenu différent : l'observateur doit repartir de zéro.
    r.rerender(<Triable liste={["/c.png", "/d.png"]} />);
    expect(dernier).not.toBe(premier);
    expect(premier.disconnected).toBe(true);
    expect(dernier.observes).toHaveLength(2);
  });
});

/**
 * Relus le 21/09/2026, sur « Tous les films » qui saccadait dans les deux sens et jamais sur les
 * séries : l'avance mesurée contre la fenêtre valait zéro dans un panneau qui défile, et une
 * affiche chauffée une fois ne l'était plus jamais en remontant.
 */
describe("useDecodeAhead, dans un panneau qui défile", () => {
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
  afterEach(() => vi.unstubAllGlobals());

  function Panneau({ srcs }: { srcs: string[] }) {
    const grid = useRef<HTMLDivElement>(null);
    useDecodeAhead(grid, srcs);
    return (
      <div data-testid="corps" style={{ overflowY: "auto" }}>
        <div ref={grid}>
          {srcs.map((s, i) => (
            <div key={i} data-testid={`p${i}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- voir le banc ci-dessus. */}
              <img src={s} alt="" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  it("mesure l'avance contre le conteneur qui défile, pas contre la fenêtre", () => {
    const r = render(<Panneau srcs={["/a.png"]} />);
    expect(dernier.options.root).toBe(r.getByTestId("corps"));
  });

  it("garde la fenêtre quand rien ne défile au-dessus de la grille", () => {
    render(<Grille srcs={["/a.png"]} />);
    expect(dernier.options.root ?? null).toBeNull();
  });

  it("ne rechauffe pas une affiche encore tenue", () => {
    const r = render(<Panneau srcs={["/a.png"]} />);
    const carte = r.getByTestId("p0");
    dernier.cb([{ isIntersecting: true, target: carte }]);
    dernier.cb([{ isIntersecting: false, target: carte }]);
    dernier.cb([{ isIntersecting: true, target: carte }]);
    expect(decodes).toEqual(["/a.png"]);
  });

  it("rechauffe en remontant une affiche lâchée entre-temps, et n'en tient qu'un nombre borné", () => {
    const srcs = Array.from({ length: 200 }, (_, i) => `/${i}.png`);
    const r = render(<Panneau srcs={srcs} />);
    // On descend toute la grille…
    for (let i = 0; i < 200; i++) dernier.cb([{ isIntersecting: true, target: r.getByTestId(`p${i}`) }]);
    expect(decodes).toHaveLength(200);
    // …puis on remonte : la première affiche a été lâchée depuis longtemps, elle se rechauffe.
    dernier.cb([{ isIntersecting: true, target: r.getByTestId("p0") }]);
    expect(decodes).toHaveLength(201);
    expect(decodes[200]).toBe("/0.png");
    // Et la plus récente, elle, est encore tenue.
    dernier.cb([{ isIntersecting: true, target: r.getByTestId("p199") }]);
    expect(decodes).toHaveLength(201);
  });
});
