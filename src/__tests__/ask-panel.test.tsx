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

  it("Échap referme, et ne va pas plus loin (ni la fiche ni le lecteur ne l'entendent)", async () => {
    const below = vi.fn();
    window.addEventListener("keydown", below);
    const { onClose } = panel();
    fireEvent.keyDown(window, { key: "Escape" });
    // La sortie glisse d'abord (`useDelayedClose`), puis la fermeture part.
    expect(document.querySelector("[data-ask-panel]")?.hasAttribute("data-closing")).toBe(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
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

  it("toucher le film referme ; pendant la frappe, le même toucher referme seulement le clavier", async () => {
    const { onClose } = panel();
    const input = document.querySelector<HTMLInputElement>("[data-ask-input]")!;
    act(() => input.focus());
    fireEvent.focus(input);
    fireEvent.click(document.querySelector("[data-ask-backdrop]")!);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
    fireEvent.blur(input);
    fireEvent.click(document.querySelector("[data-ask-backdrop]")!);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
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

  it("au lecteur, iPhone couché : le clavier ouvert, le panneau se réduit à la ligne du champ, posée en haut (10.27)", async () => {
    panel();
    const section = () => document.querySelector<HTMLElement>("[data-ask-panel]")!;
    expect(section().dataset.mode).toBe("side");
    const input = document.querySelector<HTMLInputElement>("[data-ask-input]")!;
    fireEvent.focus(input);
    // iOS fait glisser la vue vers le champ, et le clavier prend plus de la moitié.
    act(() => vv.set({ height: 170, offsetTop: 40 }));
    await waitFor(() => expect(section().dataset.mode).toBe("line"));
    // En haut de ce qu'on voit, sous la zone sûre — au lecteur, toujours.
    expect(section().style.top).toBe("calc(52px + env(safe-area-inset-top, 0px))");
    expect(section().style.opacity).toBe("");
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

  it("une rotation pendant la frappe : le clavier se referme, le texte reste, le panneau se replace", async () => {
    panel({ placement: "sheet", where: "fiche" });
    const section = () => document.querySelector<HTMLElement>("[data-ask-panel]")!;
    const input = document.querySelector<HTMLInputElement>("[data-ask-input]")!;
    act(() => input.focus());
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Qui est Mal ?" } });
    act(() => vv.set({ height: 170, offsetTop: 0 }));
    await waitFor(() => expect(section().dataset.mode).toBe("line"));
    act(() => void window.dispatchEvent(new Event("orientationchange")));
    expect(document.activeElement).not.toBe(input);
    fireEvent.blur(input);
    act(() => vv.set({ height: 844, width: 390, offsetTop: 0 }));
    await waitFor(() => expect(section().dataset.mode).toBe("sheet"));
    expect(input.value).toBe("Qui est Mal ?");
    expect(posts()).toHaveLength(0);
  });
});

describe("askPanelLayout — la place d'après la vue visuelle, jamais d'après 100vh", () => {
  const base = { width: 844, height: 390, offsetTop: 0, baseline: 390, focused: false };
  it("sans clavier : toute la hauteur visible, à droite", () => {
    expect(askPanelLayout(base)).toEqual({ mode: "full", top: 12, height: 366, sheet: false, branch: "colonne" });
  });
  it("le focus seul (bureau, clavier matériel) ne réduit rien", () => {
    expect(askPanelLayout({ ...base, focused: true }).mode).toBe("full");
  });
  it("une barre d'outils qui grignote quelques pixels n'est pas un clavier", () => {
    expect(askPanelLayout({ ...base, focused: true, height: 390 - KEYBOARD_MIN_PX + 10 }).mode).toBe("full");
  });
  it("fenêtre restée à la hauteur du clavier (iOS 26) : la vue visuelle seule fait foi", () => {
    // La fenêtre est déjà courte à l'ouverture : la référence l'est aussi, et le panneau tient dedans.
    expect(askPanelLayout({ ...base, height: 250, baseline: 250 })).toEqual({ mode: "full", top: 12, height: 226, sheet: false, branch: "colonne" });
  });
  it("téléphone debout : une feuille en bas ; le clavier ouvert, la ligne au-dessus de lui", () => {
    const portrait = { width: 390, height: 844, offsetTop: 0, baseline: 844, focused: false };
    const sheet = askPanelLayout(portrait);
    expect(sheet).toMatchObject({ mode: "full", sheet: true });
    expect(sheet.mode === "full" && sheet.top + sheet.height).toBe(844);
    expect(askPanelLayout({ ...portrait, focused: true, height: 500 })).toEqual({ mode: "line", top: 500 - LINE_HEIGHT_PX - 8, branch: "vue" });
  });

  // L'iPhone du propriétaire en application installée (09/11/2026) : couché, le clavier couvrait le champ ;
  // debout, le panneau ne s'était pas réduit du tout. Les quatre façons qu'a iOS de (ne pas) dire le clavier.
  it("la vue de mise en page rétrécit avec la vue visuelle : la référence suffit", () => {
    const f = { width: 390, height: 844, offsetTop: 0, baseline: 844, layoutHeight: 844, focused: false, touchPhone: true };
    expect(askPanelLayout({ ...f, focused: true, height: 480, layoutHeight: 480 })).toEqual({ mode: "line", top: 480 - LINE_HEIGHT_PX - 8, branch: "vue" });
  });
  it("la fenêtre ne rétrécit pas, iOS fait glisser la vue (offsetTop) : la ligne au bas de la vue visuelle", () => {
    // Référence relevée trop tard (déjà courte) : seule la fenêtre restée entière dit le clavier.
    const f = { width: 390, height: 420, offsetTop: 300, baseline: 420, layoutHeight: 844, focused: true, touchPhone: true };
    const layout = askPanelLayout(f);
    expect(layout).toMatchObject({ mode: "line", branch: "fenetre" });
    expect(layout.top + LINE_HEIGHT_PX + 8).toBe(300 + 420);
  });
  it("un calque qui ne commence pas en haut de la fenêtre : la ligne reste contre le clavier", () => {
    const f = { width: 390, height: 470, offsetTop: 40, baseline: 844, layoutHeight: 844, focused: true, layerTop: 20 };
    expect(askPanelLayout(f)).toMatchObject({ mode: "line", top: 40 + 470 - LINE_HEIGHT_PX - 8 - 20 });
  });

  // La règle du propriétaire (10.27) : au lecteur, la ligne en haut, debout comme couché ; sur une fiche,
  // au-dessus du clavier debout, en haut couché. En haut, rien n'attend la mesure du clavier.
  it("au lecteur : la ligne en haut, debout comme couché — mesurée ou non", () => {
    const portrait = { width: 390, height: 480, offsetTop: 0, baseline: 844, layoutHeight: 844, focused: true, touchPhone: true, context: "player" as const };
    expect(askPanelLayout(portrait)).toEqual({ mode: "line", top: 12, branch: "vue", pending: false, fromTop: true });
    const landscape = { width: 844, height: 150, offsetTop: 30, baseline: 390, layoutHeight: 390, focused: true, touchPhone: true, context: "player" as const };
    expect(askPanelLayout(landscape)).toMatchObject({ mode: "line", top: 42, fromTop: true, pending: false });
    // Un téléphone dont le clavier ne se laisse pas mesurer : en haut tout de suite, sans attente invisible.
    expect(askPanelLayout({ ...portrait, height: 844, settling: true })).toMatchObject({ mode: "line", branch: "attente", pending: false, fromTop: true });
  });
  it("sur une fiche : debout, contre le clavier ; couché, en haut", () => {
    const portrait = { width: 390, height: 480, offsetTop: 0, baseline: 844, layoutHeight: 844, focused: true, touchPhone: true, context: "sheet" as const };
    expect(askPanelLayout(portrait)).toEqual({ mode: "line", top: 480 - LINE_HEIGHT_PX - 8, branch: "vue" });
    const landscape = { width: 844, height: 150, offsetTop: 0, baseline: 390, layoutHeight: 390, focused: true, touchPhone: true, context: "sheet" as const };
    expect(askPanelLayout(landscape)).toMatchObject({ mode: "line", top: 12, fromTop: true });
  });
  it("aucun signe du clavier sur un téléphone : invisible le temps de la mesure, puis la ligne en haut — jamais le panneau entier", () => {
    const f = { width: 390, height: 844, offsetTop: 0, baseline: 844, layoutHeight: 844, focused: true, touchPhone: true };
    expect(askPanelLayout({ ...f, settling: true })).toMatchObject({ mode: "line", branch: "attente", pending: true, fromTop: true, top: 12 });
    expect(askPanelLayout({ ...f, settling: false })).toMatchObject({ mode: "line", branch: "inconnu", pending: false, top: 12 });
    // Un iPad (pas un téléphone) ou un ordinateur : le focus seul ne réduit rien.
    expect(askPanelLayout({ ...f, touchPhone: false }).mode).toBe("full");
  });
  it("un pincement qui réduit la vue n'est pas un clavier", () => {
    const f = { width: 844, height: 200, offsetTop: 0, baseline: 200, layoutHeight: 390, scale: 2, focused: true };
    expect(askPanelLayout(f).mode).toBe("full");
  });
  it("iPhone couché, ~150 px visibles : la ligne tient dans ce qui reste", () => {
    const f = { width: 844, height: 150, offsetTop: 0, baseline: 390, layoutHeight: 390, focused: true, touchPhone: true };
    const layout = askPanelLayout(f);
    expect(layout).toMatchObject({ mode: "line", branch: "vue", fromTop: true });
    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.top + LINE_HEIGHT_PX).toBeLessThanOrEqual(150);
  });
});

describe("le panneau et le clavier d'iOS — vue visuelle simulée", () => {
  /** Un iPhone debout, panneau d'une fiche : la ligne se pose contre le clavier (la règle de 10.27). */
  function phone() {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    vv.width = 390;
    vv.height = 844;
    Object.defineProperty(window.screen, "width", { configurable: true, value: 390 });
    Object.defineProperty(window.screen, "height", { configurable: true, value: 844 });
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("coarse"), media: q, addEventListener() {}, removeEventListener() {} }));
    window.matchMedia = (globalThis as unknown as { matchMedia: typeof window.matchMedia }).matchMedia;
  }
  const section = () => document.querySelector<HTMLElement>("[data-ask-panel]")!;
  const diagLines = () =>
    fetchMock.mock.calls
      .filter(([url]) => url === "/api/viewport-diag")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

  it("resize en retard : la ligne attend, invisible, puis se pose au-dessus du clavier", async () => {
    phone();
    panel({ placement: "sheet", where: "fiche" });
    const input = document.querySelector<HTMLInputElement>("[data-ask-input]")!;
    act(() => input.focus());
    fireEvent.focus(input);
    await waitFor(() => expect(section().dataset.mode).toBe("line"));
    expect(section().dataset.branch).toBe("attente");
    expect(section().style.opacity).toBe("0");
    // 400 ms plus tard, iOS se décide.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
      vv.set({ height: 460, offsetTop: 0 });
    });
    await waitFor(() => expect(section().style.top).toBe(`${460 - LINE_HEIGHT_PX - 8}px`));
    expect(section().style.opacity).toBe("");
  });

  it("aucun resize du tout : relue à chaque image, la vue qui a rétréci est quand même vue", async () => {
    phone();
    panel({ placement: "sheet", where: "fiche" });
    const input = document.querySelector<HTMLInputElement>("[data-ask-input]")!;
    act(() => input.focus());
    fireEvent.focus(input);
    // La vue change sans prévenir (aucun événement).
    vv.height = 470;
    await waitFor(() => expect(section().style.top).toBe(`${470 - LINE_HEIGHT_PX - 8}px`));
  });

  it("les lignes `clavier` : au focus et 600 ms plus tard, avec la branche et les mesures ; six au plus par ouverture", async () => {
    phone();
    panel();
    const input = document.querySelector<HTMLInputElement>("[data-ask-input]")!;
    act(() => input.focus());
    await waitFor(() => expect(diagLines().map((l) => l.trigger)).toEqual(["focus", "600ms"]), { timeout: 2000 });
    const first = diagLines()[0];
    expect(first).toMatchObject({ kind: "clavier", where: "lecteur", placement: "player", inner: 844, screenW: 390, screenH: 844, touchPhone: true, place: "haut" });
    expect(first).toHaveProperty("branch");
    expect(first).toHaveProperty("inputBottom");
    expect(first).toHaveProperty("vvTop");
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        vv.set({ height: 200 - i, offsetTop: i });
        await new Promise((r) => setTimeout(r, 200));
      });
    }
    expect(diagLines().length).toBe(6);
  });

  it("« OK » referme le clavier sans envoyer : le texte reste, le panneau entier revient", async () => {
    panel();
    const input = document.querySelector<HTMLInputElement>("[data-ask-input]")!;
    expect(document.querySelector("[data-ask-done]")).toBeNull();
    act(() => input.focus());
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Qui est Cobb ?" } });
    const done = await screen.findByText("ask.done");
    fireEvent.mouseDown(done);
    fireEvent.click(done);
    expect(document.activeElement).not.toBe(input);
    fireEvent.blur(input);
    await waitFor(() => expect(document.querySelector("[data-ask-done]")).toBeNull());
    expect(input.value).toBe("Qui est Cobb ?");
    expect(posts()).toHaveLength(0);
    expect(input.getAttribute("enterkeyhint")).toBe("send");
  });

  it("propositions et champ sous l'espace des réponses, dans le flux — l'espace rogne son texte", async () => {
    panel();
    fireEvent.click(screen.getByText("ask.chipPlayer0"));
    await screen.findByText("Ariadne construit le labyrinthe.");
    const scroll = document.querySelector("[data-ask-scroll]")!;
    const chips = document.querySelector("[data-ask-chips]")!;
    expect(scroll.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scroll.className).toContain("ask-scroll");
    expect(chips.className).not.toMatch(/absolute|fixed/);
  });
});

describe("le panneau des fiches arrive et repart", () => {
  it("entrée animée, et sortie jouée avant la fermeture", async () => {
    const onClose = vi.fn();
    render(<AskPanel itemId={ITEM} where="fiche" placement="sheet" onClose={onClose} />);
    const section = document.querySelector<HTMLElement>("[data-ask-panel]")!;
    expect(section.className).toMatch(/animate-(fade-in-side|slide-up)/);
    expect(section.className).toContain("motion-reduce:animate-none");
    fireEvent.click(document.querySelector("[data-ask-close]")!);
    expect(onClose).not.toHaveBeenCalled();
    expect(section.className).toMatch(/ask-panel-out-side|animate-fade-out-down/);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("des propositions données : à la place de celles d'office", () => {
    render(<AskPanel itemId={ITEM} where="lecteur" placement="player" onClose={() => {}} suggestions={["Qui est Cobb ?"]} />);
    expect(screen.getByText("Qui est Cobb ?")).toBeTruthy();
    expect(screen.queryByText("ask.chipPlayer0")).toBeNull();
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
