// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";

afterEach(() => cleanup());

/** Fait comme si l'image venait d'arriver, avec ses dimensions naturelles. */
function arrives(img: HTMLImageElement, width: number, height: number) {
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  act(() => { img.dispatchEvent(new Event("load")); });
}

const logo = (alt: string) => screen.getByAltText(alt) as HTMLImageElement;

describe("le logo d'un titre", () => {
  /**
   * La hauteur dépend de la forme du logo, et la forme ne se connaît qu'une fois l'image
   * chargée : affiché tout de suite, il paraissait à la hauteur par défaut puis se corrigeait
   * sous les yeux — un sursaut de quelques millisecondes, mais bien visible.
   */
  it("ne se montre pas avant de connaître sa forme", () => {
    render(<CinemaLogo src="/a.png" alt="Un film" surface="sheet" />);
    expect(logo("Un film").style.opacity).toBe("0");

    arrives(logo("Un film"), 800, 200);
    expect(logo("Un film").style.opacity).toBe("1");
  });

  it("donne moins de hauteur à un logo long qu'à un logo empilé", () => {
    render(<CinemaLogo src="/long.png" alt="Long" surface="sheet" />);
    arrives(logo("Long"), 900, 150); // ratio 6 — une ligne très longue
    const long = parseInt(logo("Long").style.maxHeight, 10);

    cleanup();
    render(<CinemaLogo src="/carre.png" alt="Carré" surface="sheet" />);
    arrives(logo("Carré"), 374, 248); // ratio 1,5 — empilé
    const stacked = parseInt(logo("Carré").style.maxHeight, 10);

    expect(stacked).toBeGreaterThan(long);
  });

  /** Repasser sur un titre déjà vu ne doit plus rien faire attendre. */
  it("se souvient d'une forme déjà mesurée", () => {
    render(<CinemaLogo src="/vu.png" alt="Vu" surface="sheet" />);
    arrives(logo("Vu"), 800, 200);
    const measured = logo("Vu").style.maxHeight;
    cleanup();

    render(<CinemaLogo src="/vu.png" alt="Vu" surface="sheet" />);
    expect(logo("Vu").style.opacity).toBe("1");
    expect(logo("Vu").style.maxHeight).toBe(measured);
  });

  it("s'aligne au bord de sa colonne, et non au centre d'une boîte étirée", () => {
    render(<CinemaLogo src="/b.png" alt="Bord" surface="hero" />);
    expect(logo("Bord").className).toContain("self-start");
  });
});
