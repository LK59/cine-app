// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { PlayerRequestCard } from "@/components/player/PlayerRequestCard";
import type { PlayerRequest } from "@/lib/playerRequests";

afterEach(cleanup);

const request = { id: 1, title: "Dune", year: 2021, poster: null, state: "processing", canCancel: true, libraryId: null, tmdbId: 438631 } as unknown as PlayerRequest;

describe("annuler une demande", () => {
  it("demande confirmation : la croix seule n'annule rien", () => {
    const onCancel = vi.fn();
    render(<PlayerRequestCard request={request} busy={false} onOpen={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByLabelText("player.requests.cancel"));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByText("player.requests.confirmYes"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("« Garder » et Échap referment sans annuler", () => {
    const onCancel = vi.fn();
    render(<PlayerRequestCard request={request} busy={false} onOpen={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByLabelText("player.requests.cancel"));
    fireEvent.click(screen.getByText("player.requests.confirmNo"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByLabelText("player.requests.cancel"));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
