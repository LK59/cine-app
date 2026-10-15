// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));

import { similarRowKeyNav } from "@/components/cinema/CinemaSimilarRow";

beforeAll(() => {
  // jsdom ne fait défiler rien : l'appel doit simplement exister.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** Une fiche : le menu, puis, sur la seconde page, la distribution et les titres similaires. */
function sheet(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `
    <div data-snap-section><div data-detail-actions><button data-detail-menu>Lire</button><button data-detail-menu>À voir</button></div></div>
    <div data-snap-section>
      <section><button data-detail-similar>Mara</button><button data-detail-similar>Danny</button></section>
      <section><button data-detail-similar>Charlie</button><button data-detail-similar>Big</button></section>
    </div>`;
  document.body.appendChild(root);
  return root;
}

const press = (root: HTMLElement, key: string) => similarRowKeyNav(new KeyboardEvent("keydown", { key, cancelable: true }), root);
const focused = () => document.activeElement?.textContent;
const byText = (root: HTMLElement, text: string) => Array.from(root.querySelectorAll("button")).find((b) => b.textContent === text)!;

// 15/10/2026 (passe de nuit, BUREAU-3) : distribution, saga et similaires étaient une seule rangée —
// ↓ depuis la distribution était avalé, et les similaires ne s'atteignaient qu'à →, au-delà du
// dernier visage.
describe("similarRowKeyNav — une rangée par section", () => {
  it("↓ passe de la distribution aux titres similaires, ↑ y remonte, puis au menu", () => {
    const root = sheet();
    byText(root, "Mara").focus();
    expect(press(root, "ArrowDown")).toBe(true);
    expect(focused()).toBe("Charlie");
    expect(press(root, "ArrowUp")).toBe(true);
    expect(focused()).toBe("Mara");
    expect(press(root, "ArrowUp")).toBe(true);
    expect(focused()).toBe("À voir");
  });

  it("← et → restent dans la rangée", () => {
    const root = sheet();
    byText(root, "Danny").focus();
    press(root, "ArrowRight");
    expect(focused()).toBe("Danny");
    byText(root, "Charlie").focus();
    press(root, "ArrowLeft");
    expect(focused()).toBe("Charlie");
  });

  it("le menu descend toujours dans la première rangée, et ↓ sous la dernière est avalé", () => {
    const root = sheet();
    byText(root, "À voir").focus();
    expect(press(root, "ArrowDown")).toBe(true);
    expect(focused()).toBe("Mara");
    byText(root, "Big").focus();
    expect(press(root, "ArrowDown")).toBe(true);
    expect(focused()).toBe("Big");
  });
});
