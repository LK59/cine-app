// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
}));
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: toastSuccess, error: toastError }),
}));

import { RequestButton } from "@/components/RequestButton";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toastError.mockClear();
  toastSuccess.mockClear();
});

// The trigger button and the modal's confirm button share the same "common.request" label —
// once the modal is open there are two matches, so scope to the last one (the modal's).
async function clickModalConfirm(user: ReturnType<typeof userEvent.setup>) {
  const buttons = screen.getAllByText("common.request");
  await user.click(buttons[buttons.length - 1]);
}

function renderButton(props: Partial<Parameters<typeof RequestButton>[0]> = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <RequestButton mediaType="movie" tmdbId={1} title="Some Movie" {...props} />
    </SWRConfig>
  );
}

describe("RequestButton", () => {
  it("opens the confirm modal for a movie and does not request anything before confirming", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByText("common.request"));

    expect(await screen.findByText("modals.request.confirmTitle")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flips to 'requested' and disables itself after a successful movie request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByText("common.request"));
    await screen.findByText("modals.request.confirmTitle");
    await clickModalConfirm(user);

    await waitFor(() => expect(screen.getByText("common.requested")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /common.requested/ })).toBeDisabled();
  });

  it("shows an error toast and keeps the request available when the API call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "boom" }) })
    );
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByText("common.request"));
    await screen.findByText("modals.request.confirmTitle");
    await clickModalConfirm(user);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("boom"));
    // Modal stays open on failure (onClose isn't called) — both the trigger and the modal's
    // confirm button still show "common.request", so there are two matches, not one.
    expect(screen.getAllByText("common.request")).toHaveLength(2);
  });

  it("does not toggle the modal open when the underlying card link is clicked (stopPropagation)", async () => {
    const onCardClick = vi.fn();
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <div onClick={onCardClick}>
          <RequestButton mediaType="movie" tmdbId={1} title="Some Movie" />
        </div>
      </SWRConfig>
    );
    const user = userEvent.setup();

    await user.click(screen.getByText("common.request"));

    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("fetches per-season status for a series and preselects the missing ones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 1,
          seasons: [
            { seasonNumber: 1, name: "Saison 1", episodeCount: 10, status: 5 },
            { seasonNumber: 2, name: "Saison 2", episodeCount: 8, status: null },
          ],
        }),
      })
    );
    const user = userEvent.setup();
    renderButton({ mediaType: "series" });

    await user.click(screen.getByText("common.request"));

    expect(await screen.findByText(/Saison 2/)).toBeInTheDocument();
    // Season 1 is already available (status 5) — shown as covered, not a checkbox.
    expect(screen.getByText(/Saison 1/).closest("div")).not.toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });
});
