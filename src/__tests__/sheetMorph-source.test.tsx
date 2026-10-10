// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent } from "@testing-library/react";
import { forgetPress, installPressTracker, peekPress, sourceFrom, takePress } from "@/lib/sheetMorph/source";

/**
 * D'où part une fiche (DECISIONS.md §61) : le dernier appui sur une carte qui porte une image,
 * retenu au geste et repris par la fiche qui se monte dans la seconde.
 */
function card(withImage = true): HTMLButtonElement {
  const button = document.createElement("button");
  if (withImage) {
    const img = document.createElement("img");
    img.src = "https://img.test/a.jpg";
    button.appendChild(img);
  }
  document.body.appendChild(button);
  return button;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance", "Date", "setTimeout", "clearTimeout"] });
  installPressTracker();
  forgetPress();
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("le traqueur d'appuis", () => {
  it("retient un appui sur place sur une carte à image, une fois", () => {
    const c = card();
    fireEvent.pointerDown(c, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(c, { pointerId: 1, clientX: 12, clientY: 11 });
    expect(peekPress()).toBe(true);
    expect(takePress()?.control).toBe(c);
    expect(takePress()).toBeNull();
  });

  it("retient l'appui dans l'ordre que donne WebKit au toucher : pointeur tactile, touchend, puis un click « souris »", () => {
    // Relevé sur le moteur de Safari (10/10/2026) : pointerdown/pointerup en `touch`, puis touchend,
    // puis un click synthétisé dont le pointerType est `mouse` et l'identifiant différent.
    const c = card();
    const img = c.querySelector("img")!;
    fireEvent.pointerDown(img, { pointerId: 2, pointerType: "touch", clientX: 251, clientY: 552 });
    fireEvent.touchStart(img);
    fireEvent.pointerUp(img, { pointerId: 2, pointerType: "touch", clientX: 251, clientY: 552 });
    fireEvent.touchEnd(img);
    fireEvent.click(img, { clientX: 251, clientY: 552 });
    expect(takePress()?.control).toBe(c);
    expect(takePress()).toBeNull();
  });

  it("oublie un doigt qui a glissé — on faisait défiler la rangée", () => {
    const c = card();
    fireEvent.pointerDown(c, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(c, { pointerId: 1, clientX: 60, clientY: 10 });
    expect(peekPress()).toBe(false);
  });

  it("un appui sur un bouton sans image efface le précédent (la croix d'une fiche)", () => {
    fireEvent.click(card());
    expect(peekPress()).toBe(true);
    fireEvent.click(card(false));
    expect(peekPress()).toBe(false);
  });

  it("ne vaut plus rien au bout d'un moment : une fiche ouverte autrement ne part de nulle part", () => {
    fireEvent.click(card());
    vi.advanceTimersByTime(1500);
    expect(peekPress()).toBe(false);
    expect(takePress()).toBeNull();
  });

  it("Entrée sur la carte qui a le focus compte comme un appui (le clavier du bureau)", () => {
    const c = card();
    c.focus();
    fireEvent.keyDown(c, { key: "Enter" });
    expect(takePress()?.control).toBe(c);
  });

  it("une zone exclue n'est jamais une source", () => {
    const zone = document.createElement("div");
    zone.setAttribute("data-sheet-no-source", "");
    document.body.appendChild(zone);
    const c = card();
    zone.appendChild(c);
    expect(sourceFrom(c)).toBeNull();
  });
});
