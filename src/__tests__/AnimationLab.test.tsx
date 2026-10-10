// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

// Le catalogue : vide — la page doit se dessiner sans image, sur son dégradé de secours.
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));

import { AnimationLab } from "@/components/animlab/AnimationLab";

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
    expect(screen.getByRole("button", { name: /FLIP manuel/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ressort Apple/ })).toBeTruthy();
  });
});
