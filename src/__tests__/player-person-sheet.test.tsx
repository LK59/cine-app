// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Le coût de la fiche personne, et pourquoi il se mesure.
 *
 * Relevé sur TMDB depuis cette installation : soixante-seize titres pour Ryan Gosling, cent
 * cinquante-huit pour Brad Pitt. Une grille de cent cinquante-huit cartes construite d'un seul
 * coup se sent sur un téléphone — c'est le micro-blocage signalé le 19/09/2026 « autour de la
 * fiche personne ». Les images sont déjà différées par le navigateur ; ce qui coûte est le nombre
 * de nœuds et le travail de React.
 */
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string) => k,
  useLocale: () => ({ locale: "fr" }),
}));
// eslint-disable-next-line @next/next/no-img-element
vi.mock("@/components/PosterImage", () => ({ PosterImage: ({ alt }: { alt: string }) => <img alt={alt} /> }));
// La vraie carte, rendus comptés — voir « ne redessine pas la filmographie pendant un glissement ».
const cardRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/components/player/PlayerResultCard", async (importOriginal) => {
  const { memo, createElement } = await import("react");
  const original = await importOriginal<typeof import("@/components/player/PlayerResultCard")>();
  // Même mémorisation que l'original : c'est elle que la fiche doit laisser jouer.
  const Counted = memo(function Counted(props: Parameters<typeof original.PlayerResultCard>[0]) {
    cardRenders.count += 1;
    return createElement(original.PlayerResultCard, props);
  });
  return { ...original, PlayerResultCard: Counted };
});
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false }));

const credits = Array.from({ length: 60 }, (_, i) => ({
  tmdbId: 1000 + i,
  mediaType: "movie",
  title: `Film ${i}`,
  year: 2000,
  posterPath: null,
  inLibrary: false,
  libraryId: null,
  character: "",
}));
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (url: string) =>
    url.includes("/photos")
      ? { photos: [] }
      : url.includes("/enriched")
        ? { photos: [], instagram: null, imdb: "https://www.imdb.com/name/nm1", wikipedia: null, wikiBio: "Bio Wikipédia." }
        : { name: "Acteur", biography: "", credits },
}));

const cinemaClose = vi.fn();
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  cinemaClose: (...a: unknown[]) => cinemaClose(...a),
}));

import { PlayerPersonSheet } from "@/components/player/PlayerPersonSheet";

const cardCount = () => screen.queryAllByText(/^Film \d+$/).length;
const draw = (props: { tmdbId: number; underneath?: boolean }) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PlayerPersonSheet {...props} />
    </SWRConfig>
  );
/**
 * Le temps mort, tenu à la main.
 *
 * Écrit d'abord avec une attente réelle, ce test passait seul et échouait dans la suite complète :
 * il dépendait de l'instant où le navigateur décide qu'il n'a rien à faire, ce qui n'est pas une
 * propriété du code. On capture donc le rappel et on le déclenche soi-même.
 */
let idleCallbacks: (() => void)[] = [];
beforeEach(() => {
  idleCallbacks = [];
  // Des poignées réelles, pour qu'une annulation annule : un rappel programmé avant un geste ne
  // doit pas s'exécuter après, comme dans un navigateur.
  const handles = new Map<number, () => void>();
  let next = 0;
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
    const handle = ++next;
    handles.set(handle, cb);
    idleCallbacks.push(cb);
    return handle;
  });
  vi.stubGlobal("cancelIdleCallback", (handle: number) => {
    const cb = handles.get(handle);
    if (cb) idleCallbacks = idleCallbacks.filter((c) => c !== cb);
    handles.delete(handle);
  });
});
/**
 * Tous les temps morts, jusqu'au dernier : la filmographie arrive maintenant par paquets, chacun
 * programmant le suivant.
 */
const settle = async () => {
  // Un `act` par tour : dans un seul, les mises à jour attendent la fin et l'effet qui programme
  // le paquet suivant ne tourne jamais entre deux.
  for (let i = 0; i < 20 && idleCallbacks.length > 0; i++) {
    const pending = idleCallbacks;
    idleCallbacks = [];
    await act(async () => pending.forEach((cb) => cb()));
  }
};
/**
 * La fin de l'entrée. jsdom n'anime rien et React n'y reçoit pas `animationend` : c'est le minuteur
 * de secours de la fiche qui la déclare posée — le chemin qu'on prend aussi quand l'évènement ne
 * vient pas pour de vrai (onglet caché, mouvement réduit). On l'attend donc, tout simplement.
 */
