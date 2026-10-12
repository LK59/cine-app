// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, configure } from "@testing-library/react";

// Les fiches s'animent sur de vraies minuteries : sous la charge d'un `docker compose build` (le
// Dockerfile lance la suite), 1 s d'attente par défaut ne suffisait pas toujours (12/10/2026).
configure({ asyncUtilTimeout: 5000 });
import { SWRConfig } from "swr";
import { Suspense, lazy, createElement, type ComponentType } from "react";

/**
 * Rouvrir une fiche déjà dans la pile (DECISIONS.md §74).
 *
 * Le blocage signalé par Louis sur iPhone en 8.45.0 : série → actrice → un de ses films → la même
 * actrice → fermer l'actrice, fermer le film. L'écran restait sombre, la fiche de l'actrice
 * semblait attendue et n'était pas là, et plus rien ne répondait au doigt.
 *
 * La coquille rendait la fiche personne sous la clé de l'acteur seul. L'actrice ouverte depuis la
 * série (sous le film, au cran 2) et celle rouverte depuis le film (au cran 4) étaient donc **la
 * même instance React** — deux entrées de la pile, un seul état. Refermée au doigt au cran 4, elle
 * gardait l'état de son geste (`dismissed`, carte à `translateY(hauteur de l'écran)`, pointeurs
 * coupés), redevenait la fiche du dessous, puis la fiche du dessus au cran 2 avec ce même état :
 * invisible, transparente aux pointeurs, au-dessus d'une série rendue inerte par sa présence.
 *
 * Le test passe par la vraie coquille, la vraie fiche personne et le vrai historique de jsdom.
 */
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string) => k,
  useLocale: () => ({ locale: "fr" }),
}));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false }));
vi.mock("@/components/player/PlayerRail", () => ({ PlayerRail: () => null }));
vi.mock("@/components/player/PlayerBottomBar", () => ({ PlayerBottomBar: () => null }));
// Les écrans chargés à la demande : la fiche personne pour de vrai, le reste réduit à rien. La fiche
// découverte garde une trace, pour la variante qui passe par elle.
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<ComponentType<Record<string, unknown>>>) => {
    const source = loader.toString();
    if (source.includes("PlayerPersonSheet")) {
      const Lazy = lazy(() => loader().then((c) => ({ default: c })));
      return function LoadedSheet(props: Record<string, unknown>) {
        return createElement(Suspense, { fallback: null }, createElement(Lazy, props));
      };
    }
    if (source.includes("PlayerDiscoverSheet")) {
      return function DiscoverStub(props: { tmdbId: number }) {
        return createElement("div", { "data-discover": props.tmdbId });
      };
    }
    return function Nothing() {
      return null;
    };
  },
}));
vi.mock("@/lib/prefetch", () => ({ preloadQuietly: () => Promise.resolve() }));
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (url: string) =>
    url.includes("/photos")
      ? { photos: [] }
      : url.includes("/enriched")
        ? { photos: [], instagram: null, imdb: null, wikipedia: null, wikiBio: null }
        : { name: `Actrice ${url}`, biography: "", credits: [] },
}));

import { PlayerShell } from "@/components/player/PlayerShell";
import { cinemaClose, cinemaNavigate, openLibraryTitle, readCinemaRoute } from "@/lib/cinemaRoute";
import { personSheetKey } from "@/lib/cinemaRoute";

const SERIE = 41;
const FILM = 603;
const ACTRICE = 1245;
const AUTRE_FILM = 604;

function draw() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PlayerShell />
    </SWRConfig>
  );
}

/** Attend le `popstate` d'un retour : jsdom le livre au tour suivant, comme un navigateur. */
async function back(close: () => void) {
  const arrived = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
  act(() => close());
  await act(async () => {
    await arrived;
  });
}
/** Le sursis de sortie de la coquille (`SHEET_OUT_MS + SHEET_UNMOUNT_SLACK_MS` sur téléphone). */
const outlast = () => act(() => new Promise((r) => setTimeout(r, 700)));

