// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const toastInfo = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ info: toastInfo }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));

import { useRetainedTitle, useRetiredTitleGuard } from "@/lib/useRetainedTitle";
import { playBlockedByRetired } from "@/lib/retiredTitle";

/**
 * Une fiche ouverte sur un titre que la relecture du catalogue vient de retirer (§94) : elle reste
 * ouverte, et sa Lecture est refusée avec un message — rien ne s'ouvre, rien ne plante.
 */

type Title = { id: number; title: string };

function Sheet({ requested, live }: { requested: string | null; live: Title | null }) {
  const { item, retired } = useRetainedTitle(requested, live);
  useRetiredTitleGuard(retired);
  return <p data-testid="fiche">{item ? `${item.title}${retired ? " (retiré)" : ""}` : "aucune"}</p>;
}

afterEach(() => {
  cleanup();
  toastInfo.mockClear();
});

describe("useRetainedTitle", () => {
  it("le titre sorti du catalogue reste sur sa fiche, et la Lecture le dit au lieu d'ouvrir", () => {
    const dune = { id: 12, title: "Dune" };
    const { rerender } = render(<Sheet requested="film=12" live={dune} />);
    expect(playBlockedByRetired()).toBe(false);
    rerender(<Sheet requested="film=12" live={null} />);
    expect(screen.getByTestId("fiche").textContent).toBe("Dune (retiré)");
    expect(playBlockedByRetired()).toBe(true);
    expect(toastInfo).toHaveBeenCalledWith("cinema.titleRetired");
  });

  it("une autre adresse ne reprend pas le titre gardé — c'est l'affaire du filet", () => {
    const { rerender } = render(<Sheet requested="film=12" live={{ id: 12, title: "Dune" }} />);
    rerender(<Sheet requested="film=13" live={null} />);
    expect(screen.getByTestId("fiche").textContent).toBe("aucune");
    expect(playBlockedByRetired()).toBe(false);
  });

  it("revenu au catalogue, il redevient le sien ; refermée, la Lecture n'est plus refusée", () => {
    const { rerender, unmount } = render(<Sheet requested="film=12" live={{ id: 12, title: "Dune" }} />);
    rerender(<Sheet requested="film=12" live={null} />);
    rerender(<Sheet requested="film=12" live={{ id: 12, title: "Dune (2021)" }} />);
    expect(screen.getByTestId("fiche").textContent).toBe("Dune (2021)");
    expect(playBlockedByRetired()).toBe(false);
    rerender(<Sheet requested="film=12" live={null} />);
    unmount();
    expect(playBlockedByRetired()).toBe(false);
  });
});