const finishEntry = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 500)));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PlayerPersonSheet — la filmographie", () => {
  it("dessine de quoi remplir l'écran, puis tout le reste", async () => {
    draw({ tmdbId: 1 });
    await screen.findByText("Film 0");
    // De quoi remplir l'écran à toutes les densités, et rien de plus, à la première image.
    expect(cardCount()).toBe(18);

    // Rien de plus tant que la carte glisse : c'est là que l'à-coup se voyait (banc du 21/09).
    await settle();
    expect(cardCount()).toBe(18);

    // Puis, une fois posée, le reste par paquets — chacun une image courte.
    await finishEntry();
    await settle();
    expect(cardCount()).toBe(60);
  });

  it("n'ajoute la suite que par paquets, jamais d'un coup", async () => {
    draw({ tmdbId: 9 });
    await screen.findByText("Film 0");
    await finishEntry();
    // Un seul temps mort : un paquet, pas toute la filmographie.
    await act(async () => {
      const pending = idleCallbacks;
      idleCallbacks = [];
      pending.forEach((cb) => cb());
    });
    expect(cardCount()).toBe(18 + 24);
  });

  it("garde photos, liens et biographie pour après l'entrée", async () => {
    draw({ tmdbId: 10 });
    await screen.findByText("Film 0");
    await settle();
    expect(screen.queryByText("Bio Wikipédia.")).toBeNull();
    await finishEntry();
    expect(await screen.findByText("Bio Wikipédia.")).toBeTruthy();
  });

  /**
   * La mise en scène se règle sur l'arrivée des données, pas sur le montage.
   *
   * Écrite d'abord sur le montage, elle ne servait jamais : la filmographie vient d'une requête,
   * et le temps mort passait avant elle — soixante cartes dès la première image. Ce test-ci est
   * précisément celui qui l'a montré.
   */
  it("reste bornée sous une fiche de film, où personne ne la fera défiler", async () => {
    draw({ tmdbId: 2, underneath: true });
    await screen.findByText("Film 0");
    await settle();
    expect(cardCount()).toBe(18);
  });

  // Elle est recouverte par une fiche pleine : monter une rangée de photos qu'on ne verra pas
  // coûterait du fil d'exécution à l'instant précis où le film du dessus se monte.
  it("n'a pas d'avis quand elle est dessous : ni photos, ni Échap", async () => {
    draw({ tmdbId: 3, underneath: true });
    await screen.findByText("Film 0");
    expect(screen.queryByText("player.person.photos")).toBeNull();
  });
});

