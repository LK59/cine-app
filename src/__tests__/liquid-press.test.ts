// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLiquidPress, liquidTransform, pullFrom, pullOutside, swellFor } from "@/lib/liquidGlass/liquid";

/**
 * Le geste liquide ne doit rien retirer au clic natif (DECISIONS.md §45) : c'est la garantie
 * « aucune régression » du 04/10/2026. jsdom ne mesure rien et ne fabrique pas de clic fiable :
 * les boîtes sont posées à la main, et `trusted` lit un drapeau du test.
 */

function box(el: HTMLElement, left: number, top: number, w: number, h: number) {
  el.getBoundingClientRect = () => ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(el, "offsetWidth", { value: w, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: h, configurable: true });
}

function setup() {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  const pill = document.createElement("div");
  const a = document.createElement("button");
  const b = document.createElement("button");
  a.className = b.className = "btn";
  pill.append(a, b);
  root.append(pill);
  document.body.append(root);
  box(pill, 100, 100, 100, 50);
  box(a, 104, 104, 44, 44);
  box(b, 152, 104, 44, 44);
  const onA = vi.fn();
  const onB = vi.fn();
  const onRoot = vi.fn();
  a.addEventListener("click", onA);
  b.addEventListener("click", onB);
  root.addEventListener("click", onRoot);
  const press = createLiquidPress({ targets: ".btn", trusted: (e) => (e as MouseEvent & { fromFinger?: boolean }).fromFinger === true });
  return { root, pill, a, b, onA, onB, onRoot, press };
}

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: "touch" });
function fingerClick(target: Element) {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }) as MouseEvent & { fromFinger?: boolean };
  e.fromFinger = true;
  target.dispatchEvent(e);
}

