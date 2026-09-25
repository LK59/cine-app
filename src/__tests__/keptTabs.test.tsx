// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, cleanup } from "@testing-library/react";
import { HIDDEN_TAB_ATTR, inHiddenTab, tabPaneProps, useKeptTabs, useTabScrollMemory } from "@/lib/keptTabs";
import { useRef } from "react";

/**
 * Films ↔ Séries sans reconstruction (25/09/2026) : « quand je retourne dans Films, ça régénère
 * les affiches ». L'onglet quitté reste monté, caché et inerte.
 */
afterEach(cleanup);

describe("les onglets gardés", () => {
  it("garde chaque onglet visité, dans l'ordre de la visite", () => {
    const { result, rerender } = renderHook(({ tab }) => useKeptTabs(tab), {
      initialProps: { tab: "movies" as "movies" | "series" },
    });
    expect(result.current).toEqual(["movies"]);
    rerender({ tab: "series" });
    expect(result.current).toEqual(["movies", "series"]);
    rerender({ tab: "movies" });
    expect(result.current).toEqual(["movies", "series"]);
  });

  it("cache l'onglet qu'on ne regarde pas, le rend inerte, et ne fond que le volet affiché", () => {
    expect(tabPaneProps("movies", "series", "fondu")).toEqual({ hidden: true, inert: true, [HIDDEN_TAB_ATTR]: "" });
    expect(tabPaneProps("series", "series", "fondu")).toEqual({ hidden: false, inert: false, className: "fondu" });
  });

  it("la navigation reconnaît ce qui est dans l'onglet caché", () => {
    const { container } = render(
      <div>
        <div {...tabPaneProps("movies", "series")}>
          <button data-tv-card>film</button>
        </div>
        <div {...tabPaneProps("series", "series")}>
          <button data-tv-card>série</button>
        </div>
      </div>
    );
    const [film, serie] = Array.from(container.querySelectorAll("[data-tv-card]"));
    expect(inHiddenTab(film)).toBe(true);
    expect(inHiddenTab(serie)).toBe(false);
    expect(film.closest("[inert]")).not.toBeNull();
  });
});

describe("les listes personnelles redemandées", () => {
  const mutate = vi.fn();
  let fullScreen = false;

  beforeEach(() => {
    vi.resetModules();
    mutate.mockReset();
    fullScreen = false;
    vi.doMock("swr", () => ({ useSWRConfig: () => ({ mutate }) }));
    vi.doMock("@/lib/playbackBusy", () => ({ isWatchingFullScreen: () => fullScreen }));
  });
  afterEach(() => {
    vi.doUnmock("swr");
    vi.doUnmock("@/lib/playbackBusy");
    vi.restoreAllMocks();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  const setVisibility = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  it("pas à l'arrivée, mais à chaque changement d'onglet", async () => {
    const { useFreshPersonalLists, PERSONAL_LIST_KEYS } = await import("@/lib/freshLists");
    let t = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);
    const { rerender } = renderHook(({ tab }) => useFreshPersonalLists(tab), { initialProps: { tab: "movies" } });
    expect(mutate).not.toHaveBeenCalled();
    t += 10_000;
    rerender({ tab: "series" });
    expect(mutate.mock.calls.map(([k]) => k)).toEqual([...PERSONAL_LIST_KEYS]);
  });

  it("au retour de l'application au premier plan, une fois pour deux retours rapprochés", async () => {
    const { useFreshPersonalLists } = await import("@/lib/freshLists");
    let t = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);
    renderHook(() => useFreshPersonalLists("movies"));
    setVisibility("hidden");
    setVisibility("visible");
    const once = mutate.mock.calls.length;
    expect(once).toBeGreaterThan(0);
    t += 1000;
    setVisibility("visible");
    expect(mutate.mock.calls.length).toBe(once);
  });

  it("rien pendant un film en plein écran — SWR y est en pause, la requête serait perdue", async () => {
    const { useFreshPersonalLists } = await import("@/lib/freshLists");
    fullScreen = true;
    renderHook(() => useFreshPersonalLists("movies"));
    setVisibility("visible");
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("chaque onglet garde sa hauteur (25/09/2026)", () => {
  /**
   * Les deux onglets gardés partagent le conteneur qui défile : descendre dans les films faisait
   * arriver les séries à la même hauteur, et inversement.
   */
  function Pane({ tab, ready = true }: { tab: "movies" | "series"; ready?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useTabScrollMemory(ref, tab, ready);
    return <div ref={ref} data-testid="pane" />;
  }
  const scrollPane = (el: HTMLElement, top: number) => {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  };

  it("retrouve la hauteur de chaque onglet, et commence en haut à la première visite", () => {
    const { rerender, getByTestId } = render(<Pane tab="movies" />);
    const pane = getByTestId("pane");
    scrollPane(pane, 1200);

    rerender(<Pane tab="series" />);
    expect(pane.scrollTop).toBe(0);
    scrollPane(pane, 300);

    rerender(<Pane tab="movies" />);
    expect(pane.scrollTop).toBe(1200);

    rerender(<Pane tab="series" />);
    expect(pane.scrollTop).toBe(300);
  });

  it("replace l'onglet quand son catalogue arrive après lui", () => {
    const { rerender, getByTestId } = render(<Pane tab="series" ready={false} />);
    const pane = getByTestId("pane");
    // Le navigateur se raccroche ailleurs quand les rangées arrivent d'un coup.
    pane.scrollTop = 5000;
    rerender(<Pane tab="series" ready />);
    expect(pane.scrollTop).toBe(0);
  });
});