describe("PlayerPersonSheet — la fiche de la gestion, transposée", () => {
  // Le 21/09/2026 : la fiche acteur de la gestion (résumé, liens, photos, bio Wikipédia,
  // filmographie en deux temps, posée sur le titre) remplace la page plein écran du cinéma.
  it("donne les liens et la biographie de Wikipédia, avec sa source", async () => {
    draw({ tmdbId: 5 });
    await screen.findByText("Film 0");
    await finishEntry();
    expect(await screen.findByText("Bio Wikipédia.")).toBeTruthy();
    expect(screen.getByText("modals.actor.sourceWikipedia")).toBeTruthy();
    expect(screen.getByText("IMDb").closest("a")?.getAttribute("href")).toBe("https://www.imdb.com/name/nm1");
  });

  it("sépare ce qui se regarde ce soir de ce qui reste à découvrir", async () => {
    draw({ tmdbId: 6 });
    await screen.findByText("Film 0");
    // Aucune des soixante n'est dans la bibliothèque : un seul groupe, celui du reste.
    expect(screen.queryByText("modals.actor.inLibrary")).toBeNull();
    expect(screen.getByText("player.person.elsewhere")).toBeTruthy();
  });

  it("se referme en touchant le voile, sauf quand elle est dessous", async () => {
    cinemaClose.mockClear();
    const { unmount } = draw({ tmdbId: 7 });
    await screen.findByText("Film 0");
    const voile = () => document.body.querySelector("[data-person-scrim]") as HTMLElement;
    act(() => voile().click());
    expect(cinemaClose).toHaveBeenCalledWith({ person: null });
    unmount();

    cinemaClose.mockClear();
    draw({ tmdbId: 8, underneath: true });
    await screen.findByText("Film 0");
    act(() => voile().click());
    expect(cinemaClose).not.toHaveBeenCalled();
  });

  it("monte comme les autres fiches dès que la mise en page est celle du téléphone", async () => {
    // Téléphone couché (23/09/2026) : plus de 768 px de large, donc `md:` prenait la main sur
    // l'animation alors que la mise en page, elle, restait celle du téléphone. `useIsMobile` est
    // simulé vrai dans ce fichier : c'est l'écran à plus de 768 px qui le dit mobile.
    draw({ tmdbId: 9 });
    await screen.findByText("Film 0");
    const card = screen.getByRole("dialog");
    expect(card.className).toContain("sheet-in");
    expect(card.className).not.toMatch(/\bmd:animate-/);
  });

  it("ne redessine pas la filmographie pendant un glissement", async () => {
    // 23/09/2026 : la fermeture au doigt des fiches personne saccadait. La position de la carte
    // vit dans l'état du geste, donc chaque mouvement redessinait la fiche — et la filmographie,
    // recréée à chaque rendu, reconstruisait toutes ses cartes à chaque pixel.
    draw({ tmdbId: 11 });
    await screen.findByText("Film 0");
    const handle = screen.getByRole("dialog").querySelector<HTMLElement>("[style*='touch-action']")!;
    const pointer = (type: string, clientY: number) =>
      act(() => void handle.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY })));
    pointer("pointerdown", 100);
    const before = cardRenders.count;
    expect(before).toBeGreaterThan(0);
    for (let y = 110; y <= 200; y += 10) pointer("pointermove", y);
    expect(screen.getByRole("dialog").style.transform).toBe("translateY(100px)");
    expect(cardRenders.count).toBe(before);
    pointer("pointerup", 200);
  });

  it("au relâchement, le voile s'efface d'où il en est, sans repartir de plein", async () => {
    // 23/09/2026 : 0,6 → 0,2 → 1 → 0 en quelques images. L'opacité tombait d'un coup quand la
    // carte partait hors de l'écran, puis `fade-out` repartait de 1.
    draw({ tmdbId: 12 });
    await screen.findByText("Film 0");
    const handle = screen.getByRole("dialog").querySelector<HTMLElement>("[style*='touch-action']")!;
    const scrim = () => document.body.querySelector<HTMLElement>("[data-person-scrim]")!;
    const pointer = (type: string, clientY: number) =>
      act(() => void handle.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY })));
    pointer("pointerdown", 100);
    pointer("pointermove", 400);
    expect(scrim().style.transition).toBe("none");
    pointer("pointerup", 400);
    expect(scrim().style.opacity).toBe("0");
    expect(scrim().style.transition).toContain("opacity 280ms");
    expect(scrim().className).not.toContain("animate-fade-out");
  });

  it("ne pose aucun paquet de cartes pendant qu'on tire la fiche", async () => {
    // 23/09/2026 : un temps mort entre deux mouvements du doigt suffisait à poser vingt-quatre
    // cartes en plein glissement — la saccade « à certains moments ».
    draw({ tmdbId: 13 });
    await screen.findByText("Film 0");
    await finishEntry();
    const runIdle = () =>
      act(async () => {
        const pending = idleCallbacks;
        idleCallbacks = [];
        pending.forEach((cb) => cb());
      });
    const handle = screen.getByRole("dialog").querySelector<HTMLElement>("[style*='touch-action']")!;
    const pointer = (type: string, clientY: number) =>
      act(() => void handle.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY })));
    pointer("pointerdown", 100);
    pointer("pointermove", 130);
    await runIdle();
    expect(cardCount()).toBe(18);
    // Revenue en place, elle reprend.
    pointer("pointermove", 100);
    pointer("pointerup", 100);
    await runIdle();
    expect(cardCount()).toBe(18 + 24);
  });

  it("après un lancer, ferme deux images plus tard — pas dans le tour du relâchement", async () => {
    // 23/09/2026 : la fermeture partait avec le relâchement, et l'accueil se redessinait avant
    // que le navigateur ait lancé le glissement de la carte. Un seul mécanisme de sortie malgré
    // tout : l'appel est décalé, rien n'est gardé monté plus longtemps.
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    try {
      cinemaClose.mockClear();
      draw({ tmdbId: 14 });
      await screen.findByText("Film 0");
      const handle = screen.getByRole("dialog").querySelector<HTMLElement>("[style*='touch-action']")!;
      const pointer = (type: string, clientY: number) =>
        act(() => void handle.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY })));
      pointer("pointerdown", 100);
      pointer("pointermove", 400);
      pointer("pointerup", 400);
      expect(cinemaClose).not.toHaveBeenCalled();
      const flush = () => act(() => void frames.splice(0).forEach((cb) => cb(0)));
      flush();
      expect(cinemaClose).not.toHaveBeenCalled();
      flush();
      expect(cinemaClose).toHaveBeenCalledTimes(1);
      expect(cinemaClose).toHaveBeenCalledWith({ person: null });
    } finally {
      raf.mockRestore();
    }
  });
});

