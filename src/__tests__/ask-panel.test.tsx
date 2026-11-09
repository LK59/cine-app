// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

/**
 * Le panneau « Poser une question » (DECISIONS.md §139) : ouvrir, fermer (Échap, toucher le film), les
 * questions proposées, la réponse diffusée, « je ne sais pas », les touches qui ne remontent pas au
 * lecteur ni à la fiche, et la réduction à une ligne au-dessus du clavier — d'après la vue visuelle.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => ({ locale: "fr" }),
}));

import { AskPanel } from "@/components/ask/AskPanel";
import { AskTitleControl } from "@/components/ask/AskTitleControl";
import { askPanelLayout, KEYBOARD_MIN_PX, LINE_HEIGHT_PX } from "@/lib/ask/viewport";

const ITEM = "a".repeat(32);

/** Une vue visuelle réglable, comme celle de Safari : hauteur, décalage, et ses deux événements. */
class FakeViewport extends EventTarget {
  height = 390;
  width = 844;
  offsetTop = 0;
  set(next: Partial<{ height: number; offsetTop: number; width: number }>) {
    Object.assign(this, next);
    this.dispatchEvent(new Event("resize"));
  }
}
let vv: FakeViewport;

function ndjson(lines: unknown[]) {
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
}
const fetchMock = vi.fn();