describe("le geste liquide et le clic natif", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("laisse passer tel quel le clic d'un bouton touché et relâché sur lui", () => {
    const { a, pill, onA, onRoot, press } = setup();
    const down = pointer("pointerdown", 120, 120);
    a.dispatchEvent(down);
    press.down(down, pill);
    window.dispatchEvent(pointer("pointerup", 121, 121));
    fingerClick(a);
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onRoot).toHaveBeenCalledTimes(1); // il remonte comme avant
    vi.advanceTimersByTime(1000);
    expect(onA).toHaveBeenCalledTimes(1); // et le secours ne rejoue rien
  });

  it("donne au bouton le plus proche un appui posé dans la marge, sans que le fond le reçoive", () => {
    const { pill, b, onB, onRoot, press } = setup();
    // Juste à droite de la pilule, dans les 12 px de marge, près du second bouton.
    const down = pointer("pointerdown", 206, 125);
    press.down(down, pill);
    window.dispatchEvent(pointer("pointerup", 206, 125));
    fingerClick(pill);
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onRoot).toHaveBeenCalledTimes(1); // celui du bouton, qui remonte — pas le clic natif arrêté
  });

  it("annule l'appui quand le doigt part à plus de 24 px du verre", () => {
    const { pill, a, onA, root, press } = setup();
    const down = pointer("pointerdown", 120, 120);
    press.down(down, pill);
    window.dispatchEvent(pointer("pointermove", 120, 200));
    window.dispatchEvent(pointer("pointerup", 120, 200));
    fingerClick(root);
    vi.advanceTimersByTime(1000);
    expect(onA).not.toHaveBeenCalled();
    expect(a.hasAttribute("data-lit")).toBe(false);
  });

  it("clique quand même le bouton visé si aucun clic natif ne vient (un doigt qui a glissé)", () => {
    const { pill, a, onA, press } = setup();
    const down = pointer("pointerdown", 120, 120);
    press.down(down, pill);
    expect(a.hasAttribute("data-lit")).toBe(true);
    window.dispatchEvent(pointer("pointermove", 130, 160));
    window.dispatchEvent(pointer("pointerup", 130, 160));
    expect(onA).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onA).toHaveBeenCalledTimes(1);
  });

  it("ne touche jamais à un clic du clavier", () => {
    const { pill, a, onA, onRoot, press } = setup();
    press.down(pointer("pointerdown", 120, 120), pill);
    window.dispatchEvent(pointer("pointerup", 120, 120));
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onRoot).toHaveBeenCalledTimes(1);
    // Et ce clic-là désarme le secours : pas de second clic 300 ms plus tard.
    vi.advanceTimersByTime(1000);
    expect(onA).toHaveBeenCalledTimes(1);
  });

  it("en mode image seule (les menus), anime la surface sans viser ni arrêter aucun clic", () => {
    const { pill, a, onA, onRoot } = setup();
    const soft = createLiquidPress({ targets: ".btn", redirect: false, trusted: () => true });
    const down = pointer("pointerdown", 206, 125); // dans la marge, près d'un bouton
    soft.down(down, pill);
    expect(soft.active()).toBe(true);
    expect(a.hasAttribute("data-lit")).toBe(false);
    window.dispatchEvent(pointer("pointerup", 206, 125));
    fingerClick(pill);
    vi.advanceTimersByTime(1000);
    expect(onA).not.toHaveBeenCalled();
    expect(onRoot).toHaveBeenCalledTimes(1); // le clic natif est parti tel quel
  });

  it("un menu ne s'étire qu'au doigt sorti, reste étiré, et un relâchement dehors ne clique pas le fond", () => {
    const { pill, root, onRoot } = setup();
    const outside = document.createElement("div");
    root.append(outside);
    const menu = createLiquidPress({ targets: "[data-none]", redirect: false, pull: "outside", swell: () => 1, trusted: () => true });
    menu.down(pointer("pointerdown", 150, 125), pill);
    window.dispatchEvent(pointer("pointermove", 160, 130)); // dedans : rien ne bouge
    expect(pill.style.transform).toBe(liquidTransform(0, 0, 1, 100, 50));
    window.dispatchEvent(pointer("pointermove", 260, 125)); // 60 px à droite du bord
    expect(pill.style.transform).toContain("translate(");
    expect(pill.style.transform).not.toBe(liquidTransform(0, 0, 1, 100, 50));
    window.dispatchEvent(pointer("pointerup", 260, 125));
    fingerClick(outside);
    expect(onRoot).not.toHaveBeenCalled(); // le menu ne se referme pas sur ce relâchement
    fingerClick(outside); // le suivant, lui, part normalement
    expect(onRoot).toHaveBeenCalledTimes(1);
  });

  it("ignore le curseur du volume, qui garde son propre geste", () => {
    const { pill, press } = setup();
    const input = document.createElement("input");
    pill.append(input);
    const down = pointer("pointerdown", 150, 120);
    input.dispatchEvent(down);
    press.down(down, pill);
    expect(press.active()).toBe(false);
  });
});

describe("la forme du verre tiré", () => {
  it("gonfle un rond plus qu'une pilule, sans dépasser 12 %", () => {
    expect(swellFor(52, 52)).toBeCloseTo(1.12);
    expect(swellFor(220, 52)).toBeLessThan(1.06);
  });

  it("ne tire pas une pilule tant que le doigt reste entre ses bouts", () => {
    expect(pullFrom(40, 0, 220, 52).r).toBe(0);
    expect(pullFrom(120, 0, 220, 52).r).toBeGreaterThan(0);
  });

  it("ne tire une boîte que de ce qui dépasse de ses bords", () => {
    expect(pullOutside(100, 100, 288, 280).r).toBe(0);
    expect(pullOutside(164, 0, 288, 280).r).toBe(20);
  });

  it("revient exactement au repos quand rien ne tire", () => {
    expect(liquidTransform(0, 0, 1, 52, 52)).toBe("translate(0px, 0px) rotate(0rad) scale(1, 1) rotate(0rad)");
  });
});
