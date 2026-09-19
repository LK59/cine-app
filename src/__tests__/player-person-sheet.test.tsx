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
    url.includes("/photos") ? { photos: [] } : { name: "Acteur", biography: "", credits },
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
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
    idleCallbacks.push(cb);
    return 1;
  });
  vi.stubGlobal("cancelIdleCallback", () => {});
});
const settle = () => act(async () => { idleCallbacks.forEach((cb) => cb()); });

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

    // Le reste suit au temps mort, donc bien avant qu'un doigt ait pu descendre jusque-là : rien
    // n'est retiré, seulement étalé sur deux images au lieu d'une.
    await settle();
    expect(cardCount()).toBe(60);
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
