// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";

/**
 * La fenêtre des Nouveautés et Compte → Nouveautés (DECISIONS.md §73) : la fusion de plusieurs
 * pages, les quatre façons de fermer, les mesures envoyées, le clavier et la télécommande, la
 * décision de s'ouvrir, et « Voir plus » qui mène à la bonne section.
 */
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v?.version !== undefined ? `${k}:${v.version}` : k),
  useLocale: () => ({ locale: "fr", setLocale: vi.fn() }),
}));
let playbackMode: "closed" | "full" | "mini" = "closed";
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: playbackMode }) }));
vi.mock("@/components/player/PlayerPanelFrame", () => ({
  PlayerPanelFrame: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

import { NewsDialog } from "@/components/news/NewsDialog";
import { NewsGate } from "@/components/player/NewsGate";
import { PlayerNewsPanel, fixesAnchor } from "@/components/player/PlayerNewsPanel";
import type { NewsPageView, NewsPayload } from "@/lib/news/content";
import { readCinemaRoute } from "@/lib/cinemaRoute";

const page = (id: number, version: string, title: string): NewsPageView => ({
  id,
  seq: id,
  version,
  publishedAt: Date.UTC(2026, 9, id),
  content: {
    fr: {
      sections: [{ title: "Nouveau", entries: [{ icon: "cast", title, text: "Sur la télé.", badge: "bêta" }] }],
      fixesSummary: "Plus rapide, plus fiable.",
      fixes: [{ title: "Lecture", items: [`Correctif de la ${version}.`] }],
    },
  },
});
const P1 = page(1, "8.44", "Chromecast");
const P2 = page(2, "8.45", "Épisode suivant");

let payload: NewsPayload = { pages: [P2, P1], unseen: [2, 1], relaunched: false };
let onboardingPending = false;
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  const json = (body: unknown) => new Response(JSON.stringify(body));
  if (url === "/api/release-notes") return json(payload);
  if (url === "/api/onboarding") return json({ pending: onboardingPending });
  return new Response(null, { status: 204 });
});
const posts = (url: string) =>
  fetchMock.mock.calls
    .filter(([u, init]) => u === url && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollBy = vi.fn() as unknown as Element["scrollBy"];
  window.history.replaceState(null, "", "/");
  payload = { pages: [P2, P1], unseen: [2, 1], relaunched: false };
  onboardingPending = false;
  playbackMode = "closed";
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("la fenêtre", () => {
  it("fusionne deux pages, la plus récente d'abord, chacune sous sa version — et éteint le drapeau à l'affichage", () => {
    render(<NewsDialog pages={[P2, P1]} auto onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const text = dialog.textContent ?? "";
    expect(text.indexOf("news.subtitle:8.45")).toBeLessThan(text.indexOf("news.subtitle:8.44", text.indexOf("news.subtitle:8.45") + 1));
    expect(text.indexOf("Épisode suivant")).toBeLessThan(text.indexOf("Chromecast"));
    // Le titre et deux intertitres.
    expect(screen.getAllByText("news.subtitle:8.45")).toHaveLength(2);
    expect(screen.getAllByText("news.subtitle:8.44")).toHaveLength(1);
    expect(posts("/api/release-notes/seen")).toEqual([{ ids: [2, 1] }]);
    // OK a le focus : Entrée suffit.
    expect(document.activeElement?.textContent).toBe("news.ok");
  });

  it("une seule page : pas d'intertitre", () => {
    render(<NewsDialog pages={[P1]} auto onClose={vi.fn()} />);
    expect(screen.getAllByText("news.subtitle:8.44")).toHaveLength(1);
  });

  it.each<[string, (dialog: HTMLElement) => void]>([
    ["ok", () => fireEvent.click(screen.getByText("news.ok"))],
    ["echap", () => fireEvent.keyDown(window, { key: "Escape" })],
    // La touche Retour d'une télécommande.
    ["echap", () => fireEvent.keyDown(window, { key: "GoBack" })],
    ["dehors", (d) => fireEvent.click(d.parentElement as HTMLElement)],
    ["voir-plus", () => fireEvent.click(screen.getAllByText("news.seeMore")[0])],
  ])("se ferme par « %s » et envoie sa mesure", (by, gesture) => {
    const onClose = vi.fn();
    render(<NewsDialog pages={[P2, P1]} auto={false} onClose={onClose} />);
    gesture(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledWith(by);
    const sent = posts("/api/release-notes/event");
    expect(sent[0]).toMatchObject({ event: "fenêtre", closedBy: by, noteIds: [2, 1], auto: false, scrolled: false });
    expect(typeof sent[0].shownMs).toBe("number");
    expect(sent.some((l) => l.event === "voir-plus")).toBe(by === "voir-plus");
  });

  it("note le défilement", () => {
    render(<NewsDialog pages={[P2, P1]} auto onClose={vi.fn()} />);
    const body = screen.getByRole("dialog").firstElementChild as HTMLElement;
    body.scrollTop = 120;
    fireEvent.scroll(body);
    fireEvent.click(screen.getByText("news.ok"));
    expect(posts("/api/release-notes/event")[0]).toMatchObject({ scrolled: true, auto: true });
  });

  it("garde les touches pour elle : la grille dessous n'entend ni les flèches, ni « / »", () => {
    const below = vi.fn();
    window.addEventListener("keydown", below);
    render(<NewsDialog pages={[P2, P1]} auto onClose={vi.fn()} />);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "/" });
    expect(below).not.toHaveBeenCalled();
    window.removeEventListener("keydown", below);
  });

  it("à la télécommande : droite et gauche passent d'un bouton à l'autre, Tab reste dans la fenêtre", () => {
    render(<NewsDialog pages={[P1]} auto onClose={vi.fn()} />);
    expect(document.activeElement?.textContent).toBe("news.ok");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toBe("news.seeMore");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("news.ok");
    // Entrée sans bouton sous le focus vaut OK.
    (document.activeElement as HTMLElement).blur();
    const onClose = vi.fn();
    cleanup();
    render(<NewsDialog pages={[P1]} auto onClose={onClose} />);
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).toHaveBeenCalledWith("ok");
  });

  it("l'aperçu de l'éditeur ne mesure rien et ne marque rien", () => {
    const onClose = vi.fn();
    render(<NewsDialog pages={[P1]} auto preview onClose={onClose} />);
    fireEvent.click(screen.getByText("news.ok"));
    expect(onClose).toHaveBeenCalledWith("ok");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const drawGate = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <NewsGate />
    </SWRConfig>
  );

describe("NewsGate", () => {
  it("s'ouvre sur l'accueil, et « Voir plus » mène à Compte → Nouveautés, sur les corrections de la page la plus récente", async () => {
    drawGate();
    expect(await screen.findByRole("dialog", {}, { timeout: 3000 })).toBeTruthy();
    fireEvent.click(screen.getAllByText("news.seeMore")[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(readCinemaRoute().news).toBe("corrections:2");
  });

  it("ne s'ouvre pas pendant un film, ni par-dessus une fiche ouverte par lien, ni avant l'écran d'accueil", async () => {
    playbackMode = "full";
    drawGate();
    await act(() => new Promise((r) => setTimeout(r, 1600)));
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();

    playbackMode = "closed";
    window.history.replaceState(null, "", "/#film=12");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    drawGate();
    await act(() => new Promise((r) => setTimeout(r, 1600)));
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();

    window.history.replaceState(null, "", "/");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    onboardingPending = true;
    drawGate();
    await act(() => new Promise((r) => setTimeout(r, 1600)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rien à voir : rien", async () => {
    payload = { pages: [P2, P1], unseen: [], relaunched: false };
    drawGate();
    await act(() => new Promise((r) => setTimeout(r, 1600)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Le drapeau s'éteint à l'affichage : une relecture pendant la lecture (retour du réseau)
  // répond `unseen: []`, et la fenêtre disparaissait sans fermeture ni mesure (13/10/2026).
  it("reste ouverte quand une relecture répond « plus rien à voir » pendant qu'on lit", async () => {
    let relire: () => Promise<unknown> = async () => undefined;
    function Relecture() {
      const { mutate } = useSWRConfig();
      relire = () => mutate("/api/release-notes");
      return null;
    }
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <NewsGate />
        <Relecture />
      </SWRConfig>
    );
    expect(await screen.findByRole("dialog", {}, { timeout: 3000 })).toBeTruthy();
    payload = { pages: [P2, P1], unseen: [], relaunched: false };
    await act(async () => {
      await relire();
    });
    expect(screen.queryByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByText("news.ok"));
    expect(posts("/api/release-notes/event")[0]).toMatchObject({ closedBy: "ok", noteIds: [2, 1] });
  });

  it("une relance de l'administrateur est mesurée `auto: false`", async () => {
    payload = { pages: [P2, P1], unseen: [2], relaunched: true };
    drawGate();
    fireEvent.click(await screen.findByText("news.ok", {}, { timeout: 3000 }));
    expect(posts("/api/release-notes/event")[0]).toMatchObject({ auto: false, noteIds: [2] });
  });
});

describe("Compte → Nouveautés", () => {
  const drawPanel = (raw: string) =>
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PlayerNewsPanel raw={raw} />
      </SWRConfig>
    );

  it("montre la liste complète des corrections, l'historique, et arrive sur la section demandée", async () => {
    const view = drawPanel("corrections:1");
    expect(await screen.findByText("Correctif de la 8.45.")).toBeTruthy();
    // La page demandée est dans l'historique : dépliée d'office, et la vue s'y rend.
    expect(screen.getByText("Correctif de la 8.44.")).toBeTruthy();
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    const target = (Element.prototype.scrollIntoView as unknown as { mock: { contexts: Element[] } }).mock.contexts[0];
    expect(target.id).toBe(fixesAnchor(1));
    // Pas de « Voir plus » ici : tout est déjà déroulé.
    expect(screen.queryByText("news.seeMore")).toBeNull();
    view.unmount();
    expect(posts("/api/release-notes/event")[0]).toMatchObject({ event: "page", section: "corrections" });
  });

  it("ouverte depuis le Compte : la page la plus récente, les précédentes repliées", async () => {
    drawPanel("1");
    expect(await screen.findByText("Correctif de la 8.45.")).toBeTruthy();
    expect(screen.queryByText("Correctif de la 8.44.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Correctif de la 8.44.")).toBeTruthy();
  });
});
