// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CinemaOverview, CinemaSynopsisModal } from "@/components/cinema/CinemaDetailLayout";

afterEach(() => cleanup());

/** jsdom ne met rien en page : la troncature se simule en fixant les deux hauteurs. */
function clampTo(truncated: boolean) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return truncated ? 100 : 40; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 40 });
}

describe("le résumé d'une fiche cinéma", () => {
  it("ne propose d'en voir plus que lorsqu'il est réellement coupé", () => {
    clampTo(false);
    const onOpen = vi.fn();
    render(<CinemaOverview text="Court." readMore="Voir plus" onOpen={onOpen} />);
    expect(screen.queryByText("Voir plus")).not.toBeInTheDocument();
  });

  it("n'ouvre rien quand il tient en entier", async () => {
    clampTo(false);
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<CinemaOverview text="Court." readMore="Voir plus" onOpen={onOpen} />);

    await user.click(screen.getByRole("button"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("demande l'ouverture de la fenêtre quand il est coupé", async () => {
    clampTo(true);
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<CinemaOverview text="Un très long synopsis." readMore="Voir plus" onOpen={onOpen} />);

    expect(screen.getByText("Voir plus")).toBeInTheDocument();
    await user.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalled();
  });

  it("rejoint le parcours des flèches, avec un repère qui n'est pas le sélecteur blanc", () => {
    clampTo(true);
    render(<CinemaOverview text="Long." readMore="Voir plus" onOpen={vi.fn()} />);
    const row = screen.getByRole("button");
    expect(row).toHaveAttribute("data-detail-menu");
    expect(row.className).toContain("focus-visible:bg-white/12");
    expect(row.className.split(/\s+/)).not.toContain("focus-visible:bg-white");
  });

  /** Le focus d'arrivée vise la première action ; le résumé la précède dans la page. */
  it("ne se présente pas comme une action de la fiche", () => {
    clampTo(true);
    const { container } = render(<CinemaOverview text="Long." readMore="Voir plus" onOpen={vi.fn()} />);
    expect(container.querySelector("[data-detail-actions]")).toBeNull();
  });

  it("laisse le texte sélectionnable, bien qu'il soit dans un bouton", () => {
    clampTo(true);
    render(<CinemaOverview text="Un très long synopsis." readMore="Voir plus" onOpen={vi.fn()} />);
    expect(screen.getByText("Un très long synopsis.").className).toContain("select-text");
  });
});

describe("la fenêtre du synopsis", () => {
  function open(onClose = vi.fn()) {
    render(<CinemaSynopsisModal title="Sunshine" text="Le soleil se meurt." closeLabel="Fermer" onClose={onClose} />);
    return onClose;
  }

  it("s'annonce comme une fenêtre, avec le titre du film", () => {
    open();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Sunshine");
    expect(screen.getByText("Le soleil se meurt.")).toBeInTheDocument();
  });

  it("prend le focus sur sa fermeture, pour que Entrée referme", () => {
    open();
    expect(document.activeElement).toBe(screen.getByLabelText("Fermer"));
  });

  /**
   * La fiche écoute Échap sur `window` elle aussi : sans capture ni arrêt de propagation, la
   * même touche fermait la fenêtre *et* la fiche derrière elle.
   */
  it("garde Échap pour elle", async () => {
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    const onClose = open();

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    expect(behind).not.toHaveBeenCalled();
    window.removeEventListener("keydown", behind);
  });

  it("se ferme aussi d'un clic à côté, mais pas d'un clic dedans", async () => {
    const onClose = open();
    const user = userEvent.setup();

    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalled();
  });
});
