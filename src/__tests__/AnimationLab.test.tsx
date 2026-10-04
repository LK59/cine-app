// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";

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
  it("monte chacun de ses six lots", () => {
    render(<AnimationLab />);
    for (const name of ["Gestes d'appui", "Matières", "Apparition du flou", "Groupes et métamorphoses", "Défilement sous verre", "Lecteur simulé"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
      expect(screen.getAllByRole("button").length).toBeGreaterThan(5);
    }
  });

  it("ouvre le menu des sous-titres depuis sa pilule, puis le referme au choix d'une piste", async () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Lecteur simulé/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sous-titres" }));
    expect(screen.getByText("Suomi")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("English"));
    });
    expect(screen.queryByText("Suomi")).toBeNull();
  });

  it("garde sa zone de toucher élargie sur les pilules du geste liquide", () => {
    const { container } = render(<AnimationLab />);
    const pills = container.querySelectorAll(".alab-sim .alab-pill");
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) expect(pill.classList.contains("alab-slop")).toBe(true);
  });
});
