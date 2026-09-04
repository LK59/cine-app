// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));

import { useAddToWatchlist } from "@/lib/useAddToWatchlist";
import type { WatchlistStatus } from "@/lib/db";

const item = { tmdbId: 7, mediaType: "movie" as const, title: "Un Film", year: 2020, posterPath: null, voteAverage: null };

function Harness({ initial = null }: { initial?: WatchlistStatus | null }) {
  const { addedStatus, addToWatchlist, removeFromWatchlist } = useAddToWatchlist(initial);
  return (
    <div>
      <span data-testid="state">{addedStatus ?? "aucun"}</span>
      <button onClick={() => addToWatchlist(item, "to_watch")}>ajouter</button>
      <button onClick={() => removeFromWatchlist({ tmdbId: 7, mediaType: "movie" })}>retirer</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
});

const ok = () => vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
const refuse = (error: string) =>
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error", json: async () => ({ error }) }));

describe("useAddToWatchlist", () => {
  /**
   * En mode cinéma le bouton est une ligne parmi d'autres dans un menu : un changement d'icône
   * y passe inaperçu, d'où la confirmation dite à voix haute.
   */
  it("annonce l'ajout et le retrait, pas seulement l'échec", async () => {
    ok();
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByText("ajouter"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("watchlist.addedToast"));
    expect(screen.getByTestId("state")).toHaveTextContent("to_watch");

    await user.click(screen.getByText("retirer"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("watchlist.removedToast"));
    expect(screen.getByTestId("state")).toHaveTextContent("aucun");
  });

  it("répète ce que le serveur a répondu quand il refuse, et remet l'état d'avant", async () => {
    refuse("Base indisponible");
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByText("ajouter"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Base indisponible"));
    expect(screen.getByTestId("state")).toHaveTextContent("aucun");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("remet le statut d'origine quand c'est le retrait qui est refusé", async () => {
    refuse("Base indisponible");
    const user = userEvent.setup();
    render(<Harness initial="to_watch" />);

    await user.click(screen.getByText("retirer"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.getByTestId("state")).toHaveTextContent("to_watch");
  });
});
