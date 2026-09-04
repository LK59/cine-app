// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CinemaOverview } from "@/components/cinema/CinemaDetailLayout";

afterEach(() => cleanup());

/** jsdom ne met rien en page : la troncature se simule en fixant les deux hauteurs. */
function clampTo(truncated: boolean) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return truncated ? 100 : 40; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 40 });
}

describe("le synopsis d'une fiche cinéma", () => {
  it("propose d'en voir plus seulement quand il est coupé", async () => {
    clampTo(false);
    render(<CinemaOverview text="Court." readMore="Voir plus" readLess="Voir moins" />);
    expect(screen.queryByText("Voir plus")).not.toBeInTheDocument();
  });

  it("se déplie au clic, et se replie", async () => {
    clampTo(true);
    const user = userEvent.setup();
    render(<CinemaOverview text="Un très long synopsis." readMore="Voir plus" readLess="Voir moins" />);

    expect(screen.getByText("Voir plus")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Voir moins")).toBeInTheDocument();
  });

  it("rejoint le parcours des flèches, avec un repère qui n'est pas le sélecteur blanc", () => {
    clampTo(true);
    render(<CinemaOverview text="Un très long synopsis." readMore="Voir plus" readLess="Voir moins" />);
    const row = screen.getByRole("button");
    expect(row).toHaveAttribute("data-detail-menu");
    expect(row.className).toContain("focus-visible:bg-white/12");
    expect(row.className.split(/\s+/)).not.toContain("focus-visible:bg-white");
  });

  it("laisse le texte sélectionnable, bien qu'il soit dans un bouton", () => {
    clampTo(true);
    render(<CinemaOverview text="Un très long synopsis." readMore="Voir plus" readLess="Voir moins" />);
    expect(screen.getByText("Un très long synopsis.").className).toContain("select-text");
  });
});
