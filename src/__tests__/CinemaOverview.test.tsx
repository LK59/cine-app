// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CinemaOverview, CinemaDetailModal } from "@/components/cinema/CinemaDetailLayout";

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
    render(<CinemaDetailModal title="Sunshine" closeLabel="Fermer" onClose={onClose}>
        <p>Le soleil se meurt.</p>
      </CinemaDetailModal>);
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
    // Après sa sortie (23/09/2026) — et c'est bien elle seule qui se ferme.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(behind).not.toHaveBeenCalled();
    window.removeEventListener("keydown", behind);
  });

  /**
   * Le symptôme du 21/09/2026 : une flèche dans la fenêtre de la distribution atteignait le menu
   * de la fiche, derrière elle — le film se gardait du synopsis mais pas de la distribution, la
   * série d'aucun des deux. Le focus partait sur « Lecture » sous la fenêtre, et Entrée lançait le
   * film. La fenêtre garde maintenant les flèches, pour toutes les fiches à la fois.
   */
  it.each(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])("garde %s pour elle", async (key) => {
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      open();
      await userEvent.keyboard(`{${key}}`);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });

  /**
   * Les fiches lui passent `onClose` en fonction fléchée, neuve à chaque rendu, et l'écran du
   * dessous se redessine tout seul (la bannière, toutes les huit secondes). L'effet qui en
   * dépendait reprenait le focus à chaque fois : on parcourait la distribution au clavier, et le
   * focus revenait sur la croix — Entrée refermait alors la fenêtre au lieu d'ouvrir l'acteur.
   */
  it("ne reprend pas le focus quand la fiche se redessine", async () => {
    const { rerender } = render(
      <CinemaDetailModal title="Distribution" closeLabel="Fermer" onClose={() => {}}>
        <button type="button">Cillian Murphy</button>
      </CinemaDetailModal>
    );
    const actor = screen.getByText("Cillian Murphy");
    actor.focus();

    const onClose = vi.fn();
    rerender(
      <CinemaDetailModal title="Distribution" closeLabel="Fermer" onClose={onClose}>
        <button type="button">Cillian Murphy</button>
      </CinemaDetailModal>
    );
    expect(document.activeElement).toBe(actor);

    // Et c'est bien le dernier `onClose` reçu qu'Échap appelle, pas celui du premier rendu.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("se ferme aussi d'un clic à côté, mais pas d'un clic dedans", async () => {
    const onClose = open();
    const user = userEvent.setup();

    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("dialog").parentElement!);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  /**
   * Elle entrait en fondu mais se fermait d'un coup, quand la bande-annonce voisine sortait
   * (23/09/2026). La sortie se joue d'abord ; la fermeture suit, une seule fois, et rien ne la
   * traverse entre-temps.
   */
  it("joue sa sortie avant de se fermer, et n'accepte plus de clic pendant", async () => {
    const onClose = open();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Fermer" }));
    const dialog = screen.getByRole("dialog");
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.className).toContain("animate-fade-out-scale");
    expect(dialog.parentElement!.className).toContain("pointer-events-none");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
