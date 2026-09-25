// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { ROW_CARDS, useDecodeRowsAhead } from "@/lib/useDecodeAhead";

/**
 * Les rangées de l'accueil décodées d'avance (25/09/2026) : elles chargeaient chaque affiche en
 * approchant de l'écran et l'annonçaient en fondu, quand « Tous les films » paraissait tout rendre
 * d'un coup.
 */
type Cb = (entries: { isIntersecting: boolean; target: Element }[]) => void;
let dernier: { cb: Cb; options: IntersectionObserverInit; observes: Element[] };

class FakeObserver {
  observes: Element[] = [];
  constructor(public cb: Cb, public options: IntersectionObserverInit) {
    dernier = this;
  }
  observe(el: Element) {
    this.observes.push(el);
  }
  unobserve() {}
  disconnect() {}
}

let chauffes: { src: string; srcset: string; sizes: string }[];

function Accueil({ rangees }: { rangees: string[][] }) {
  const pane = useRef<HTMLDivElement>(null);
  useDecodeRowsAhead(pane);
  return (
    <div ref={pane}>
      {rangees.map((cartes, r) => (
        <section key={r} data-poster-row data-testid={`r${r}`}>
          {cartes.map((c, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- le contrat lu est celui de la balise.
            <img key={i} src={`/_next/image?url=${c}&w=3840`} srcSet={`/_next/image?url=${c}&w=256 256w, /_next/image?url=${c}&w=384 384w`} sizes="112px" alt="" />
          ))}
        </section>
      ))}
    </div>
  );
}

describe("useDecodeRowsAhead", () => {
  beforeEach(() => {
    chauffes = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    Object.defineProperty(window.Image.prototype, "decode", {
      configurable: true,
      value: function (this: HTMLImageElement) {
        chauffes.push({ src: this.getAttribute("src") ?? "", srcset: this.srcset, sizes: this.sizes });
        return Promise.resolve();
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("suit chaque rangée, deux écrans et demi d'avance", () => {
    render(<Accueil rangees={[["a"], ["b"]]} />);
    expect(dernier.observes).toHaveLength(2);
    expect(dernier.options.rootMargin).toBe(`${Math.round(window.innerHeight * 2.5)}px 0px`);
  });

  it("chauffe la variante que l'affiche chargera : mêmes srcset et sizes", () => {
    const r = render(<Accueil rangees={[["a"]]} />);
    dernier.cb([{ isIntersecting: true, target: r.getByTestId("r0") }]);
    expect(chauffes).toEqual([
      { src: "/_next/image?url=a&w=3840", srcset: "/_next/image?url=a&w=256 256w, /_next/image?url=a&w=384 384w", sizes: "112px" },
    ]);
  });

  it(`seulement les ${ROW_CARDS} premières cartes d'une rangée`, () => {
    const cartes = Array.from({ length: ROW_CARDS + 8 }, (_, i) => `c${i}`);
    const r = render(<Accueil rangees={[cartes]} />);
    dernier.cb([{ isIntersecting: true, target: r.getByTestId("r0") }]);
    expect(chauffes).toHaveLength(ROW_CARDS);
  });

  it("ne rechauffe pas ce qu'il tient déjà", () => {
    const r = render(<Accueil rangees={[["a", "b"]]} />);
    dernier.cb([{ isIntersecting: true, target: r.getByTestId("r0") }]);
    dernier.cb([{ isIntersecting: true, target: r.getByTestId("r0") }]);
    expect(chauffes).toHaveLength(2);
  });

  it("ignore une rangée qui n'approche pas", () => {
    const r = render(<Accueil rangees={[["a"]]} />);
    dernier.cb([{ isIntersecting: false, target: r.getByTestId("r0") }]);
    expect(chauffes).toEqual([]);
  });
});
