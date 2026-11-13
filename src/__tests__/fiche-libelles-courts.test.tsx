// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";

/**
 * Relecture des fiches par le propriétaire (13/11/2026) :
 * - « Marquer comme vu » devient « Vu » sous une icône (rangée du téléphone), et les deux ronds « Vu » /
 *   « À voir » du bureau gagnent une légende visible, qui suit leur état ; l'`aria-label` reste la phrase ;
 * - « Analyser en priorité » quitte les fiches : la liste de priorité se gère depuis la console seule.
 * Les phrases sont celles du vrai dictionnaire français.
 */
const t = createT(fr as Record<string, unknown>, fr as Record<string, unknown>, "fr");
vi.mock("@/components/TranslationProvider", () => ({ useT: () => t, useLocale: () => ({ locale: "fr", setLocale: async () => {} }) }));
// La question a sa propre pièce et ses propres tests : ici, seulement sa place dans la rangée.
vi.mock("@/components/ask/AskTitleControl", () => ({ AskTitleControl: () => <button type="button" data-round-action="ask" aria-label="question" /> }));

import { TitleToggleIcon, TitleToggleRound, TitleToggleRow, TitleToggleWide, WATCHED_FACE, WATCHLIST_FACE, shortLabel } from "@/components/cinema/TitleToggles";
import { DetailIconActions } from "@/components/cinema/DetailIconActions";

afterEach(() => cleanup());

const noop = () => {};

describe("le libellé court sous une icône", () => {
  it("la rangée du téléphone dit « Vu », éteint comme allumé ; l'état est dans aria-pressed", () => {
    const { rerender } = render(<TitleToggleIcon face={WATCHED_FACE} on={false} onClick={noop} />);
    expect(screen.getByRole("button").textContent).toBe("Vu");
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
    rerender(<TitleToggleIcon face={WATCHED_FACE} on onClick={noop} />);
    expect(screen.getByRole("button").textContent).toBe("Vu");
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
  });

  it("« À voir » ne change pas : « À voir » éteint, « Dans ma liste » allumé", () => {
    const { rerender } = render(<TitleToggleIcon face={WATCHLIST_FACE} on={false} onClick={noop} />);
    expect(screen.getByRole("button").textContent).toBe("À voir");
    rerender(<TitleToggleIcon face={WATCHLIST_FACE} on onClick={noop} />);
    expect(screen.getByRole("button").textContent).toBe("Dans ma liste");
  });

  it("les dessins à phrase gardent « Marquer comme vu »", () => {
    render(
      <>
        <TitleToggleRow face={WATCHED_FACE} on={false} onClick={noop} />
        <TitleToggleWide face={WATCHED_FACE} on={false} onClick={noop} />
      </>
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Marquer comme vu", "Marquer comme vu"]);
  });

  it("le libellé court existe dans les quatre langues, sans répéter la phrase", () => {
    for (const dict of [fr, en, es, de]) {
      const td = createT(dict as Record<string, unknown>, fr as Record<string, unknown>);
      const short = td(shortLabel(WATCHED_FACE, false));
      expect(short).not.toBe(shortLabel(WATCHED_FACE, false));
      expect(short.length).toBeLessThan(td(WATCHED_FACE.offLabel).length);
    }
  });
});

describe("les ronds « Vu » et « À voir » du bureau ont une légende", () => {
  it("visible, courte, atténuée éteinte et en or allumée ; la phrase reste dans aria-label", () => {
    const { rerender } = render(<TitleToggleRound face={WATCHED_FACE} on={false} onClick={noop} />);
    const caption = () => document.querySelector<HTMLElement>("[data-round-caption]")!;
    expect(caption().textContent).toBe("Vu");
    expect(caption().getAttribute("aria-hidden")).toBe("true");
    expect(caption().className).toContain("text-muted");
    expect(screen.getByRole("button", { name: "Marquer comme vu" })).toBeTruthy();
    rerender(<TitleToggleRound face={WATCHED_FACE} on onClick={noop} />);
    expect(caption().textContent).toBe("Vu");
    expect(caption().className).toContain("text-brand");
    expect(screen.getByRole("button", { name: "Vu" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("« À voir » suit son état", () => {
    const { rerender } = render(<TitleToggleRound face={WATCHLIST_FACE} on={false} onClick={noop} />);
    expect(document.querySelector("[data-round-caption]")!.textContent).toBe("À voir");
    rerender(<TitleToggleRound face={WATCHLIST_FACE} on onClick={noop} />);
    expect(document.querySelector("[data-round-caption]")!.textContent).toBe("Dans ma liste");
  });

  it("la légende est hors du bouton : le rond garde sa forme et son nom", () => {
    render(<TitleToggleRound face={WATCHED_FACE} on={false} onClick={noop} />);
    expect(screen.getByRole("button").querySelector("[data-round-caption]")).toBeNull();
  });

  it("la rangée : Vu, À voir, la question — et rien d'autre", () => {
    render(<DetailIconActions watched={{ on: false, onClick: noop }} list={{ on: false, onClick: noop }} askItemId={"a".repeat(32)} />);
    const row = document.querySelector("[data-detail-icon-actions]")!;
    expect(Array.from(row.querySelectorAll("[data-round-action]")).map((b) => b.getAttribute("data-round-action"))).toEqual(["watched", "list", "ask"]);
    expect(Array.from(row.querySelectorAll("[data-round-caption]")).map((c) => c.textContent)).toEqual(["Vu", "À voir"]);
  });
});

describe("« Analyser en priorité » n'est plus sur les fiches (13/11/2026)", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("ni le composant, ni son usage, ni ses mots", () => {
    expect(existsSync("src/components/cinema/XrayPriorityControl.tsx")).toBe(false);
    for (const file of sources("src/components")) {
      const code = readFileSync(file, "utf8");
      expect([file, /XrayPriorityControl|xrayScan\.prioritized?\b|data-xray-priority/.test(code)]).toEqual([file, false]);
    }
    for (const dict of [fr, en, es, de] as unknown as { xrayScan: Record<string, unknown> }[]) {
      expect(dict.xrayScan.prioritize).toBeUndefined();
      expect(dict.xrayScan.prioritized).toBeUndefined();
    }
  });

  it("la console garde la sienne", () => {
    const card = readFileSync("src/components/settings/XrayScanCard.tsx", "utf8");
    expect(card).toContain('action: on ? "prioritize" : "unprioritize"');
  });
});