const dialogs = () => Array.from(document.body.querySelectorAll<HTMLElement>("[role=dialog]"));
const rootOf = (dialog: HTMLElement) => dialog.parentElement as HTMLElement;

/** Ferme la fiche personne du dessus comme un doigt : on tire la poignée vers le bas et on lâche. */
async function swipeClosePerson() {
  const top = dialogs().find((d) => rootOf(d).style.zIndex === "48");
  expect(top).toBeDefined();
  const handle = top!.querySelector<HTMLElement>("[style*='touch-action']")!;
  const pointer = (type: string, clientY: number) =>
    act(() => void handle.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY })));
  const arrived = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
  pointer("pointerdown", 100);
  pointer("pointermove", 600);
  pointer("pointerup", 600);
  // La fermeture part deux images après le relâchement (`closeAfterSlideStarts`).
  await act(async () => {
    await arrived;
  });
}

/**
 * Ce que l'écran doit dire quand une personne est le haut de la pile : une seule fiche du dessus,
 * visible, qui reçoit les pointeurs — jamais un voile sans carte.
 */
function expectLivePersonOnTop() {
  const tops = dialogs().filter((d) => rootOf(d).style.zIndex === "48");
  expect(tops).toHaveLength(1);
  const [card] = tops;
  const root = rootOf(card);
  expect(root.style.pointerEvents).not.toBe("none");
  // La carte est à sa place, pas restée là où le geste l'avait jetée.
  expect(card.style.transform === "" || card.style.transform === "translateY(0px)").toBe(true);
  const scrim = root.querySelector<HTMLElement>("[data-person-scrim]")!;
  expect(scrim.style.opacity).not.toBe("0");
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("rouvrir une fiche personne déjà dans la pile", () => {
  it("série → actrice → film → même actrice, fermée au doigt, puis le film : l'actrice revient vivante", async () => {
    draw();
    act(() => openLibraryTitle("series", SERIE));
    act(() => cinemaNavigate({ person: ACTRICE }));
    await waitFor(() => expect(dialogs()).toHaveLength(1));
    act(() => openLibraryTitle("movie", FILM));
    await outlast();
    act(() => cinemaNavigate({ person: ACTRICE }));
    await waitFor(() => expect(dialogs().some((d) => rootOf(d).style.zIndex === "48")).toBe(true));
    expectLivePersonOnTop();

    await swipeClosePerson();
    expect(readCinemaRoute()).toMatchObject({ film: FILM, person: null });
    await outlast();
    // Sous le film : rien au-dessus de lui.
    expect(dialogs().filter((d) => rootOf(d).style.zIndex === "48")).toHaveLength(0);

    await back(() => cinemaClose({ film: null, serie: null }));
    expect(readCinemaRoute()).toMatchObject({ serie: SERIE, person: ACTRICE, film: null });
    await outlast();
    expectLivePersonOnTop();

    // Et elle se referme encore : on retombe sur la série seule, sans voile.
    await back(() => cinemaClose({ person: null }));
    await outlast();
    expect(readCinemaRoute()).toMatchObject({ serie: SERIE, person: null });
    expect(document.body.querySelector("[data-person-scrim]")).toBeNull();
  });

  it("fermée à la croix plutôt qu'au doigt, même issue", async () => {
    draw();
    act(() => openLibraryTitle("series", SERIE));
    act(() => cinemaNavigate({ person: ACTRICE }));
    await waitFor(() => expect(dialogs()).toHaveLength(1));
    act(() => openLibraryTitle("movie", FILM));
    await outlast();
    act(() => cinemaNavigate({ person: ACTRICE }));
    await waitFor(() => expect(dialogs().some((d) => rootOf(d).style.zIndex === "48")).toBe(true));
    await back(() => cinemaClose({ person: null }));
    await outlast();
    await back(() => cinemaClose({ film: null, serie: null }));
    await outlast();
    expectLivePersonOnTop();
  });

  it("par une fiche découverte (film absent de la bibliothèque), même issue", async () => {
    draw();
    act(() => openLibraryTitle("series", SERIE));
    act(() => cinemaNavigate({ person: ACTRICE }));
    await waitFor(() => expect(dialogs()).toHaveLength(1));
    act(() => cinemaNavigate({ discover: 9999, discoverType: "movie", person: null }));
    await outlast();
    act(() => cinemaNavigate({ person: ACTRICE }));
    await waitFor(() => expect(dialogs().some((d) => rootOf(d).style.zIndex === "48")).toBe(true));
    await swipeClosePerson();
    await outlast();
    await back(() => cinemaClose({ discover: null }));
    await outlast();
    expect(readCinemaRoute()).toMatchObject({ serie: SERIE, person: ACTRICE, discover: null });
    expectLivePersonOnTop();
  });

  it("la même actrice depuis deux films différents : chaque cran a sa fiche", async () => {
    draw();
    act(() => openLibraryTitle("series", SERIE));
    act(() => cinemaNavigate({ person: ACTRICE }));
    act(() => openLibraryTitle("movie", FILM));
    await outlast();
    act(() => cinemaNavigate({ person: ACTRICE }));
    await waitFor(() => expect(dialogs().some((d) => rootOf(d).style.zIndex === "48")).toBe(true));
    act(() => openLibraryTitle("movie", AUTRE_FILM));
    await outlast();
    act(() => cinemaNavigate({ person: ACTRICE }));
    await waitFor(() => expect(dialogs().some((d) => rootOf(d).style.zIndex === "48")).toBe(true));
    // Trois fois fermée au doigt, trois films/actrice redescendus : à chaque actrice retrouvée, elle vit.
    await swipeClosePerson();
    await outlast();
    await back(() => cinemaClose({ film: null, serie: null }));
    await outlast();
    expect(readCinemaRoute()).toMatchObject({ film: FILM, person: ACTRICE });
    expectLivePersonOnTop();
    await swipeClosePerson();
    await outlast();
    await back(() => cinemaClose({ film: null, serie: null }));
    await outlast();
    expect(readCinemaRoute()).toMatchObject({ serie: SERIE, person: ACTRICE });
    expectLivePersonOnTop();
  });

  it("fermer deux fois très vite ne recule que d'un cran et ne laisse pas de voile seul", async () => {
    draw();
    act(() => openLibraryTitle("series", SERIE));
    act(() => cinemaNavigate({ person: ACTRICE }));
    act(() => openLibraryTitle("movie", FILM));
    await outlast();
    act(() => cinemaNavigate({ person: ACTRICE }));
    await waitFor(() => expect(dialogs().some((d) => rootOf(d).style.zIndex === "48")).toBe(true));
    const arrived = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    act(() => {
      cinemaClose({ person: null });
      cinemaClose({ person: null });
    });
    await act(async () => {
      await arrived;
    });
    await outlast();
    expect(readCinemaRoute()).toMatchObject({ film: FILM, person: null });
    await back(() => cinemaClose({ film: null, serie: null }));
    await outlast();
    expectLivePersonOnTop();
  });

  it("un retour du navigateur au milieu de la sortie : l'actrice retrouvée vit", async () => {
    draw();
    act(() => openLibraryTitle("series", SERIE));
    act(() => cinemaNavigate({ person: ACTRICE }));
    act(() => openLibraryTitle("movie", FILM));
    await outlast();
    act(() => cinemaNavigate({ person: ACTRICE }));
    await waitFor(() => expect(dialogs().some((d) => rootOf(d).style.zIndex === "48")).toBe(true));
    await swipeClosePerson();
    // Pas d'attente : le geste de retour d'iOS arrive pendant que la carte descend encore.
    await back(() => window.history.back());
    await outlast();
    expect(readCinemaRoute()).toMatchObject({ serie: SERIE, person: ACTRICE, film: null });
    expectLivePersonOnTop();
  });
});

describe("personSheetKey", () => {
  it("distingue deux entrées de la pile pour la même personne", () => {
    expect(personSheetKey(ACTRICE, 2)).not.toBe(personSheetKey(ACTRICE, 4));
    expect(personSheetKey(ACTRICE, 2)).toBe(personSheetKey(ACTRICE, 2));
  });
});