beforeEach(() => {
  vv = new FakeViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === "POST" ? ndjson([{ t: "text", v: "Ariadne construit le labyrinthe." }, { t: "done" }]) : new Response(JSON.stringify({ available: true }))
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function panel(props: Partial<Parameters<typeof AskPanel>[0]> = {}) {
  const onClose = vi.fn();
  render(<AskPanel itemId={ITEM} where="lecteur" placement="player" position={() => 1234} onClose={onClose} {...props} />);
  return { onClose };
}
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");

describe("le panneau", () => {
  it("s'ouvre sur les questions proposées, sans clavier, et demande d'avance les dialogues", async () => {
    panel();
    expect(screen.getByRole("dialog", { name: "ask.title" })).toBeTruthy();
    expect(screen.getByText("ask.chipPlayer0")).toBeTruthy();
    expect(screen.getByText("ask.hint")).toBeTruthy();
    expect(document.activeElement).not.toBe(document.querySelector("[data-ask-input]"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/cinema/ask/${ITEM}`, expect.anything()));
  });

  it("une proposition touchée part avec la position du film à l'instant, et la réponse s'affiche sous la question", async () => {
    panel();
    fireEvent.click(screen.getByText("ask.chipPlayer0"));
    await screen.findByText("Ariadne construit le labyrinthe.");
    const body = JSON.parse(String((posts()[0][1] as RequestInit).body));
    expect(body).toMatchObject({ question: "ask.chipPlayer0", where: "lecteur", positionS: 1234, previous: [] });
    // La proposition posée ne se repropose pas.
    expect(screen.queryByRole("button", { name: "ask.chipPlayer0" })).toBeNull();
  });

  it("la question suivante emporte les échanges d'avant ; cinq au plus, puis le champ se ferme", async () => {
    panel();
    const input = document.querySelector<HTMLInputElement>("[data-ask-input]")!;
    for (let i = 0; i < 5; i++) {
      fireEvent.change(input, { target: { value: `Question ${i}` } });
      fireEvent.submit(input.closest("form")!);
      await waitFor(() => expect(document.querySelectorAll('[data-ask-exchange="done"]')).toHaveLength(i + 1));
    }
    expect(JSON.parse(String((posts()[4][1] as RequestInit).body)).previous).toHaveLength(4);
    expect(input.disabled).toBe(true);
    expect(screen.getByText("ask.maxReached")).toBeTruthy();
  });

  it("un rejet retire toute la réponse et dit « je ne sais pas » ; une borne dit la sienne", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? ndjson([{ t: "text", v: "Une phrase sûre." }, { t: "rejected" }]) : new Response("{}")
    );
    panel();
    fireEvent.click(screen.getByText("ask.chipPlayer1"));
    await screen.findByText("ask.unknown");
    expect(screen.queryByText("Une phrase sûre.")).toBeNull();
    fetchMock.mockImplementation(async () => ndjson([{ t: "error", code: "limite" }]));
    fireEvent.click(screen.getByText("ask.chipPlayer2"));
    await screen.findByText("ask.limit");
  });

  it("une réponse coupée sans fin, ou une panne : un message, jamais un écran cassé", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response("{}");
      throw new TypeError("network");
    });
    panel();
    fireEvent.click(screen.getByText("ask.chipPlayer0"));
    await screen.findByText("ask.error");
  });

  it("Échap referme, et ne va pas plus loin (ni la fiche ni le lecteur ne l'entendent)", () => {
    const below = vi.fn();
    window.addEventListener("keydown", below);
    const { onClose } = panel();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    window.removeEventListener("keydown", below);
  });

  it("les touches du champ restent au champ : espace, flèches, F, M n'atteignent pas le clavier du lecteur", () => {
    const player = vi.fn();
    window.addEventListener("keydown", player);
    panel();
    const input = document.querySelector<HTMLInputElement>("[data-ask-input]")!;
    act(() => input.focus());
    for (const [key, code] of [[" ", "Space"], ["ArrowLeft", "ArrowLeft"], ["ArrowRight", "ArrowRight"], ["f", "KeyF"], ["m", "KeyM"], ["k", "KeyK"]]) {
      fireEvent.keyDown(input, { key, code });
    }
    expect(player).not.toHaveBeenCalled();
    window.removeEventListener("keydown", player);
  });

  it("le panneau porte la marque qui fait taire les touches des fiches", () => {
    panel();
    expect(document.querySelector("[data-ask-layer]")?.hasAttribute("data-action-sheet")).toBe(true);
  });

  it("toucher le film referme ; pendant la frappe, le même toucher referme seulement le clavier", () => {
    const { onClose } = panel();
    const input = document.querySelector<HTMLInputElement>("[data-ask-input]")!;
    act(() => input.focus());
    fireEvent.focus(input);
    fireEvent.click(document.querySelector("[data-ask-backdrop]")!);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
    fireEvent.blur(input);
    fireEvent.click(document.querySelector("[data-ask-backdrop]")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("un appui dans le panneau ne remonte pas à la surface du lecteur (qui mettrait en pause)", () => {
    const surface = vi.fn();
    render(
      <div onClick={surface} onPointerDown={surface}>
        <AskPanel itemId={ITEM} where="lecteur" placement="player" onClose={() => {}} />
      </div>
    );
    fireEvent.pointerDown(screen.getByText("ask.hint"));
    fireEvent.click(screen.getByText("ask.hint"));
    fireEvent.click(document.querySelector("[data-ask-backdrop]")!);
    expect(surface).not.toHaveBeenCalled();
  });

  it("iPhone couché : le clavier ouvert, le panneau se réduit à la ligne du champ posée juste au-dessus", async () => {
    panel();
    const section = () => document.querySelector<HTMLElement>("[data-ask-panel]")!;
    expect(section().dataset.mode).toBe("side");
    const input = document.querySelector<HTMLInputElement>("[data-ask-input]")!;
    fireEvent.focus(input);
    // iOS fait glisser la vue vers le champ, et le clavier prend plus de la moitié.
    act(() => vv.set({ height: 170, offsetTop: 40 }));
    await waitFor(() => expect(section().dataset.mode).toBe("line"));
    expect(section().style.top).toBe(`${40 + 170 - LINE_HEIGHT_PX - 8}px`);
    // Le champ est toujours le même nœud : le focus — donc le clavier — n'est pas perdu au changement de forme.
    expect(document.querySelector("[data-ask-input]")).toBe(input);
    // Envoyé : le champ rend le focus, le panneau entier revient avec la réponse.
    fireEvent.change(input, { target: { value: "Qui est Ariadne ?" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.blur(input);
    act(() => vv.set({ height: 390, offsetTop: 0 }));
    await waitFor(() => expect(section().dataset.mode).toBe("side"));
    await screen.findByText("Ariadne construit le labyrinthe.");
  });
});

describe("askPanelLayout — la place d'après la vue visuelle, jamais d'après 100vh", () => {
  const base = { width: 844, height: 390, offsetTop: 0, baseline: 390, focused: false };
  it("sans clavier : toute la hauteur visible, à droite", () => {
    expect(askPanelLayout(base)).toEqual({ mode: "full", top: 12, height: 366, sheet: false });
  });
  it("le focus seul (bureau, clavier matériel) ne réduit rien", () => {
    expect(askPanelLayout({ ...base, focused: true }).mode).toBe("full");
  });
  it("une barre d'outils qui grignote quelques pixels n'est pas un clavier", () => {
    expect(askPanelLayout({ ...base, focused: true, height: 390 - KEYBOARD_MIN_PX + 10 }).mode).toBe("full");
  });
  it("fenêtre restée à la hauteur du clavier (iOS 26) : la vue visuelle seule fait foi", () => {
    // La fenêtre est déjà courte à l'ouverture : la référence l'est aussi, et le panneau tient dedans.
    expect(askPanelLayout({ ...base, height: 250, baseline: 250 })).toEqual({ mode: "full", top: 12, height: 226, sheet: false });
  });
  it("téléphone debout : une feuille en bas ; le clavier ouvert, la ligne au-dessus de lui", () => {
    const portrait = { width: 390, height: 844, offsetTop: 0, baseline: 844, focused: false };
    const sheet = askPanelLayout(portrait);
    expect(sheet).toMatchObject({ mode: "full", sheet: true });
    expect(sheet.mode === "full" && sheet.top + sheet.height).toBe(844);
    expect(askPanelLayout({ ...portrait, focused: true, height: 500 })).toEqual({ mode: "line", top: 500 - LINE_HEIGHT_PX - 8 });
  });
});

describe("AskTitleControl — la pièce des fiches", () => {
  function withConfig(pub: unknown, node: ReactNode) {
    return render(<SWRConfig value={{ provider: () => new Map([["/api/config/public", { data: pub }]]) }}>{node}</SWRConfig>);
  }
  it("option allumée : une ligne qui ouvre le panneau de la fiche, posé sur la page", async () => {
    withConfig({ askAvailable: true }, <AskTitleControl itemId={ITEM} variant="row" />);
    fireEvent.click(screen.getByText("ask.title"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("ask.chipSheet0")).toBeTruthy();
    expect(document.querySelector("[data-ask-layer]")?.className).toContain("fixed");
  });
  it("option coupée, sans élément, ou sur Fire TV : rien", () => {
    withConfig({ askAvailable: false }, <AskTitleControl itemId={ITEM} variant="icon" />);
    expect(screen.queryByText("ask.title")).toBeNull();
    cleanup();
    withConfig({ askAvailable: true }, <AskTitleControl itemId={null} variant="icon" />);
    expect(screen.queryByText("ask.title")).toBeNull();
    cleanup();
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36 (KHTML, like Gecko) Silk/112.3.1 like Chrome/112.0.5615.213 Safari/537.36");
    withConfig({ askAvailable: true }, <AskTitleControl itemId={ITEM} variant="icon" />);
    expect(screen.queryByText("ask.title")).toBeNull();
    ua.mockRestore();
  });
  it("aucune requête de configuration au montage : la réponse de la coquille est suivie, pas redemandée", () => {
    withConfig({ askAvailable: true }, <AskTitleControl itemId={ITEM} variant="icon" />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
