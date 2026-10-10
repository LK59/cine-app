// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

// Le catalogue : vide — la page doit se dessiner sans image, sur son dégradé de secours.
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));

import { AnimationLab } from "@/components/animlab/AnimationLab";
import { SheetOpenLot } from "@/components/animlab/IntroLots";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

// jsdom n'a ni Web Animations ni ResizeObserver : des doublures minimales, qui rendent une
// animation déjà finie — la page ne doit dépendre de rien d'autre pour se monter.
beforeAll(() => {
  const finished = () => ({ id: "", playState: "finished", finished: Promise.resolve(), cancel() {} });
  Object.assign(Element.prototype, { animate: finished, getAnimations: () => [] });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

describe("la page Tests animations", () => {
  it("monte chacun de ses huit lots", () => {
    render(<AnimationLab />);
    for (const name of ["Gestes d'appui", "Matières", "Apparition du flou", "Groupes et métamorphoses", "Défilement sous verre", "Lecteur simulé", "Lancement de la lecture", "Ouverture de fiche"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
      expect(screen.getAllByRole("button").length).toBeGreaterThan(5);
    }
  });

  it("ouvre le menu des sous-titres depuis sa pilule, puis le referme au choix d'une piste", async () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Lecteur simulé/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sous-titres" }));
    expect(screen.getByText("Suomi")).toBeTruthy();
    fireEvent.click(screen.getByText("English"));
    // Rendue à la pilule une fois le ressort revenu près de sa forme, puis après un court fondu.
    await waitFor(() => expect(screen.queryByText("Suomi")).toBeNull(), { timeout: 3000 });
    // Un sous-titre choisi : le point sous l'icône.
    expect(screen.getByRole("button", { name: "Sous-titres" }).hasAttribute("data-active")).toBe(true);
  });

  it("ouvre aussi le menu vitesse depuis la pilule", () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Lecteur simulé/ }));
    fireEvent.click(screen.getByRole("button", { name: "Vitesse" }));
    expect(screen.getByText("1,25×")).toBeTruthy();
  });

  it("garde sa zone de toucher élargie sur les pilules du geste liquide", () => {
    const { container } = render(<AnimationLab />);
    const pills = container.querySelectorAll(".alab-sim .alab-pill");
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) expect(pill.classList.contains("alab-slop")).toBe(true);
  });

  it("propose les réglages des deux prototypes du 10/10 : ouverture de la lecture et affiche qui se déploie", () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Lancement de la lecture/ }));
    expect(screen.getByText("Délai simulé")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Lueur sur le logo/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ouverture de fiche/ }));
    expect(screen.getByRole("button", { name: /Ressort Apple/ })).toBeTruthy();
  });

  it("deuxième passe : fonds de qualité pour la lecture, maquette fidèle aux fiches pour l'ouverture", () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Lancement de la lecture/ }));
    // Le fond par défaut est net, en 1 280 px (le flou se voyait) ; l'ancien reste pour comparer.
    expect(screen.getByRole("button", { name: "Net" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Ancien/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ouverture de fiche/ }));
    expect(screen.getByRole("button", { name: "Téléphone" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cascade du contenu" }).getAttribute("aria-pressed")).toBe("true");
    // Sans catalogue, pas de maquette à ouvrir.
    expect((screen.getByRole("button", { name: /Chargement du catalogue/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("troisième passe : la luminosité du fond se règle, et part du voile d'origine", () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Lancement de la lecture/ }));
    const slider = screen.getByLabelText(/Luminosité du fond/) as HTMLInputElement;
    expect(slider.value).toBe("0");
    expect(screen.getByText(/voile d'origine/)).toBeTruthy();
    fireEvent.change(slider, { target: { value: "20" } });
    expect(screen.getByText(/Luminosité du fond \+20 %/)).toBeTruthy();
  });

  it("quatrième passe : 250 ms par défaut, plus de View Transitions, les courbes expliquées", () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Ouverture de fiche/ }));
    expect((screen.getByLabelText(/^Durée 250 ms/) as HTMLInputElement).min).toBe("150");
    // Le ressort dure ce qu'on lui demande : 250 ms en jouaient 320 quand la réponse était la durée.
    const real = Number(/ressort : (\d+) ms réels/.exec(screen.getByText(/ms réels/).textContent ?? "")?.[1]);
    expect(real).toBeGreaterThanOrEqual(230);
    expect(real).toBeLessThanOrEqual(300);
    expect(screen.queryByRole("button", { name: /View Transitions/ })).toBeNull();
    expect(screen.getByText(/cubic-bezier\(0\.2, 0, 0, 1\)/)).toBeTruthy();
  });

  it("quatrième passe : au téléphone, la bannière de la fiche se tire vers le bas comme la vraie", () => {
    const movie = (id: number): CinemaMovie =>
      ({
        radarrId: id, title: `Film ${id}`, year: 2020, genres: [], quality: null, runtimeMinutes: 100, overview: "",
        posterUrl: `/p${id}.jpg`, backdropUrl: `/b${id}.jpg`, logoUrl: `/l${id}.png`,
      }) as unknown as CinemaMovie;
    render(<SheetOpenLot movies={[movie(1), movie(2), movie(3), movie(4)]} />);
    fireEvent.click(screen.getByRole("button", { name: "Téléphone" }));
    fireEvent.click(screen.getByRole("button", { name: /Ouvrir la maquette/ }));
    fireEvent.click(screen.getAllByRole("img", { name: "Film 4" })[0].closest("button")!);
    // La poignée : la bannière, rendue au geste (`touch-action: none`), la croix tenue à part.
    const handle = document.querySelector<HTMLElement>('[style*="touch-action: none"]');
    expect(handle).toBeTruthy();
    expect(handle!.querySelector('[aria-label="Fermer la fiche"]')).toBeTruthy();
    const sheet = handle!.parentElement!;
    fireEvent.pointerDown(handle!, { clientY: 100, pointerId: 1, button: 0, pointerType: "touch" });
    fireEvent.pointerMove(handle!, { clientY: 120, pointerId: 1, pointerType: "touch" });
    expect(sheet.style.transform).toBe("translateY(20px)");
    // Relâchée en deçà du seuil (et trop courte pour un lancer), elle revient en place.
    fireEvent.pointerUp(handle!, { clientY: 120, pointerId: 1, pointerType: "touch" });
    expect(sheet.style.transform).toBe("");
    // Au-delà : elle se ferme depuis là où le doigt l'a laissée, sans filer d'abord au bas de l'écran.
    fireEvent.pointerDown(handle!, { clientY: 100, pointerId: 1, button: 0, pointerType: "touch" });
    fireEvent.pointerMove(handle!, { clientY: 400, pointerId: 1, pointerType: "touch" });
    fireEvent.pointerUp(handle!, { clientY: 400, pointerId: 1, pointerType: "touch" });
    expect(sheet.style.transform).toBe("translateY(300px)");
    expect(sheet.style.pointerEvents).toBe("none");
  });
});
