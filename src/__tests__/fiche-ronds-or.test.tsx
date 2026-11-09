// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

/**
 * Les boutons ronds des fiches du bureau (§117.4, 10.27.1) : « Vu » et « Dans ma liste » allumés portent l'or
 * de la pastille allumée du menu (`MENU_BADGE_ACTIVE` : `bg-ink text-brand ring-brand/60`) — et **seulement**
 * cette teinte. En 10.27.0, l'éteint (`bg-black/55 text-white`) restait sur le bouton allumé ; l'ordre de la
 * feuille de Tailwind tranchait pour le blanc, l'or avait disparu.
 */

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));

import { TitleToggleRound, WATCHED_FACE, WATCHLIST_FACE } from "@/components/cinema/TitleToggles";
import { MENU_BADGE_ACTIVE } from "@/components/cinema/detailMenu";

afterEach(cleanup);

const classes = (el: Element) => new Set(el.className.split(/\s+/).filter(Boolean));

describe("l'or des deux boutons ronds allumés", () => {
  for (const [name, face] of [
    ["Vu", WATCHED_FACE],
    ["Dans ma liste", WATCHLIST_FACE],
  ] as const) {
    it(`${name} allumé : l'or du menu, sans le blanc de l'éteint`, () => {
      const { container } = render(<TitleToggleRound face={face} on onClick={() => {}} />);
      const button = container.querySelector("button")!;
      const c = classes(button);
      // Le même jeton que la pastille allumée du menu (et que l'icône or du téléphone, `text-brand`).
      for (const token of ["bg-ink", "text-brand", "ring-brand/60"]) {
        expect(c.has(token)).toBe(true);
        expect(MENU_BADGE_ACTIVE).toContain(token);
      }
      expect(c.has("text-white")).toBe(false);
      expect(c.has("bg-black/55")).toBe(false);
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.hasAttribute("data-on")).toBe(true);
    });

    it(`${name} éteint : le verre blanc, pas d'or`, () => {
      const { container } = render(<TitleToggleRound face={face} on={false} onClick={() => {}} />);
      const button = container.querySelector("button")!;
      const c = classes(button);
      expect(c.has("text-white")).toBe(true);
      expect(c.has("bg-black/55")).toBe(true);
      expect(c.has("text-brand")).toBe(false);
      expect(c.has("bg-ink")).toBe(false);
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.hasAttribute("data-on")).toBe(false);
    });
  }
});
