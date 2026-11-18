// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useScreenKeyboard } from "@/lib/useScreenKeyboard";

/**
 * Le clavier de l'écran, pour les barres flottantes du bas (18/11/2026) : un champ de saisie actif ET la vue
 * visuelle qui a perdu au moins 120 px depuis le focus. Le cas qui comptait : le clavier qui se ferme champ
 * toujours actif (Retour d'Android, « OK » d'iOS) doit rendre la barre.
 */

class FakeViewport extends EventTarget {
  height = 800;
  width = 400;
  scale = 1;
  offsetTop = 0;
  set(height: number, scale = 1) {
    this.height = height;
    this.scale = scale;
    this.dispatchEvent(new Event("resize"));
  }
}

let vv: FakeViewport;

function Probe() {
  return <span data-testid="kb">{useScreenKeyboard() ? "ouvert" : "fermé"}</span>;
}

function setup(field: string) {
  document.body.innerHTML = "";
  render(
    <>
      <Probe />
      <div dangerouslySetInnerHTML={{ __html: field }} />
    </>
  );
}
const state = () => screen.getByTestId("kb").textContent;

beforeEach(() => {
  vv = new FakeViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("useScreenKeyboard", () => {
  it("champ actif et vue rétrécie : ouvert ; la vue regrandit, focus gardé : fermé", () => {
    setup('<input id="f" type="search" />');
    const f = document.getElementById("f") as HTMLInputElement;
    act(() => f.focus());
    expect(state()).toBe("fermé");
    act(() => vv.set(450));
    expect(state()).toBe("ouvert");
    act(() => vv.set(800));
    expect(document.activeElement).toBe(f);
    expect(state()).toBe("fermé");
    // Rouvert d'un appui sur le même champ, sans nouveau focus.
    act(() => vv.set(450));
    expect(state()).toBe("ouvert");
    act(() => f.blur());
    expect(state()).toBe("fermé");
  });

  it("d'un champ à l'autre, clavier ouvert : la référence d'avant le clavier est gardée", () => {
    setup('<input id="a" /><textarea id="b"></textarea>');
    act(() => (document.getElementById("a") as HTMLElement).focus());
    act(() => vv.set(450));
    act(() => (document.getElementById("b") as HTMLElement).focus());
    expect(state()).toBe("ouvert");
  });

  it("sans focus, la vue qui rétrécit n'est pas un clavier", () => {
    setup('<input id="f" />');
    act(() => vv.set(450));
    expect(state()).toBe("fermé");
  });

  it("une case à cocher n'ouvre pas de clavier", () => {
    setup('<input id="c" type="checkbox" />');
    act(() => (document.getElementById("c") as HTMLElement).focus());
    act(() => vv.set(450));
    expect(state()).toBe("fermé");
  });

  it("un pincement-zoom n'est pas un clavier, une barre d'outils non plus", () => {
    setup('<input id="f" />');
    act(() => (document.getElementById("f") as HTMLElement).focus());
    act(() => vv.set(450, 1.8));
    expect(state()).toBe("fermé");
    act(() => vv.set(740));
    expect(state()).toBe("fermé");
  });
});
