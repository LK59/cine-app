// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { PlayerRequestCard } from "@/components/player/PlayerRequestCard";
import type { PlayerRequest } from "@/lib/playerRequests";

afterEach(cleanup);

const request = { id: 1, title: "Dune", year: 2021, poster: null, state: "processing", canCancel: true, libraryId: null, tmdbId: 438631 } as unknown as PlayerRequest;

// La confirmation vit dans la carte de verre des menus d'actions (`ActionSheet`), à la taille d'un
// doigt — elle était dessinée sur l'affiche, trop petite (07/10/2026). La feuille reste montée le
// temps de sa sortie : on attend qu'elle soit partie.
const gone = () => waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

describe("annuler une demande", () => {
  it("demande confirmation dans la feuille d'actions : la croix seule n'annule rien", async () => {
    const onCancel = vi.fn();
    render(<PlayerRequestCard request={request} busy={false} onOpen={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByLabelText("player.requests.cancel"));
    expect(onCancel).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    // Une fenêtre modale, portée hors de la carte : le panneau dessous laisse Échap à elle.
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.closest("[data-action-sheet]")).not.toBeNull();
    expect(screen.getByText("Dune", { selector: "[data-action-sheet] p" })).toBeTruthy();
    fireEvent.click(screen.getByText("player.requests.confirmYes"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await gone();
  });

  it("« Garder » et Échap referment sans annuler", async () => {
    const onCancel = vi.fn();
    render(<PlayerRequestCard request={request} busy={false} onOpen={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByLabelText("player.requests.cancel"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByText("player.requests.confirmNo"));
    await gone();
    fireEvent.click(screen.getByLabelText("player.requests.cancel"));
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await gone();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
